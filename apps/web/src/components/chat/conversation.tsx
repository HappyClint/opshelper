"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ExecutionSummary } from "@opshelper/shared";

import { AgentMark, starterExamplesFor, type Assistant } from "./assistant";
import {
  describeOpencodeError,
  fileAttachments,
  messageHasContent,
  partHasUserFacingContent,
  partsText,
  safeStringify,
} from "./format";
import { IconChevron, IconPaperclip, IconTool } from "./icons";
import { renderAssistantMarkdown } from "./markdown";
import type { ChatMessage, ChatPart } from "./message-model";
import type { ConversationSurface } from "./conversation-surface";
import {
  groupConversationTurns,
  turnErrors,
  turnParts,
  type ConversationTurn,
} from "./conversation-turns";
import {
  chatStorage,
  clampPanelScrollTop,
  createOperationsPanelState,
  hasEarlierRecords,
  isPinnedToLatest,
  loadOperationsPanelState,
  operationsTurnKey,
  panelOpen,
  panelScrollTop,
  pendingOperationCount,
  rememberPanelOpen,
  rememberPanelScroll,
  saveOperationsPanelState,
  type OperationsPanelState,
} from "./operation-panel";
import {
  operationCategories,
  operationsFromParts,
  operationStatusLabel,
  operationSummary,
  type ToolOperation,
} from "./tool-activity";

const activeStatuses: ExecutionSummary["status"][] = [
  "queued",
  "dispatching",
  "running",
  "waiting_input",
];
const issueStatuses: ExecutionSummary["status"][] = ["failed", "cancelled", "interrupted"];

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean) {
  const index = findLastIndex(items, predicate);
  return index >= 0 ? items[index] : undefined;
}

