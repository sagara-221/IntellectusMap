"""Deterministic, explicitly limited fixture provider. Does not pretend to be an LLM."""
from app.models.domain import *
from app.agents.answer_evaluation import normalize

TOPICS = [
    ('meaning', '微分の基本概念', '微分係数と接線の傾きの関係を説明できる', 'factual'),
    ('power', '基本公式', 'べき関数の微分を計算できる', 'calculation'),
    ('product', '積の微分', '積の微分公式を適用できる', 'procedural'),
    ('quotient', '商の微分', '商の微分公式を適用できる', 'calculation'),
    ('chain', '合成関数の微分', '内側の微分を含めて合成関数を微分できる', 'calculation'),
]


def concept(key, name, description, kind, narrow=False):
    return ConceptSpec(concept_id=key, concept_name=name, description=description,
        knowledge_type=kind, granularity='narrow' if narrow else 'medium',
        assessment_targets=[Target(target_id='apply', description=description, knowledge_type=kind)],
        child_candidates=[Candidate(concept_name='前提の識別', description='必要な関数や公式を識別する'), Candidate(concept_name='公式の適用', description='式に適用する')])


class DemoLLMService:
    async def stream_text(self, agent, payload, temperature):
        import asyncio
        text = '取り組んだことや考えを、自由に話してください。話してくれた内容を一緒に整理していきましょう。'
        if payload.messages and payload.messages[-1].content.startswith('デモ:'):
            text = '式の扱いと手順の選び方についての話ですね。経験と迷っている部分を分けて考えると整理しやすくなります。'
        for offset in range(0, len(text), 12):
            await asyncio.sleep(.01)
            yield text[offset:offset+12]

    async def generate(self, agent, payload, schema, temperature):
        if agent == 'chat_extract':
            from app.models.chat import ChatExtraction, ExperienceUnit, Citation
            if not payload.text.startswith('デモ:'):
                return ChatExtraction()
            return ChatExtraction(units=[ExperienceUnit(topic='基本公式', statement=payload.text,
                kind='gap' if '分からない' in payload.text else 'explanation',
                citations=[Citation(message_id=payload.message_id, quote=payload.text[:1500])])])
        if agent == 'chat_assessment':
            from app.models.chat import ChatAssessment, ChatJudgment
            units = payload.experience_units
            judgments = []
            if units and payload.concepts:
                latest_id = payload.messages[-1].message_id
                unit = next((item for item in reversed(units) if item.turn_id == latest_id), units[-1])
                for item in payload.concepts:
                    if item['concept_id'].startswith('power'):
                        low = unit.kind == 'gap'
                        judgments.append(ChatJudgment(concept_id=item['concept_id'], target_id=item['assessment_targets'][0]['target_id'],
                            score=.2 if low else .9, confidence=.8, kind='gap' if low else 'demonstrated',
                            citations=unit.citations, reason='明示的なデモ入力による固定判定です。'))
            return ChatAssessment(judgments=judgments, focus_concept_id='power',
                conversation_guidance='ユーザーの話題を中心に、経験と困りごとを整理する。')
        if agent == 'chat_structure':
            from app.models.chat import ChatStructurePlan, ChatUnitLink
            chosen = next((item for item in payload.concepts if item['concept_id']=='power'), None)
            return ChatStructurePlan(links=[ChatUnitLink(unit_id=unit.unit_id, concept_id='power', reason='デモの説明を対応づける')
                for unit in payload.experience_units] if chosen else [])
        if agent == 'chat_structure_review':
            from app.models.chat import ChatPlanReview
            return ChatPlanReview(approved_expansions=payload.proposed_plan.expand_concept_ids,
                                  approved_additions=list(range(len(payload.proposed_plan.additions))))
        if agent == 'divergence':
            from app.models.maps import DivergenceCandidateDraft, DivergenceOutput
            themes = [('統計的推論', '理論・学問'), ('システム設計', '設計'),
                      ('人間中心設計', '人間・心理'), ('測定と評価', '評価・測定'),
                      ('意思決定', 'ビジネス'), ('組織学習', '組織'),
                      ('リスク管理', '運用'), ('倫理と社会', '社会・倫理'),
                      ('情報の可視化', 'コミュニケーション'), ('計算理論', '理論・学問'),
                      ('信頼性工学', 'システム'), ('実験計画', '評価・測定'),
                      ('データガバナンス', '運用'), ('認知科学', '人間・心理'),
                      ('最適化理論', '理論・学問')]
            from app.agents.divergence import normalized_divergence_name
            excluded = {normalized_divergence_name(name) for name in
                        [*payload.concept_path, *payload.existing_map_themes,
                         *(item.name for item in payload.previous_candidates)]}
            available = [(name, category) for name, category in themes
                         if normalized_divergence_name(name) not in excluded]
            index = 1
            while len(available) < payload.candidate_count:
                name = f'周辺領域{index}'
                if normalized_divergence_name(name) not in excluded:
                    available.append((name, '別の観点'))
                index += 1
            return DivergenceOutput(theme=payload.selected_concept.concept_name,
                divergent_nodes=[DivergenceCandidateDraft(name=name, category=category,
                    relation=f'{payload.selected_concept.concept_name}を別の知識体系から検討するために関連する',
                    reason=f'{name}の考え方を使い、{payload.selected_concept.concept_name}の判断を広げる')
                    for name, category in available[:payload.candidate_count]])
        if agent == 'concept_relation':
            from app.agents.concept_addition import normalized_name
            names = {normalized_name(payload.existing.concept_name), normalized_name(payload.incoming.concept_name)}
            same = names == {'連鎖律', 'チェーンルール'} or names == {'教師あり学習', 'supervisedlearning'}
            return ConceptRelationJudgeResult(relation='same' if same else 'different', confidence=.95,
                reason='デモで明示した同義語です。' if same else 'デモでは証拠を共有できると確認できません。', evidence_shareable=same)
        if agent == 'concept_canonical':
            source = payload.existing
            return CanonicalConcept(name=source.concept_name,
                aliases=[payload.incoming.concept_name], description=source.description,
                targets=[CanonicalTarget(description=t.description, knowledge_type=t.knowledge_type,
                    importance=t.importance, source_target_ids=[f'existing:{t.target_id}'] +
                    ([f'incoming:{payload.incoming.assessment_targets[0].target_id}'] if index == 0 else []))
                    for index, t in enumerate(source.assessment_targets)])
        if agent == 'addition':
            kind = payload.parent_concept.knowledge_type
            description = payload.note or f'{payload.concept_name}について説明できる'
            return ConceptSpec(concept_id=payload.concept_id, concept_name=payload.concept_name,
                description=description, knowledge_type=kind,
                granularity='medium',
                assessment_targets=[Target(target_id='explain', description=f'{payload.concept_name}の内容を説明できる', knowledge_type=kind)],
                child_candidates=[Candidate(concept_name='基礎', description='基礎となる知識を確認する')])
        if agent == 'decomposition':
            if payload.purpose == 'initial_decomposition':
                if not payload.is_divergent_map:
                    root = concept('derivative', '微分', '変化率を求める能力を診断する', 'conceptual')
                    nodes = [concept(*entry) for entry in TOPICS]
                else:
                    root = concept(uid('root'), payload.theme, f'{payload.theme}について説明できる', 'conceptual')
                    nodes = [concept(uid('topic'), name, f'{payload.theme}における{name}を説明できる', 'conceptual')
                             for name in ('基礎概念', '主要な方法', '評価と判断', '適用場面', '限界と課題')]
            else:
                root = concept(payload.parent_concept_id, payload.theme, '弱点を詳しく確認する', 'conceptual')
                nodes = [concept(payload.parent_concept_id + '_identify', '必要な関数・公式の識別', '適用する関数や公式を識別できる', 'factual', True),
                         concept(payload.parent_concept_id + '_apply', '微分公式の適用', '必要な微分を省略せず計算できる', 'calculation', True)]
                if payload.current_depth == 1:
                    for node in nodes:
                        node.child_candidates = [Candidate(concept_name='公式を選ぶ', description='必要な公式を識別する'), Candidate(concept_name='計算を実行する', description='係数と指数を計算する')]
                elif payload.current_depth == 2:
                    nodes = [concept(payload.parent_concept_id + '_formula', '公式の選択', '微分に必要な公式を識別できる', 'factual', True),
                             concept(payload.parent_concept_id + '_coefficient', '係数と指数の計算', 'べき関数の係数と指数を計算できる', 'calculation', True)]
            return Decomposition(root_concept=root, child_nodes=nodes, decomposition_summary='微分の診断用デモ教材です。',
                                 suggested_initial_depth=2 if payload.purpose == 'initial_decomposition' else None)
        if agent == 'question':
            return self.question(payload)
        q = payload.question
        if normalize(payload.user_answer) in [normalize(a) for a in q.expected_answer]:
            return Evaluation(correctness='correct', score=1, evaluation_confidence=.95, demonstrated_knowledge=[q.answer_explanation])
        if normalize(payload.user_answer) in ('わからない', '分からない', '不明', '知らない'):
            return Evaluation(correctness='incorrect', score=0, evaluation_confidence=.95, missing_knowledge=[q.answer_explanation], needs_additional_assessment=True)
        return Evaluation(correctness='ungradable', score=0, evaluation_confidence=0,
            missing_knowledge=['デモの自由記述採点は登録済みの回答のみ対応しています。意味評価はGeminiモードで検証してください。'], needs_additional_assessment=True)

    def question(self, payload):
        key = payload.concept.concept_id
        index = len(payload.previous_question_summaries)
        n = index + 2
        fmt = payload.request.question_type
        if key.startswith('user_'):
            text, answer, wrong, explanation = (
                f'追加した項目「{payload.concept.concept_name}」で確認したい内容は何ですか？',
                payload.concept.description, 'この項目は診断範囲に含まれない',
                f'このデモでは「{payload.concept.concept_name}」の確認内容として登録した説明を使用します。')
        elif key.startswith('meaning'):
            variants = [
                ('微分係数は、グラフ上のその点での何を表しますか？', '接線の傾き', '面積', '接線の傾きは瞬間の変化率です。'),
                ('平均変化率で2点の間隔を0に近づけると、何が得られますか？', '微分係数', '積分定数', '平均変化率の極限が微分係数です。'),
                ('微分係数が正のとき、その点の接線の傾きはどうなりますか？', '正', '負', '微分係数の符号は接線の傾きの符号です。'),
                ('曲線のある点での瞬間の変化率を何と呼びますか？', '微分係数', '面積', '瞬間の変化率が微分係数です。'),
                ('f(x)=5の微分係数はいくつですか？', '0', '5', '定数関数の変化率は0です。'),
                ('f(x)=xの接線の傾きはいくつですか？', '1', '0', 'xの係数1が接線の傾きです。'),
                ('微分係数が0のとき、接線はどの方向ですか？', '水平', '垂直', '傾き0の直線は水平です。'),
            ]
            if index < len(variants):
                text, answer, wrong, explanation = variants[index]
            else:
                slope = index + 1
                text = f'直線 f(x)={slope}x+{slope+2} の瞬間の変化率はいくつですか？'
                answer, wrong = str(slope), str(slope+2)
                explanation = f'直線の瞬間の変化率は傾きと等しく、この場合は{slope}です。'
        elif key.endswith(('_identify', '_formula')):
            if key.startswith('chain'):
                text, answer, wrong, explanation = (f'(x^{n}+1)^3 の内側の関数は？', f'x^{n}+1', 'x^3', '外側は3乗、内側は括弧の中の関数です。')
            else:
                text, answer, wrong, explanation = (f'x^{n} を微分するときに使う公式は？', 'べき関数の微分', '商の微分', 'xの累乗には、指数を前に掛けて指数を1減らす公式を使います。')
        elif key.startswith('power'):
            text, answer, wrong, explanation = (f'f(x)=x^{n} を微分してください。', f'{n}x^{n-1}', f'x^{n-1}', '指数を係数にして、指数を1減らします。')
        elif key.startswith('product'):
            text, answer, wrong, explanation = (f'f(x)=x^{n}(x+1) に積の微分公式を適用した式は？', f'{n}x^{n-1}(x+1)+x^{n}', f'{n}x^{n-1}', '(uv)′=u′v+uv′。両方の項が必要です。')
        elif key.startswith('quotient'):
            text, answer, wrong, explanation = (f'x≠0 とします。f(x)=x^{n+1}/x の導関数は？', f'{n}x^{n-1}', f'{n+1}x^{n}', '商の公式でも、先にxで約分してから微分しても同じ結果になります。')
        else:
            text, answer, wrong, explanation = (f'f(x)=(x^{n}+1)^2 を微分してください。', f'{2*n}x^{n-1}(x^{n}+1)', f'2(x^{n}+1)', '外側の微分2(x^n+1)に、内側の微分nx^(n−1)を掛けます。')
        choices = None
        accepted = [answer, answer.replace('x^1', 'x')]
        grading = 'exact_match'
        mapping = [DiagnosticMapping(answer=wrong, misconception=explanation)]
        if fmt == 'multiple_choice':
            # Rotate the answer position so the fixture cannot be solved with a fixed option.
            distractor = '0（常に変化しない）'
            if '0' in (normalize(answer), normalize(wrong)):
                value = next(str(i) for i in (1, 2, 3) if str(i) not in (normalize(answer), normalize(wrong)))
                distractor = f'{value}（変化率）'
            values = [answer, wrong, '項目名だけを暗記する', '別の項目に置き換える'] if key.startswith('user_') else [answer, wrong, distractor, '微分できない']
            values = values[index % 4:] + values[:index % 4]
            choices = [Choice(choice_id=chr(65+i), text=v) for i, v in enumerate(values)]
            accepted = [next(c.choice_id for c in choices if c.text == answer)]
            mapping = [DiagnosticMapping(answer=c.choice_id, misconception=explanation) for c in choices if c.choice_id != accepted[0]]
            grading = 'choice_match'
        elif fmt == 'yes_no':
            is_true = (index // 2) % 2 == 1
            text = f'「{text}」への答えを「{answer if is_true else wrong}」とするのは正しいですか？'
            choices = [Choice(choice_id='yes', text='はい'), Choice(choice_id='no', text='いいえ')]
            accepted = ['yes' if is_true else 'no']
        elif fmt in ('short_explanation', 'free_response'):
            grading = 'semantic_evaluation'
        return QuestionContent(question_type=fmt, question_text=text, choices=choices, expected_answer=accepted,
            answer_explanation=explanation, grading_type=grading, diagnostic_mapping=mapping)
