"use client";

import Link from "next/link";
import type { ConversationCollaboration } from "@opshelper/shared";

import { collaborationNote } from "./collaboration-note";
import { IconChevron } from "./icons";

const statusLabels: Record<ConversationCollaboration["status"], string> = {
  running: "执行中",
  waiting_input: "等待输入",
  failed: "失败",
  completed: "已完成",
};

/**
 * 协作过程固定在输入区上沿（分割线上方）：它是本次任务的运行状态，不是智能体答复的正文。
 * 留在对话区底部的固定条里、可折叠、默认收起，展开的明细也不会混进消息流。
 */
export function CollaborationBar({
  collaborations,
  conversationId,
}: {
  collaborations: ConversationCollaboration[];
  conversationId?: string | null;
}) {
  const note = collaborationNote(collaborations);
  if (!note) return null;

  return (
    <div className="opshelper-collaboration-strip">
      <details className="opshelper-collaboration-bar">
        <summary>
          <span className="opshelper-caret" aria-hidden="true"><IconChevron open={false} /></span>
          <span className="opshelper-collaboration-bar-title">
            协作过程 · {collaborations.length} 个智能体
          </span>
          <span className={`opshelper-collaboration-note ${note.tone}`}>{note.label}</span>
        </summary>
        <div className="opshelper-collaboration-list">
          {collaborations.map((item) => (
            <div className="opshelper-collaboration-item" key={item.traceId}>
              <div>
                <strong>{item.agentKey}</strong>
                <span className={`opshelper-collaboration-status ${item.status}`}>
                  {statusLabels[item.status]}
                </span>
              </div>
              <div className="opshelper-collaboration-title">{item.title}</div>
              {item.summary ? (
                <div className="opshelper-collaboration-summary">{item.summary}</div>
              ) : null}
              {conversationId ? (
                <Link
                  className="opshelper-collaboration-link"
                  href={`/chat/${encodeURIComponent(conversationId)}/collaborations/${item.traceId}`}
                >
                  查看进度
                </Link>
              ) : null}
              <div className="opshelper-collaboration-trace">排障编号 {item.traceId}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
