// ==============================================================================
// エージェント実行ステータスバッジ コンポーネント (AgentStatusBadge)
// 用途: SSEストリームから受信した進捗（各エージェントの現在動作・対象ノード・メッセージ）を
//       リアルタイムにアニメーション付きバッジとして画面上部に表示
// ==============================================================================
import React from 'react';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { AgentProgress, AGENT_CONFIGS, DEFAULT_AGENT_CONFIG } from './api';

interface AgentStatusBadgeProps {
  progress: AgentProgress | null;
  className?: string;
}

/**
 * AIエージェントの現在の活動（分解、出題、採点、展開等）を可視化するステータスバッジ
 */
export const AgentStatusBadge: React.FC<AgentStatusBadgeProps> = ({ progress, className = '' }) => {

  if (!progress) return null;

  const info = AGENT_CONFIGS[progress.agent] || DEFAULT_AGENT_CONFIG;

  const isReady = progress.stage === 'ready' || progress.stage === 'graded';

  return (
    <div className={`agent-status-banner ${className}`} role="status" aria-live="polite">
      <div
        className="agent-status-pill"
        style={{
          borderColor: info.color,
          boxShadow: `0 4px 16px rgba(0, 0, 0, 0.25), 0 0 12px ${info.glow}`,
        }}
      >
        <span className="agent-icon">{info.icon}</span>
        <strong className="agent-name" style={{ color: info.color }}>{info.agentName}</strong>
        {progress.concept_name && (
          <span className="agent-target-tag" title={`対象ノード: ${progress.concept_name}`}>
            🎯 {progress.concept_name}
          </span>
        )}
        <span className="agent-divider">/</span>
        <span className="agent-message">{progress.message}</span>
        {isReady ? (
          <CheckCircle2 className="agent-ready-icon" size={15} />
        ) : (
          <LoaderCircle className="agent-spin-icon spin" size={15} />
        )}
      </div>
    </div>
  );
};
