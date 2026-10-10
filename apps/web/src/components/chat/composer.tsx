"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatModelOption } from "@opshelper/shared";

import { IconClock, IconClose, IconPaperclip, IconSend, IconStop } from "./icons";
import type { Attachment, MentionFile } from "./types";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  models = [],
  model = "",
  onModelChange,
  autoApprovePermissions = false,
  onAutoApprovePermissionsChange,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onSearchFiles,
  onMention,
  onSchedule,
  blocked = false,
  readOnly = false,
  queueHint = false,
  submitting = false,
  stopping = false,
  focusToken = 0,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  // 可切换模型列表（为空时不渲染选择器）与当前选中的完整引用。
  models?: ChatModelOption[];
  model?: string;
  onModelChange?: (model: string) => void;
  autoApprovePermissions?: boolean;
  onAutoApprovePermissionsChange?: (enabled: boolean) => void;
  attachments: Attachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSearchFiles: (query: string) => Promise<MentionFile[]>;
  onMention: (file: MentionFile) => void;
  onSchedule: () => void;
  blocked?: boolean;
  readOnly?: boolean;
  queueHint?: boolean;
  submitting?: boolean;
  stopping?: boolean;
  // 每次递增都把焦点移到输入框末尾（首屏示例填入草稿后接着编辑）。
  focusToken?: number;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const composingRef = useRef(false);
  const keyboardHintId = useId();
  // The `@` autocomplete: `range` is the [start,end) span of the `@query` token
  // in the textarea that a pick should replace.
  const [mention, setMention] = useState<
    { query: string; range: [number, number] } | null
  >(null);
  const [mentionResults, setMentionResults] = useState<MentionFile[]>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const dragDepth = useRef(0);

  const uploading = attachments.some((a) => a.status === "uploading");
  const hasReady = attachments.some((a) => a.status === "ready");
  const canSend = (value.trim().length > 0 || hasReady) && !uploading && !blocked;

  // 单行起步、随内容自动增高（封顶交给 CSS max-height，超出后内部滚动）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (focusToken <= 0) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusToken]);

  // Detect a `@token` immediately before the caret and drive the autocomplete.
  const syncMention = useCallback((text: string, caret: number) => {
    if (composingRef.current) return;
    const upToCaret = text.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(upToCaret);
    if (!match) {
      setMention(null);
      return;
    }
    const start = caret - match[2].length - 1; // include the '@'
    setMention({ query: match[2], range: [start, caret] });
    setMentionActive(0);
  }, []);

  useEffect(() => {
    if (!mention) {
      setMentionResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void onSearchFiles(mention.query).then((results) => {
        if (!cancelled) setMentionResults(results);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention, onSearchFiles]);

  const pickMention = useCallback(
    (file: MentionFile) => {
      onMention(file);
      const range = mention?.range;
      if (range) {
        // Replace the typed `@query` with a tidy `@filename ` reference.
        const next = `${value.slice(0, range[0])}@${file.filename} ${value.slice(range[1])}`;
        onChange(next);
      }
      setMention(null);
      setMentionResults([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [mention, onChange, onMention, value],
  );

  const showMentions = mention !== null && mentionResults.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229 covers Safari's Enter after compositionend.
    if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (showMentions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActive((i) => (i + 1) % mentionResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActive((i) => (i - 1 + mentionResults.length) % mentionResults.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionResults[mentionActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (blocked) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onAddFiles(files);
  };

  return (
    <div
      className={`opshelper-composer${dragOver ? " opshelper-composer-dragover" : ""}`}
      onDragEnter={(e) => {
        if (!blocked && Array.from(e.dataTransfer.types).includes("Files")) {
          dragDepth.current += 1;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {dragOver ? <div className="opshelper-composer-drop-hint">松开以上传文件</div> : null}

      {attachments.length > 0 ? (
        <div className="opshelper-attach-list">
          {attachments.map((a) => (
            <div
              key={a.id}
              className={`opshelper-attach-chip${a.status === "error" ? " error" : ""}`}
              title={a.path || a.filename}
            >
              {a.status === "uploading" ? (
                <span className="opshelper-attach-spinner" aria-hidden="true" />
              ) : (
                <span className="opshelper-attach-icon" aria-hidden="true">
                  {a.source === "mention" ? "@" : <IconPaperclip />}
                </span>
              )}
              <span className="opshelper-attach-name">{a.filename}</span>
              <button
                className="opshelper-attach-remove"
                onClick={() => onRemoveAttachment(a.id)}
                aria-label="移除附件"
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="opshelper-composer-row">
        {showMentions ? (
          <div className="opshelper-mention-menu" role="listbox">
            {mentionResults.map((file, idx) => (
              <button
                key={file.path}
                role="option"
                aria-selected={idx === mentionActive}
                className={`opshelper-mention-item${idx === mentionActive ? " active" : ""}`}
                onMouseEnter={() => setMentionActive(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(file);
                }}
              >
                <span className="opshelper-mention-name">{file.filename}</span>
                <span className="opshelper-mention-path">{file.rel}</span>
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          placeholder="描述问题，可附上日志或截图"
          aria-label="消息内容"
          aria-describedby={keyboardHintId}
          value={value}
          readOnly={readOnly}
          onCompositionStart={() => {
            composingRef.current = true;
            setMention(null);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            syncMention(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) =>
            syncMention(value, (e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 120)}
        />

        {/* 工具条与输入框同壳：附件、模型切换靠左，发送靠右，不再单占一行。 */}
        <div className="opshelper-composer-tools">
          <button
            className="opshelper-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            aria-label="上传文件"
            title="上传文件"
            disabled={blocked}
          >
            <IconPaperclip />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!blocked && files.length > 0) onAddFiles(files);
            }}
          />

          {models.length > 0 ? (
            <label className="opshelper-model-pick" title="切换模型（对下一条消息生效）">
              <select
                value={models.some((m) => m.model === model) ? model : ""}
                onChange={(e) => onModelChange?.(e.target.value)}
                aria-label="切换模型"
              >
                {!models.some((m) => m.model === model) ? (
                  <option value="">默认模型</option>
                ) : null}
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label
            className={`opshelper-auto-approve${autoApprovePermissions ? " active" : ""}`}
            title="开启后，本条及后续消息产生的工具授权将自动允许一次；智能体提问仍需处理"
          >
            <input
              type="checkbox"
              checked={autoApprovePermissions}
              onChange={(event) => onAutoApprovePermissionsChange?.(event.target.checked)}
              disabled={blocked}
            />
            <span>自动授权</span>
          </label>

          {queueHint ? <span className="opshelper-queue-hint">任务处理中，可继续输入下一条</span> : null}
          {submitting ? <span className="opshelper-sending-hint" role="status">发送中…</span> : null}
          <span className="opshelper-composer-spacer" />

          <button
            className="opshelper-schedule-btn"
            type="button"
            onClick={onSchedule}
            disabled={!canSend}
            title="把当前任务设为定时任务"
          >
            <IconClock />
            <span>设为定时</span>
          </button>

          {busy ? (
            <button
              className="opshelper-send opshelper-stop"
              onClick={onStop}
              disabled={stopping}
              aria-label={stopping ? "正在停止当前任务" : "停止当前任务"}
            >
              <IconStop />
              <span>{stopping ? "停止中…" : "停止"}</span>
            </button>
          ) : null}
          {busy && canSend ? (
            <button className="opshelper-queue-send" onClick={onSend} aria-label="将消息加入队列">
              加入队列
            </button>
          ) : null}
          {!busy && !submitting ? (
            <button
              className="opshelper-send"
              onClick={onSend}
              disabled={!canSend}
              aria-label="发送"
              title="发送"
            >
              <IconSend />
            </button>
          ) : null}
        </div>
      </div>
      <div className="opshelper-composer-keyboard-hint" id={keyboardHintId}>Enter 发送 · Shift+Enter 换行</div>
    </div>
  );
}
