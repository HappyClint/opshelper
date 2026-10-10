"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { anchoredConfirmPosition } from "../ui/anchored-confirm-position";
import { IconTrash } from "./icons";
import { cleanTitle } from "./format";

export function ConversationArchiveAction({
  title,
  open,
  onOpen,
  onClose,
  onArchive,
}: {
  title: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onArchive: () => Promise<void>;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const openRef = useRef(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  openRef.current = open;

  useLayoutEffect(() => {
    if (!open) return;
    setError(null);
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const position = () => {
      const point = anchoredConfirmPosition(
        trigger.getBoundingClientRect(),
        panel.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
      );
      panel.style.left = `${point.left}px`;
      panel.style.top = `${point.top}px`;
    };
    position();
    // Start on the safe action, not on a destructive Enter default.
    cancelRef.current?.focus();
    const dismiss = (restoreFocus = false) => {
      if (busyRef.current) return;
      onClose();
      if (restoreFocus) trigger.focus();
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panel.contains(target) && !trigger.contains(target)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    const onScroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) dismiss(true);
    };
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener("resize", position);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      openRef.current = false;
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose]);

  const submitArchive = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const list = triggerRef.current?.closest(".opshelper-current-conversations");
    const panel = panelRef.current;
    try {
      await onArchive();
      if (openRef.current) onClose();
      // Wait for the archived row to unmount before restoring keyboard focus.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || panel?.contains(document.activeElement)) {
          list?.querySelector<HTMLElement>(".opshelper-conv-main, .opshelper-conv-more")?.focus();
        }
      });
      toast.success("会话已归档");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "归档失败，请重试");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const portalRoot = open ? triggerRef.current?.closest(".opshelper-shell") : null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="opshelper-conv-del"
        aria-label={`归档会话 ${cleanTitle(title)}`}
        title="归档会话"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={busy}
        onClick={() => {
          if (open) onClose();
          else onOpen();
        }}
      >
        <IconTrash />
      </button>
      {open && portalRoot ? createPortal(
        <div
          ref={panelRef}
          id={id}
          className="opshelper-archive-confirm"
          role="dialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          aria-busy={busy}
        >
          <h2 id={`${id}-title`}>归档会话？</h2>
          <p className="opshelper-archive-name" title={cleanTitle(title)}>{cleanTitle(title)}</p>
          <p id={`${id}-description`}>归档后不再显示在侧栏，目前无法恢复。</p>
          {error ? <p className="opshelper-archive-error" role="alert">{error}</p> : null}
          <div className="opshelper-archive-actions">
            <button
              ref={cancelRef}
              type="button"
              disabled={busy}
              onClick={() => {
                onClose();
                triggerRef.current?.focus();
              }}
            >取消</button>
            <button
              type="button"
              className="opshelper-archive-submit"
              disabled={busy}
              onClick={() => void submitArchive()}
            >{busy ? "归档中…" : "确认归档"}</button>
          </div>
        </div>,
        portalRoot,
      ) : null}
    </>
  );
}
