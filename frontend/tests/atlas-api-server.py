"""Loopback E2E server. Isolated SQLite and demo provider; no billable LLM calls."""
import os
import sys
import logging
from pathlib import Path
from uuid import uuid4

if os.name == 'nt' and not sys.flags.utf8_mode:
    raise SystemExit('Run this test server with python -X utf8 (prompt files are UTF-8).')

root = Path(__file__).resolve().parents[2]
test_dir = root / '.tools' / 'atlas-tests'
test_dir.mkdir(parents=True, exist_ok=True)
database = 'sqlite:///' + (test_dir / (uuid4().hex + '.sqlite')).as_posix()
os.environ.update(DATABASE_BACKEND='sqlite', DATABASE_URL=database,
                  GEMINI_BACKEND='adk', GOOGLE_CLOUD_PROJECT='atlas-e2e', GEMINI_MODEL='test-model')
sys.path.insert(0, str(root / 'backend'))

import uvicorn
from app.main import create_app
from app.auth import get_current_user
from app.config import Settings
from app.llm.demo import DemoLLMService
from app.repositories.sessions import SessionRepository
from sqlalchemy import event

# Separate connections are required for FastAPI's sync reader threads.
# WAL avoids fsync contention between polling and background jobs in this disposable DB.
repository = SessionRepository(database)
@event.listens_for(repository.engine, 'connect')
def configure_test_sqlite(connection, _):
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA synchronous=NORMAL')
repository.engine.dispose()

app = create_app(Settings(_env_file=None, database_backend='sqlite', database_url=database,
                          gemini_backend='adk', google_cloud_project='atlas-e2e', gemini_model='test-model'),
                 repository, {'demo': DemoLLMService()})
app.dependency_overrides[get_current_user] = lambda: 'atlas-e2e-user'
logging.getLogger().setLevel(logging.WARNING)

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=18080, log_level='warning', timeout_graceful_shutdown=2)
