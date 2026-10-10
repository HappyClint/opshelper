import type { ConversationCollaboration } from "@opshelper/shared";

export type CollaborationTone = "running" | "waiting" | "failed" | "completed";

export interface CollaborationNote {
  tone: CollaborationTone;
  label: string;
}

/**
 * 输入区上方的协作过程只显示一条状态。失败和等待用户输入比“还在跑”更需要处理，
 * 所以按失败 → 等待输入 → 执行中 → 已完成的顺序取第一个命中的状态。
 */
export function collaborationNote(
  collaborations: Pick<ConversationCollaboration, "status">[],
): CollaborationNote | null {
  if (collaborations.length === 0) return null;
  const count = (status: ConversationCollaboration["status"]) =>
    collaborations.filter((item) => item.status === status).length;
  const failed = count("failed");
  if (failed > 0) return { tone: "failed", label: `${failed} 项失败` };
  const waiting = count("waiting_input");
  if (waiting > 0) return { tone: "waiting", label: `${waiting} 项等待输入` };
  const running = count("running");
  if (running > 0) return { tone: "running", label: `${running} 项执行中` };
  return { tone: "completed", label: "全部已完成" };
}
