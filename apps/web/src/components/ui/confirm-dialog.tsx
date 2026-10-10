"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export type ConfirmVariant = "default" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelCallbackRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelCallbackRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initialFocus = variant === "danger" ? cancelRef.current : confirmRef.current;
    (initialFocus?.disabled ? dialog : initialFocus)?.focus();
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ) ?? []);
    function onKey(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) cancelCallbackRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          dialog?.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
          event.preventDefault();
          first.focus();
        }
      }
      // Enter follows the focused button's native behavior, never a global confirm.
    }
    const containFocus = (event: FocusEvent) => {
      if (!dialog?.contains(event.target as Node)) (focusable()[0] ?? dialog)?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", containFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, variant]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="file-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="file-dialog ui-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
      >
        <div className="file-dialog-title" id={`${id}-title`}>
          {title}
        </div>
        {description ? (
          <div className="ui-confirm-description" id={`${id}-description`}>{description}</div>
        ) : null}
        <div className="inline-actions file-dialog-actions">
          <button ref={cancelRef} className="button-secondary" type="button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={variant === "danger" ? "button-danger" : "button"}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "处理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
