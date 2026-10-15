"""Durable, per-map worker slots. Leases make interrupted work observable."""
import asyncio
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from functools import wraps
from inspect import signature
from uuid import uuid4

_current = ContextVar('agent_jobs', default=())
progress_sink = ContextVar('agent_progress_sink', default=None)
ACTIVE = {'queued', 'running'}


def current_job_id():
    task = asyncio.current_task()
    return next((job for _, _, owner, job in reversed(_current.get()) if owner is task), None)


def tracked(role, source, from_role=None):
    def decorate(fn):
        sig = signature(fn)
        @wraps(fn)
        async def wrapped(self, *args, **kwargs):
            jobs = getattr(self, 'jobs', None)
            if jobs is None:
                return await fn(self, *args, **kwargs)
            bound = sig.bind(self, *args, **kwargs)
            values = list(bound.arguments.values())
            session, node = values[1], values[2] if len(values) > 2 else None
            sid = session if isinstance(session, str) else session.session_id
            cid = node if isinstance(node, str) else getattr(node, 'concept_id', None)
            async with jobs.track(sid, role, cid, source, from_role=from_role):
                return await fn(self, *args, **kwargs)
        return wrapped
    return decorate


class AgentJobs:
    lease_seconds = 60
    heartbeat_seconds = 15

    def __init__(self, repo, capacities):
        self.repo, self.capacities = repo, capacities
        self.owners = {}

    @staticmethod
    def remember_question(state, job):
        if job['source'] == 'question_generation' and job['concept_id']:
            state.setdefault('question_states', {})[job['concept_id']] = dict(job)

    def _expire(self, state):
        now = time.time()
        for job in state.get('jobs', []):
            if job['status'] in ACTIVE and job['lease_until'] < now:
                job.update(status='failed', error='処理との接続が途切れました。状態を確認して再試行してください。',
                           updated_at=now, retryable=True)
                self.remember_question(state, job)

    def snapshot(self, sid):
        state = self.repo.get_agent_runtime(sid)
        if any(j['status'] in ACTIVE and j['lease_until'] < time.time() for j in state.get('jobs', [])):
            state = self.repo.mutate_agent_runtime(sid, self._expire)
        jobs = state.get('jobs', [])
        counts = {role: {'capacity': cap,
                         'running': sum(j['role'] == role and j['status'] == 'running' for j in jobs),
                         'queued': sum(j['role'] == role and j['status'] == 'queued' for j in jobs)}
                  for role, cap in self.capacities.items()}
        for value in counts.values():
            value['idle'] = max(0, value['capacity'] - value['running'])
        return {'scope': 'session', 'revision': state.get('revision', 0), 'counts': counts,
                'handoffs': state.get('handoffs', []),
                'question_states': state.get('question_states', {}),
                'jobs': [{k: v for k, v in job.items() if k != 'lease_until'} for job in jobs]}

    def _change(self, sid, jid, change):
        def mutate(state):
            self._expire(state)
            job = next((j for j in state.get('jobs', []) if j['job_id'] == jid), None)
            if job and job['status'] in ACTIVE:
                change(job, state)
                job['updated_at'] = time.time()
                self.remember_question(state, job)
        return self.repo.mutate_agent_runtime(sid, mutate)

    def cancel_nodes(self, sid, ids):
        def cancel(state):
            for job in state.get('jobs', []):
                if job['concept_id'] in ids and job['status'] in ACTIVE:
                    job.update(status='cancelled', updated_at=time.time(), retryable=False)
            for cid in ids:
                state.get('question_states', {}).pop(cid, None)
        self.repo.mutate_agent_runtime(sid, cancel)
        for (job_sid, cid, _), owner in list(self.owners.items()):
            if job_sid == sid and cid in ids and owner is not asyncio.current_task():
                owner.cancel()

    def fail_current(self, sid):
        self._change(sid, current_job_id(), lambda j, _: j.update(status='failed', retryable=True,
            failure_kind='handled', error='下位項目の準備に失敗しました。展開から再試行できます。'))

    def handoff(self, sid, sender, receiver, cid, source):
        """Record an explicit instruction, including reuse of already prepared work."""
        event = dict(event_id=uuid4().hex, from_role=sender, to_role=receiver,
                     from_job_id=None, to_job_id=None, concept_id=cid,
                     source=source, kind='request', created_at=time.time())
        def record(state):
            state['handoffs'] = [*state.get('handoffs', []), event][-64:]
        self.repo.mutate_agent_runtime(sid, record)

    @asynccontextmanager
    async def track(self, sid, role, cid, source, priority=0, from_role=None):
        owner = asyncio.current_task()
        inherited = _current.get()
        parent = next(((r, j) for s, r, task, j in reversed(inherited)
                       if s == sid and task is owner and r != role), None)
        sender = from_role or (parent[0] if parent else None)
        existing = next((j for s, r, task, j in inherited if s == sid and r == role and task is owner), None)
        if existing:
            yield existing
            return
        now, jid = time.time(), uuid4().hex
        job = dict(job_id=jid, session_id=sid, role=role, concept_id=cid, source=source,
                   status='queued', created_at=now, updated_at=now, lease_until=now+self.lease_seconds,
                   error=None, retryable=False, priority=priority)
        def enqueue(state):
            self._expire(state)
            active = [j for j in state.get('jobs', []) if j['status'] in ACTIVE]
            history = [j for j in state.get('jobs', []) if j['status'] not in ACTIVE][-127:]
            state['jobs'] = history + active + [job]
            self.remember_question(state, job)
        self.repo.mutate_agent_runtime(sid, enqueue)
        self.owners[(sid, cid, jid)] = owner
        token = _current.set((*inherited, (sid, role, owner, jid)))

        async def heartbeat():
            while True:
                await asyncio.sleep(self.heartbeat_seconds)
                state = self._change(sid, jid, lambda j, _: j.update(lease_until=time.time()+self.lease_seconds))
                record = next((j for j in state['jobs'] if j['job_id'] == jid), None)
                if not record or record['status'] not in ACTIVE:
                    owner.cancel()
                    return
        pulse = asyncio.create_task(heartbeat())
        try:
            while True:
                # Waiting must not write the shared Firestore document ten times
                # a second. Read first; acquisition still rechecks atomically.
                state = self.repo.get_agent_runtime(sid)
                record = next((j for j in state['jobs'] if j['job_id'] == jid), None)
                if record is None or record['status'] not in ACTIVE:
                    raise asyncio.CancelledError()
                active = [j for j in state['jobs'] if j['role'] == role and j['status'] in ACTIVE]
                occupied = sum(j['status'] == 'running' for j in active)
                earlier = any(j['status'] == 'queued' and
                    (-j.get('priority', 0), j['created_at']) < (-priority, now) for j in active)
                expired = any(j['lease_until'] < time.time() for j in active)
                if not expired and (occupied >= self.capacities[role] or earlier):
                    await asyncio.sleep(.25)
                    continue
                def acquire(record, state):
                    running = sum(j['role'] == role and j['status'] == 'running' for j in state['jobs'])
                    preceding = any(j['role'] == role and j['status'] == 'queued' and
                        (-j.get('priority', 0), j['created_at']) < (-priority, now) for j in state['jobs'])
                    if running < self.capacities[role] and not preceding:
                        record['status'] = 'running'
                        if sender and sender != role:
                            source_job = next((j for j in state['jobs'] if parent and j['job_id'] == parent[1]), None)
                            events = state.setdefault('handoffs', [])
                            events.append(dict(event_id=jid+':request', from_role=sender, to_role=role,
                                from_job_id=source_job['job_id'] if source_job else None, to_job_id=jid,
                                concept_id=cid, source=source, kind='request', created_at=time.time()))
                            state['handoffs'] = events[-64:]
                state = self._change(sid, jid, acquire)
                record = next(j for j in state['jobs'] if j['job_id'] == jid)
                if record['status'] not in ACTIVE:
                    raise asyncio.CancelledError()
                if record['status'] == 'running':
                    break
                await asyncio.sleep(.1)
            # A task queued before deletion must not regenerate the removed branch.
            try:
                current = self.repo.get(sid)
            except KeyError:
                current = None  # Initial generation precedes creation of its session.
            if current and cid in current.deleted_concept_ids:
                raise asyncio.CancelledError()
            yield jid
            if cid and current is not None:
                current = self.repo.get(sid)
                if cid in current.deleted_concept_ids:
                    raise asyncio.CancelledError()
        except asyncio.CancelledError:
            self._change(sid, jid, lambda j, _: j.update(status='cancelled', retryable=True))
            raise
        except Exception:
            self._change(sid, jid, lambda j, _: j.update(status='failed', retryable=True,
                error='処理に失敗しました。同じ項目から再試行できます。'))
            raise
        else:
            def complete(j, state):
                j.update(status='complete')
                if parent:
                    events = state.setdefault('handoffs', [])
                    events.append(dict(event_id=jid+':result', from_role=role, to_role=parent[0],
                        from_job_id=jid, to_job_id=parent[1], concept_id=cid,
                        source=source, kind='result', created_at=time.time()))
                    state['handoffs'] = events[-64:]
            state = self._change(sid, jid, complete)
            record = next(j for j in state['jobs'] if j['job_id'] == jid)
            if record['status'] != 'complete' and record.get('failure_kind') != 'handled':
                raise asyncio.CancelledError()
        finally:
            pulse.cancel()
            await asyncio.gather(pulse, return_exceptions=True)
            _current.reset(token)
            self.owners.pop((sid, cid, jid), None)
