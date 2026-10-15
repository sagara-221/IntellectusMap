# ==============================================================================
# JSON Schema 簡素化ユーティリティ
# 用途: Vertex AI / Gemini API の decoding-state 制約を回避するため、
#       メタデータ（minItems/maxLength/title等）を除去した軽量スキーマを生成。
#       厳密な値の検証はローカルのPydanticモデル復元時に実施する。
# ==============================================================================
from copy import deepcopy

# Vertex AI のステート上限を超えないようAPI送信時に除去するフィールド一覧
LOCAL_ONLY = {
    'title', 'description', 'default', 'minItems', 'maxItems', 'minLength', 'maxLength',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format',
    # Vertex response_schema is an OpenAPI subset, not arbitrary JSON Schema.
    # extra='forbid' remains enforced by the original Pydantic model locally.
    'additionalProperties',
}
# Bounding all nested object arrays exceeds the model's decoding-state budget.
# Keep the small candidate-name array bounded; validate other limits locally.


def generation_schema(schema: dict) -> dict:
    """Pydanticのmodel_json_schemaからAPI制約に引っかかるメタデータを除去。
    
    プロパティ名自体（例: "description" という名前のキー）は維持しつつ、
    スキーマ検証メタデータのみを再帰的にフィルタリングする。
    """
    def visit(value, property_name=None):
        if isinstance(value, list):
            return [visit(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, child in value.items():
            if key in LOCAL_ONLY and not (key == 'maxItems' and property_name == 'child_candidates'):
                continue
            if key in ('properties', '$defs', 'definitions'):
                # "description" などのフィールド名がLOCAL_ONLYに含まれても除去しないよう保持
                result[key] = {name: visit(definition, name) for name, definition in child.items()}
            else:
                result[key] = visit(child)
        return result
    return visit(deepcopy(schema))

