"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type PromptAutoSelect = "all" | "stem" | "none";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
  autoSelect?: PromptAutoSelect;
  busy?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

function applyAutoSelect(input: HTMLInputElement, mode: PromptAutoSelect) {
  const value = input.value;
  if (mode === "all") {
    input.select();
    return;
  }
  if (mode === "stem") {
    const dot = value.lastIndexOf(".");
    if (dot > 0) {
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
    return;
  }
  input.setSelectionRange(value.length, value.length);
}

export function PromptDialog({
  open,
  title,
  description,
  defaultValue = "",
  placeholder,
  confirmLabel = "确认",
  cancelLabel = "取消",
  validate,
  autoSelect = "all",
  busy = false,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    setTouched(false);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      applyAutoSelect(input, autoSelect);
    });
  }, [open, defaultValue, autoSelect]);

  const trimmed = value.trim();
  const liveError = validate ? validate(trimmed) : null;
  const displayError = touched && liveError ? liveError : null;
  const confirmDisabled = busy || liveError !== null;

  function attemptConfirm() {
    if (busy) return;
    if (liveError) {
      setTouched(true);
      return;
    }
    onConfirm(trimmed);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="file-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="file-dialog ui-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-prompt-title"
        onSubmit={(event) => {
          event.preventDefault();
          attemptConfirm();
        }}
      >
        <div className="file-dialog-title" id="ui-prompt-title">
          {title}
        </div>
        {description ? (
          <div className="ui-confirm-description">{description}</div>
        ) : null}
        <input
          ref={inputRef}
          className="field-input"
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={busy}
          aria-invalid={displayError ? true : undefined}
          aria-describedby={displayError ? "ui-prompt-error" : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            if (!touched) setTouched(true);
          }}
        />
        {displayError ? (
          <div className="ui-prompt-error" id="ui-prompt-error" role="alert">
            {displayError}
          </div>
        ) : null}
        <div className="inline-actions file-dialog-actions">
          <button
            className="button-secondary"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button className="button" type="submit" disabled={confirmDisabled}>
            {busy ? "处理中..." : confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
