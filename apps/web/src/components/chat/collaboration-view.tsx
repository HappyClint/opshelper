"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CollaborationSnapshot } from "@opshelper/shared";
import { getCollaboration, replyExecutionPermission, replyExecutionQuestion } from "@/lib/browser-api";
import { WorkspaceMenuButton } from "../workspace-shell";
import { Conversation } from "./conversation";
import { PermissionCard, QuestionCard } from "./interaction-cards";
import { fromInitialMessages, sortedMessages } from "./message-model";

const labels = { running: "执行中", waiting_input: "等待输入", failed: "失败", completed: "已完成" };

export function CollaborationView({ conversationId, traceId }: { conversationId: string; traceId: string }) {
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await getCollaboration(conversationId, traceId);
        if (!disposed) { setSnapshot(next); setError(""); }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "读取进度失败");
      } finally {
        if (!disposed) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [conversationId, traceId, revision]);
  const respond = useCallback(async (action: () => Promise<unknown>) => {
    setSubmitting(true);
    try {
      await action();
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }, []);
  const messages = useMemo(() => sortedMessages(fromInitialMessages(snapshot?.messages ?? [])), [snapshot?.messages]);
  const child = snapshot?.collaboration;
  return (
    <main className="opshelper-main">
      <header className="opshelper-topbar">
        <WorkspaceMenuButton />
        <Link className="opshelper-collaboration-link" href={`/chat?conversation=${encodeURIComponent(conversationId)}`}>返回主会话</Link>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">{child?.agentKey ?? "子智能体会话"}</h1>
          <div className="opshelper-topbar-sub" role="status">{child ? `${labels[child.status]} · ${child.title}` : "正在读取进度…"}</div>
        </div>
      </header>
      {error ? <div className="opshelper-notice" role="alert">{error}</div> : null}
      {snapshot && child ? (
        <Conversation
          messages={messages}
          surface="ready"
          assistant={{ id: child.agentKey, name: child.agentKey, description: "子智能体尚未输出消息" }}
          busy={child.status === "running"}
          sessionId={traceId}
          onRestartFrom={() => {}}
          forkingMessageId={null}
          executions={[]}
          reconnecting={Boolean(error)}
          onReconcile={() => {}}
          readOnly
        />
      ) : null}
      {snapshot?.pendingQuestion && snapshot.executionId ? (
        <QuestionCard
          key={snapshot.pendingQuestion.id}
          question={snapshot.pendingQuestion}
          submitting={submitting}
          onAnswer={(answers) => void respond(() => replyExecutionQuestion(snapshot.executionId!, snapshot.pendingQuestion!.id, answers))}
        />
      ) : null}
      <fieldset className="opshelper-collaboration-permissions" disabled={submitting}>
        {!snapshot?.autoApprovePermissions && snapshot?.executionId ? snapshot.pendingPermissions.map((permission) => (
          <PermissionCard
            key={permission.id}
            permission={{ ...permission, sessionId: "" }}
            onRespond={(response) => void respond(() => replyExecutionPermission(snapshot.executionId!, permission.id, response))}
          />
        )) : null}
      </fieldset>
    </main>
  );
}
