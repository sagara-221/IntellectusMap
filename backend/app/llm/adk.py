# ==============================================================================
# Google ADK (Agent Development Kit) 連携サービス
# 用途: google.adk.agents.Agent および InMemoryRunner によるエージェント自律実行基盤
# ==============================================================================
import json
import logging
import os
from pathlib import Path
import re
import time
from typing import TypeVar
from pydantic import BaseModel, ValidationError
from google.adk.agents import Agent
from google.adk.models import Gemini
from google.adk.runners import InMemoryRunner
from google.genai import types
from app.config import Settings
from app.llm.base import LLMError
from app.llm.schema import generation_schema
from app.llm.telemetry import context, record_token_usage

logger = logging.getLogger(__name__)

T = TypeVar('T', bound=BaseModel)


def extract_json_block(text: str) -> str:
    """Markdownコードフェンスまたはテキスト中からJSON文字列を抽出。"""
    text = text.strip()
    match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', text)
    if match:
        return match.group(1).strip()
    # テキスト中の最初と最後の波括弧を探す
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        return text[start:end+1]
    return text


class ADKAgentService:
    """Google ADKを活用したエージェント実行基盤サービス。
    
    各エージェント（知識分解、出題、採点、発散等）の定義・指示をADK Agentとして構成し、
    InMemoryRunnerを介して高速かつ構造化されたPydantic出力を生成する。
    """
    def __init__(self, settings: Settings, runner_factory=None):
        self.settings = settings
        self.runner_factory = runner_factory
        self._configure_env()

    def _configure_env(self):
        """Vertex AI / Gemini APIの実行環境変数を設定。"""
        if self.settings.gemini_backend == 'agent_platform':
            # Express mode uses an explicit API-key client, independently of ADC.
            return
        if self.settings.gemini_api_key:
            os.environ['GEMINI_API_KEY'] = self.settings.gemini_api_key
        try:
            path, proj = self.settings.vertex_configuration()
            os.environ['GOOGLE_GENAI_USE_VERTEXAI'] = 'True'
            os.environ['GOOGLE_CLOUD_PROJECT'] = proj
            os.environ['GOOGLE_CLOUD_LOCATION'] = self.settings.google_cloud_location
            if path:
                os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = str(path)
        except Exception as e:
            logger.debug('Vertex AI credentials not loaded: %s', e)

    def _model(self, model_name: str):
        if self.settings.gemini_backend == 'agent_platform':
            return Gemini(model=model_name, client_kwargs={
                'vertexai': True,
                'api_key': self.settings.gemini_api_key,
            })
        return model_name

    async def generate(self, agent_name: str, system_instruction: str, prompt_text: str, schema: type[T], temperature: float = 0.2) -> T:
        """ADK AgentおよびRunnerを用いてタスクを実行し、スキーマ準拠モデルを返却。"""
        self._configure_env()
        model_name = self.settings.gemini_model or 'gemini-3.5-flash-lite'
        started = time.monotonic()

        # Gemini 3.5 Flash-Lite uses thinking levels; the default latency setting
        # should not send the legacy thinking_budget parameter.
        budget = getattr(self.settings, 'gemini_thinking_budget', 0)
        thinking_config = (types.ThinkingConfig(thinking_level='minimal')
                           if model_name == 'gemini-3.5-flash-lite' and budget == 0
                           else types.ThinkingConfig(thinking_budget=budget) if budget >= 0 else None)
        gen_config = types.GenerateContentConfig(
            temperature=None if model_name == 'gemini-3.5-flash-lite' else temperature,
            response_mime_type='application/json',
            thinking_config=thinking_config,
        )

        instruction = (
            f'{system_instruction}\n\n'
            '【重要: 出力形式】\n'
            '回答の最終結果は、必ず要求されたスキーマに厳密に準拠した有効なJSON形式のみを出力してください。\n'
        )

        adk_output_schema = generation_schema(schema.model_json_schema()) if hasattr(schema, 'model_json_schema') else schema

        agent = Agent(
            name=f'{agent_name}_adk_agent',
            model=self._model(model_name),
            instruction=instruction,
            output_schema=adk_output_schema,
            generate_content_config=gen_config,
        )

        current_prompt = prompt_text
        last_error = None

        for attempt in range(2):
            runner = self.runner_factory(agent) if self.runner_factory else InMemoryRunner(agent=agent, app_name='knowledge_gap_mapper')
            session = await runner.session_service.create_session(
                app_name='knowledge_gap_mapper',
                user_id='system_agent',
            )

            content = types.Content(role='user', parts=[types.Part(text=current_prompt)])
            collected_texts: list[str] = []

            try:
                events = runner.run_async(
                    session_id=session.id,
                    user_id='system_agent',
                    new_message=content,
                )

                async for event in events:
                    if hasattr(event, 'content') and event.content:
                        for part in event.content.parts:
                            if hasattr(part, 'text') and part.text:
                                collected_texts.append(part.text)
            except Exception as exc:
                logger.error('ADK execution error in agent=%s: %s', agent_name, exc)
                raise LLMError(f'ADKエージェントの実行に失敗しました: {exc}') from exc

            full_output = ''.join(collected_texts).strip()
            if not full_output:
                raise LLMError(f'ADKエージェント「{agent_name}」の応答が空でした。')

            clean_json = extract_json_block(full_output)
            try:
                result = schema.model_validate_json(clean_json)
                latency_ms = round((time.monotonic() - started) * 1000)
                prompt_tokens = max(1, len(current_prompt) // 3)
                candidate_tokens = max(1, len(full_output) // 3)
                record_token_usage(agent_name, prompt_tokens, candidate_tokens, latency_ms)
                logger.info(json.dumps({
                    **context.get(),
                    'agent_name': agent_name,
                    'model_name': model_name,
                    'backend': 'adk_runner',
                    'latency_ms': latency_ms,
                    'validation_result': 'ok'
                }, ensure_ascii=False))
                return result
            except ValidationError as exc:
                last_error = exc
                logger.warning('ADK schema validation failed (attempt=%d) in agent=%s: %s', attempt + 1, agent_name, exc)
                if attempt == 0:
                    errors_summary = exc.errors(include_input=False, include_url=False)
                    current_prompt = (
                        f'{prompt_text}\n\n'
                        '前回のJSONを下記の検証エラーに従って修正し、修正済みのJSON全体を返してください。'
                        '配列の件数超過は、重複する候補をまとめて指定上限以内にしてください。'
                        '概念IDと観点の対応関係は整合させてください。\n'
                        f'検証エラー: {errors_summary}\n'
                        f'前回のJSON（修正対象のデータ）:\n{clean_json}'
                    )

        raise LLMError(f'AIの出力形式を検証できませんでした。再試行してください。エラー: {last_error}')

    async def stream_text(self, agent_name: str, system_instruction: str, prompt_text: str, temperature: float = 0.2):
        """ADK AgentおよびRunnerを用いてテキストをリアルタイムストリーミング。"""
        self._configure_env()
        model_name = self.settings.gemini_model or 'gemini-3.5-flash-lite'
        started = time.monotonic()

        gen_config = types.GenerateContentConfig(
            temperature=None if model_name == 'gemini-3.5-flash-lite' else temperature,
            max_output_tokens=self.settings.chat_max_output_tokens,
        )

        agent = Agent(
            name=f'{agent_name}_adk_agent',
            model=self._model(model_name),
            instruction=system_instruction,
            generate_content_config=gen_config,
        )

        runner = self.runner_factory(agent) if self.runner_factory else InMemoryRunner(agent=agent, app_name='knowledge_gap_mapper')
        session = await runner.session_service.create_session(
            app_name='knowledge_gap_mapper',
            user_id='system_agent',
        )

        content = types.Content(role='user', parts=[types.Part(text=prompt_text)])
        emitted = False
        collected_texts: list[str] = []

        try:
            events = runner.run_async(
                session_id=session.id,
                user_id='system_agent',
                new_message=content,
            )

            async for event in events:
                if hasattr(event, 'content') and event.content:
                    for part in event.content.parts:
                        if getattr(part, 'thought', False):
                            continue
                        if hasattr(part, 'text') and part.text:
                            if not emitted:
                                logger.info('agent=%s first_text_ms=%d', agent_name, round((time.monotonic() - started) * 1000))
                            emitted = True
                            collected_texts.append(part.text)
                            yield part.text
        except Exception as exc:
            if emitted:
                logger.warning('ADK streaming interrupted for agent=%s: %s', agent_name, exc)
                raise LLMError('返答の通信が中断されました。同じ発言を再送できます。') from exc
            logger.error('ADK streaming error in agent=%s: %s', agent_name, exc)
            raise LLMError(f'ADKエージェントの実行に失敗しました: {exc}') from exc

        if not emitted:
            raise LLMError('返答を生成できませんでした。入力を調整して再送できます。')

        latency_ms = round((time.monotonic() - started) * 1000)
        logger.info(json.dumps({
            **context.get(),
            'agent_name': agent_name,
            'model_name': model_name,
            'backend': 'adk_runner',
            'latency_ms': latency_ms,
            'streaming': True,
        }, ensure_ascii=False))


PROMPTS = Path(__file__).resolve().parents[1] / 'prompts'


class ADKLLMService:
    """Google ADK (Agent Development Kit) を用いたLLMサービス（LLMService Protocol準拠）。"""
    requires_coverage_plan = True

    def __init__(self, settings: Settings, transport=None, auth=None, adk_service=None, runner_factory=None):
        self.settings = settings
        self.transport = transport
        self.auth = auth
        self.adk_service = adk_service or ADKAgentService(settings, runner_factory=runner_factory)

    async def stream_text(self, agent: str, payload: BaseModel, temperature: float = 0.2):
        """ADK Agentを用いたテキストストリーミング。"""
        if not self.settings.gemini_ready:
            raise LLMError(self.settings.gemini_configuration_error)
        prompt_file = PROMPTS / f'{agent}.txt'
        if not prompt_file.exists():
            raise LLMError(f'エージェント用プロンプトファイルが見つかりません: {agent}')
        system = prompt_file.read_text(encoding='utf-8')
        prompt = payload.model_dump_json()

        async for chunk in self.adk_service.stream_text(
            agent_name=agent,
            system_instruction=system,
            prompt_text=prompt,
            temperature=temperature,
        ):
            yield chunk

    async def generate(self, agent: str, payload: BaseModel, schema: type[T], temperature: float = 0.2) -> T:
        """指定エージェントのプロンプトと入力データをもとに、ADK経由でスキーマ準拠のJSONを生成。"""
        if not self.settings.gemini_ready:
            raise LLMError(self.settings.gemini_configuration_error)

        prompt_file = PROMPTS / f'{agent}.txt'
        if not prompt_file.exists():
            raise LLMError(f'エージェント用プロンプトファイルが見つかりません: {agent}')

        system = prompt_file.read_text(encoding='utf-8')
        prompt = payload.model_dump_json()

        return await self.adk_service.generate(
            agent_name=agent,
            system_instruction=system,
            prompt_text=prompt,
            schema=schema,
            temperature=temperature,
        )


GeminiLLMService = ADKLLMService