export function Conversation({
  messages,
  surface,
  assistant,
  busy,
  sessionId,
  onPick,
  onRestartFrom,
  forkingMessageId,
  executions,
  reconnecting,
  onReconcile,
  readOnly = false,
}: {
  surface: ConversationSurface;
  readOnly?: boolean;
  messages: ChatMessage[];
  assistant: Assistant;
  busy: boolean;
  sessionId: string | null;
  onPick: (text: string) => void;
  onRestartFrom: (message: ChatMessage) => void;
  forkingMessageId: string | null;
  executions: ExecutionSummary[];
  reconnecting: boolean;
  onReconcile: (executionId: string) => void;
}) {
  const conversationRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const latestReplyRef = useRef<HTMLDivElement>(null);
  const shouldFollowOutput = useRef(true);
  const latestReplyIdRef = useRef<string | null>(null);
  const settledSessionId = useRef<string | null>(null);
  const turns = groupConversationTurns(messages);
  const lastUserIndex = findLastIndex(turns, (turn) => turn.role === "user");
  const latestReply = findLast(
    turns.slice(lastUserIndex + 1),
    (turn) => turn.role === "assistant" && turn.messages.some((message) =>
      messageHasContent(message) || Boolean(message.error)),
  );
  const latestReplySize = latestReply
    ? turnParts(latestReply).reduce(
        (total, part) => total + part.text.length + (part.tool ? part.tool.name.length + part.tool.status.length : 0),
        0,
      )
    : 0;

  const updateFollowOutput = () => {
    const element = conversationRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldFollowOutput.current = distanceFromBottom <= 48;
  };

  // 用户一旦在操作记录里翻看（滚轮、拖滚动条、键盘），就停止自动跟随输出，
  // 否则新记录会把这个区域连同阅读位置一起推走。
  const stopFollowingOutput = useCallback(() => {
    shouldFollowOutput.current = false;
  }, []);

  // Jump instantly to the bottom when a session's history first arrives —
  // smooth-scrolling across a long history is slow and visibly animates the
  // whole conversation. The session id flips before the messages load (they're
  // fetched async, and cleared to empty in between), so key the instant jump on
  // "history just populated for a session we haven't settled yet". A newly
  // arriving reply is anchored at its beginning; short streamed replies keep
  // following only while the user remains near the bottom.
  useLayoutEffect(() => {
    const justLoaded = settledSessionId.current !== sessionId && messages.length > 0;
    if (justLoaded) {
      settledSessionId.current = sessionId;
      shouldFollowOutput.current = true;
      latestReplyIdRef.current = latestReply?.key ?? null;
      endRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }

    const replyJustAppeared = Boolean(
      latestReply && latestReply.key !== latestReplyIdRef.current,
    );
    latestReplyIdRef.current = latestReply?.key ?? null;
    if (replyJustAppeared) {
      latestReplyRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
      updateFollowOutput();
    } else if (shouldFollowOutput.current) {
      endRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [busy, latestReply?.key, latestReplySize, messages.length, sessionId]);

  const latestExecution = executions[executions.length - 1];
  const activeExecution = findLast(
    executions,
    (execution) => activeStatuses.includes(execution.status),
  );
  const visibleIssue = latestExecution && issueStatuses.includes(latestExecution.status)
    ? latestExecution
    : null;
  const activityLabel = reconnecting
    ? "连接中断，正在核对状态…"
    : activeExecution?.status === "queued"
      ? activeExecution.queuePosition && activeExecution.queuePosition > 1
        ? `排队中，前面还有 ${activeExecution.queuePosition - 1} 项…`
        : "正在准备…"
      : activeExecution?.status === "dispatching"
        ? "正在准备回答…"
        : "正在处理…";
  const showActivity = busy && activeExecution?.status !== "waiting_input" && !latestReply;

  return (
    <div
      ref={conversationRef}
      className="opshelper-conversation"
      onScroll={updateFollowOutput}
      onWheel={(event) => {
        if (event.deltaY < 0) shouldFollowOutput.current = false;
      }}
    >
      {surface === "loading" ? (
        <div className="opshelper-conversation-status" role="status">
          <span className="opshelper-spinner" aria-hidden="true" />
          <span>正在加载会话…</span>
        </div>
      ) : null}
      {surface === "unavailable" ? (
        <div className="opshelper-conversation-status" role="status">这条会话暂时无法加载</div>
      ) : null}
      {surface === "new" && messages.length === 0 && !busy ? (
        <div className="opshelper-empty">
          <AgentMark
            id={assistant.id}
            name={assistant.name}
            description={assistant.description}
          />
          <h1 className="opshelper-empty-title">有什么可以帮你？</h1>
          <p className="opshelper-empty-hint">
            直接说说你想做什么，也可以选择一个示例，补充内容后发送。
          </p>
          <div className="opshelper-empty-cards">
            {starterExamplesFor(assistant).map((example) => (
              <button
                key={example.text}
                type="button"
                className="opshelper-empty-card"
                title={example.text}
                onClick={() => onPick(example.text)}
                disabled={busy}
              >
                <span className="opshelper-empty-card-title">{example.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {surface === "ready" || surface === "new" ? turns.map((turn) => {
        const message = turn.messages[0];
        return turn.role === "user" ? (
          <div key={turn.key} className="opshelper-msg opshelper-msg-user">
            {fileAttachments(message.parts).length > 0 ? (
              <div className="opshelper-msg-attachments">
                {fileAttachments(message.parts).map((name, idx) => (
                  <span key={`${name}-${idx}`} className="opshelper-msg-attachment">
                    <IconPaperclip />
                    {name}
                  </span>
                ))}
              </div>
            ) : null}
            {partsText(message.parts).trim() ? (
              <div className="opshelper-bubble">{partsText(message.parts)}</div>
            ) : null}
            {!readOnly ? <div className="opshelper-msg-actions">
              <button
                type="button"
                className="opshelper-msg-action"
                onClick={() => onRestartFrom(message)}
                disabled={busy || forkingMessageId !== null}
                title="保留此前的对话，重新编辑这条消息；原对话保留，工作区文件不会回退"
              >
                {forkingMessageId === message.id ? "创建中…" : "从这里重新开始"}
              </button>
            </div> : null}
          </div>
        ) : (
          <AssistantTurn
            key={turn.key}
            turn={turn}
            agentKey={assistant.id}
            agentName={assistant.name}
            agentDescription={assistant.description}
            busy={busy && turn.key === latestReply?.key}
            messageRef={turn.key === latestReply?.key ? latestReplyRef : undefined}
            onInspectOperations={stopFollowingOutput}
          />
        );
      }) : null}
      {visibleIssue ? (
        <div className="opshelper-execution-stack">
          <ExecutionState execution={visibleIssue} onReconcile={onReconcile} />
        </div>
      ) : null}
      {showActivity ? (
        <div className="opshelper-msg opshelper-msg-assistant opshelper-msg-progress" aria-live="polite">
          <AgentMark id={assistant.id} name={assistant.name} description={assistant.description} />
          <div className="opshelper-assistant-body" role="status">
            <span>{activityLabel}</span>
            <TypingDots />
          </div>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}

function ExecutionState({
  execution,
  onReconcile,
}: {
  execution: ExecutionSummary;
  onReconcile: (executionId: string) => void;
}) {
  const labels: Partial<Record<ExecutionSummary["status"], string>> = {
    failed: "处理失败",
    cancelled: "已停止",
    interrupted: "执行状态无法确认，工作台已暂停",
  };
  const label = labels[execution.status];
  if (!label) return null;
  return (
    <div className={`opshelper-execution-state ${execution.status}`} role="alert">
      <span>{label}</span>
      {execution.error ? (
        <span className="opshelper-execution-error">{execution.error}</span>
      ) : null}
      {execution.status === "interrupted" ? (
        <button onClick={() => onReconcile(execution.id)}>重新核对状态</button>
      ) : null}
    </div>
  );
}

const AssistantTurn = memo(function AssistantTurn({
  turn,
  agentKey,
  agentName,
  agentDescription,
  busy,
  messageRef,
  onInspectOperations,
}: {
  turn: ConversationTurn;
  agentKey: string;
  agentName: string;
  agentDescription: string;
  busy: boolean;
  messageRef?: RefObject<HTMLDivElement | null>;
  onInspectOperations?: () => void;
}) {
  const parts = turnParts(turn);
  const visibleParts = parts.filter(partHasUserFacingContent);
  const operations = operationsFromParts(parts, agentKey);
  const errors = Array.from(new Set(turnErrors(turn).map(describeOpencodeError)));
  const hasContent = visibleParts.length > 0 || operations.length > 0 || errors.length > 0;
  // 出错/空回复的“空壳”消息（只有 step-start 之类不可见 part）不渲染。
  if (!hasContent && !busy) return null;

  return (
    <div ref={messageRef} className="opshelper-msg opshelper-msg-assistant">
      {/* 角色标识留在正文之外：回答本身不再套卡片，识别只靠这一列图标。 */}
      <AgentMark id={agentKey} name={agentName} description={agentDescription} />
      <div className="opshelper-assistant-body">
        {visibleParts.map((part) => <PartView key={part.id} part={part} />)}
        {operations.length > 0 ? (
          <OperationDisclosure operations={operations} onInspect={onInspectOperations} />
        ) : null}
        {errors.map((error) => (
          <div className="opshelper-msg-error" role="alert" key={error}>
            本轮回复失败：{error}
          </div>
        ))}
        {busy && hasContent && errors.length === 0 ? <StreamingIndicator /> : null}
      </div>
    </div>
  );
});

function TypingDots() {
  return (
    <span className="opshelper-typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function StreamingIndicator() {
  return <span className="opshelper-streaming-indicator" role="status" aria-label="正在继续输出" />;
}

const PartView = memo(function PartView({ part }: { part: ChatPart }) {
  if (!part.text.trim()) return null;
  return (
    <div
      className="opshelper-markdown"
      dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(part.text) }}
    />
  );
});

function debugText(value: unknown, limit = 12_000) {
  const result = safeStringify(value) ?? "";
  return result.length > limit ? `${result.slice(0, limit)}\n…（内容过长，已截断）` : result;
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null || durationMs < 100) return null;
  return durationMs < 1000 ? `${durationMs} 毫秒` : `${(durationMs / 1000).toFixed(1)} 秒`;
}

function OperationDisclosure({
  operations,
  onInspect,
}: {
  operations: ToolOperation[];
  onInspect?: () => void;
}) {
  const turnKey = operationsTurnKey(operations);
  const [open, setOpen] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [pending, setPending] = useState(0);
  const listId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 展开状态和滚动位置都按 turnKey 隔离：只影响用户点过的这个工具框。
  const panelRef = useRef<OperationsPanelState>(createOperationsPanelState());
  const mountedRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const seenRef = useRef(operations.length);
  const offsetRef = useRef(0);
  const savedAtRef = useRef(0);
  const flushRef = useRef<number | null>(null);

  const saveScroll = (scrollTop: number) => {
    panelRef.current = rememberPanelScroll(panelRef.current, turnKey, scrollTop);
    saveOperationsPanelState(chatStorage(), panelRef.current);
  };

  // 滚动事件很密，写入要限流；但最后一次一定要落盘，否则重新打开会回到旧位置。
  const scheduleSaveScroll = () => {
    const now = Date.now();
    if (now - savedAtRef.current >= 200) {
      savedAtRef.current = now;
      saveScroll(offsetRef.current);
      return;
    }
    if (flushRef.current !== null) window.clearTimeout(flushRef.current);
    flushRef.current = window.setTimeout(() => {
      flushRef.current = null;
      savedAtRef.current = Date.now();
      saveScroll(offsetRef.current);
    }, 200);
  };

  // 新工具框默认折叠；用户点过的旧工具框只恢复它自己的状态。
  useLayoutEffect(() => {
    const stored = loadOperationsPanelState(chatStorage());
    panelRef.current = stored;
    setOpen(panelOpen(stored, turnKey));
  }, [turnKey]);

  useLayoutEffect(() => {
    if (!open) return;
    const element = scrollRef.current;
    if (!element) return;
    const count = operations.length;

    // 滚动区可能是刚挂载的（首次展开、收起后重新展开、切换会话）：先回到用户上次
    // 离开的位置，没有记录就停在最新的几条。滚动区被卸载过时 scrollTop 会归零。
    if (mountedRef.current !== element) {
      mountedRef.current = element;
      const stored = panelScrollTop(panelRef.current, turnKey);
      element.scrollTop = stored === null
        ? element.scrollHeight
        : clampPanelScrollTop(stored, element);
      pinnedRef.current = isPinnedToLatest(element);
      seenRef.current = count;
      offsetRef.current = element.scrollTop;
      setShowEarlier(hasEarlierRecords(element));
      setPending(0);
      return;
    }

    // 贴着底部才跟随新记录；用户往上翻以后只提示还有多少条新记录。
    if (pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
      seenRef.current = count;
      offsetRef.current = element.scrollTop;
      setShowEarlier(hasEarlierRecords(element));
      setPending(0);
      return;
    }
    setPending(pendingOperationCount(count, seenRef.current, false));
  }, [open, operations.length, turnKey]);

  useEffect(() => () => {
    if (flushRef.current !== null) window.clearTimeout(flushRef.current);
    if (!turnKey || !mountedRef.current) return;
    panelRef.current = rememberPanelScroll(panelRef.current, turnKey, offsetRef.current);
    saveOperationsPanelState(chatStorage(), panelRef.current);
  }, [turnKey]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const pinned = isPinnedToLatest(element);
    pinnedRef.current = pinned;
    offsetRef.current = element.scrollTop;
    setShowEarlier(hasEarlierRecords(element));
    if (pinned) {
      seenRef.current = operations.length;
      setPending(0);
    }
    scheduleSaveScroll();
  };

  const toggleOpen = () => {
    const next = !open;
    if (open) {
      if (flushRef.current !== null) window.clearTimeout(flushRef.current);
      flushRef.current = null;
      saveScroll(offsetRef.current);
    }
    setOpen(next);
    panelRef.current = rememberPanelOpen(panelRef.current, turnKey, next);
    saveOperationsPanelState(chatStorage(), panelRef.current);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    seenRef.current = operations.length;
    offsetRef.current = element.scrollTop;
    setShowEarlier(hasEarlierRecords(element));
    setPending(0);
    saveScroll(element.scrollTop);
  };

  const categories = operationCategories(operations);
  const summary = operationSummary(operations);
  const outsideCount = operations.filter((operation) => operation.outsideWorkspace).length;
  const externalCount = operations.filter((operation) => operation.externalAccess).length;
  const status = operations.some((operation) => operation.status === "failed")
    ? "failed"
    : operations.some((operation) => operation.status === "running")
      ? "running"
      : operations.some((operation) => operation.status === "pending")
        ? "pending"
        : "completed";

  return (
    <section className={`opshelper-operations ${status}`} aria-label="本轮操作记录">
      <button
        className="opshelper-operations-summary"
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={toggleOpen}
      >
        <span className="opshelper-operations-icon" aria-hidden="true"><IconTool /></span>
        <span className="opshelper-operations-copy">{summary}</span>
        <span className="opshelper-operation-chips">
          {categories.map((category) => (
            <span className={`opshelper-operation-chip ${category.emphasis}`} key={category.kind}>
              {category.label} {category.count}
            </span>
          ))}
          {outsideCount > 0 ? (
            <span className="opshelper-operation-chip notice">工作区外 {outsideCount}</span>
          ) : null}
          {externalCount > 0 && !categories.some((category) => category.kind === "network") ? (
            <span className="opshelper-operation-chip notice">外部访问 {externalCount}</span>
          ) : null}
        </span>
        <span className="opshelper-caret" aria-hidden="true"><IconChevron open={open} /></span>
      </button>
      {/* 播报节点放在按钮之外：按钮内部的 live region 会让可访问名称变成空字符串 */}
      <span className="opshelper-sr-only" role="status">{summary}</span>
      {open ? (
        <div className="opshelper-operation-viewport">
          {/* 明细区固定高度，只有最新的几条可见，更早的记录用滚动条上下翻。 */}
          <div
            id={listId}
            ref={scrollRef}
            className="opshelper-operation-scroll"
            role="group"
            tabIndex={0}
            aria-label={`操作记录明细，共 ${operations.length} 项${
              pending > 0 ? `，下方还有 ${pending} 项新记录` : ""
            }`}
            onScroll={handleScroll}
            onWheel={onInspect}
            onPointerDown={onInspect}
            onKeyDown={onInspect}
          >
            <ol className="opshelper-operation-list" role="list">
              {operations.map((operation) => (
                <OperationRow operation={operation} key={operation.id} />
              ))}
            </ol>
          </div>
          {showEarlier ? (
            <span className="opshelper-operation-earlier" aria-hidden="true">上方还有更早的记录</span>
          ) : null}
          {pending > 0 ? (
            <button className="opshelper-operation-jump" type="button" onClick={jumpToLatest}>
              回到最新
              <span className="opshelper-operation-jump-count">{pending} 项新记录</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function OperationRow({ operation }: { operation: ToolOperation }) {
  const duration = formatDuration(operation.durationMs);
  return (
    <li className={`opshelper-operation-row ${operation.status}`}>
      <span className="opshelper-operation-marker" aria-hidden="true" />
      <div className="opshelper-operation-main">
        <div className="opshelper-operation-line">
          <span className="opshelper-operation-label">{operation.label}</span>
          {operation.target ? (
            <code className="opshelper-operation-target" title={operation.target}>{operation.target}</code>
          ) : null}
          {operation.result ? <span className="opshelper-operation-result">{operation.result}</span> : null}
        </div>
        <div className="opshelper-operation-meta">
          {operation.outsideWorkspace ? <span className="warning">工作区外</span> : null}
          {operation.externalAccess ? <span className="warning">外部访问</span> : null}
          {operation.changesState ? <span>可能更改内容</span> : null}
          {operation.skillName ? <span>本轮按需启用</span> : null}
          {duration ? <span>{duration}</span> : null}
        </div>
        <details className="opshelper-operation-debug">
          <summary>调用详情</summary>
          <div className="opshelper-operation-debug-name">
            工具标识 <code>{operation.toolName}</code>
          </div>
          {operation.input != null ? (
            <>
              <div className="opshelper-operation-debug-label">参数</div>
              <pre className="opshelper-tool-block opshelper-tool-input">{debugText(operation.input)}</pre>
            </>
          ) : null}
          {operation.kind === "skill" ? (
            <div className="opshelper-operation-private">技能说明属于运行指引，不在对话中展开。</div>
          ) : operation.output ? (
            <>
              <div className="opshelper-operation-debug-label">输出</div>
              <pre className="opshelper-tool-block">{debugText(operation.output)}</pre>
            </>
          ) : null}
        </details>
      </div>
      <span className={`opshelper-operation-status ${operation.status}`}>
        {operationStatusLabel(operation.status)}
      </span>
    </li>
  );
}
