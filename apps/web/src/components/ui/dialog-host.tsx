"use client";

import { useEffect, useState } from "react";

import {
  ConfirmDialog,
  type ConfirmDialogProps,
  type ConfirmVariant,
} from "./confirm-dialog";
import {
  PromptDialog,
  type PromptAutoSelect,
  type PromptDialogProps,
} from "./prompt-dialog";

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

export interface PromptOptions {
  title: string;
  description?: React.ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
  autoSelect?: PromptAutoSelect;
}

type ConfirmState = ConfirmOptions & {
  kind: "confirm";
  resolve: (result: boolean) => void;
};

type PromptState = PromptOptions & {
  kind: "prompt";
  resolve: (result: string | null) => void;
};

type DialogState = ConfirmState | PromptState;

type Subscriber = (state: DialogState) => void;

let subscriber: Subscriber | null = null;
const pendingQueue: DialogState[] = [];

function deliver(state: DialogState) {
  if (subscriber) {
    subscriber(state);
  } else {
    pendingQueue.push(state);
  }
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    deliver({ kind: "confirm", ...options, resolve });
  });
}

export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    deliver({ kind: "prompt", ...options, resolve });
  });
}

export function DialogHost() {
  const [active, setActive] = useState<DialogState | null>(null);

  useEffect(() => {
    subscriber = (state) => setActive(state);
    while (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      if (next) setActive(next);
    }
    return () => {
      subscriber = null;
    };
  }, []);

  function close(result: boolean | string | null) {
    if (!active) return;
    if (active.kind === "confirm") {
      active.resolve(typeof result === "boolean" ? result : false);
    } else {
      active.resolve(typeof result === "string" ? result : null);
    }
    setActive(null);
  }

  if (!active) return null;

  if (active.kind === "confirm") {
    const props: ConfirmDialogProps = {
      open: true,
      title: active.title,
      description: active.description,
      confirmLabel: active.confirmLabel,
      cancelLabel: active.cancelLabel,
      variant: active.variant,
      onConfirm: () => close(true),
      onCancel: () => close(false),
    };
    return <ConfirmDialog {...props} />;
  }

  const props: PromptDialogProps = {
    open: true,
    title: active.title,
    description: active.description,
    defaultValue: active.defaultValue,
    placeholder: active.placeholder,
    confirmLabel: active.confirmLabel,
    cancelLabel: active.cancelLabel,
    validate: active.validate,
    autoSelect: active.autoSelect,
    onConfirm: (value) => close(value),
    onCancel: () => close(null),
  };
  return <PromptDialog {...props} />;
}
