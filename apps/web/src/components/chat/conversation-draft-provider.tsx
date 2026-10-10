"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type SetStateAction } from "react";

import {
  conversationDraftStorageKey,
  EMPTY_DRAFT,
  moveConversationDraft,
  parseConversationDrafts,
  serializeConversationDrafts,
  updateConversationDraft,
  type ConversationDraft,
  type ConversationDrafts,
} from "./conversation-drafts";
import type { Attachment } from "./types";

type DraftStore = {
  drafts: ConversationDrafts;
  ready: boolean;
  updateDraft: (key: string, update: (draft: ConversationDraft) => ConversationDraft) => void;
  setDraft: (key: string, draft: ConversationDraft) => void;
  moveDraft: (from: string, to: string) => void;
};
const DraftContext = createContext<DraftStore | null>(null);

export function ConversationDraftProvider({ userKey, children }: { userKey: string; children: ReactNode }) {
  const [drafts, setDrafts] = useState<ConversationDrafts>({});
  const [ready, setReady] = useState(false);
  const storageKey = conversationDraftStorageKey(userKey);
  useEffect(() => {
    try {
      setDrafts(parseConversationDrafts(sessionStorage.getItem(storageKey)));
    } catch {
      // Keep drafts in memory when storage is unavailable.
    }
    setReady(true);
  }, [storageKey]);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(storageKey, serializeConversationDrafts(drafts));
    } catch {
      // Quota and private-mode failures must not interrupt editing.
    }
  }, [drafts, ready, storageKey]);

  const updateDraft = useCallback((key: string, update: (draft: ConversationDraft) => ConversationDraft) => {
    setDrafts((current) => updateConversationDraft(current, key, update));
  }, []);
  const setDraft = useCallback((key: string, draft: ConversationDraft) => {
    updateDraft(key, () => draft);
  }, [updateDraft]);
  const moveDraft = useCallback((from: string, to: string) => {
    setDrafts((current) => moveConversationDraft(current, from, to));
  }, []);
  const value = useMemo(() => ({ drafts, ready, updateDraft, setDraft, moveDraft }), [drafts, ready, updateDraft, setDraft, moveDraft]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useConversationDraftStore() {
  const store = useContext(DraftContext);
  if (!store) throw new Error("ConversationDraftProvider is required");
  return store;
}

export function useConversationDraft(key: string) {
  const { drafts, updateDraft, ready } = useConversationDraftStore();
  const setInput = useCallback((value: SetStateAction<string>) => {
    updateDraft(key, (draft) => ({ ...draft, input: typeof value === "function" ? value(draft.input) : value }));
  }, [key, updateDraft]);
  const setAttachments = useCallback((value: SetStateAction<Attachment[]>) => {
    updateDraft(key, (draft) => ({ ...draft, attachments: typeof value === "function" ? value(draft.attachments) : value }));
  }, [key, updateDraft]);
  return { ...(drafts[key] ?? EMPTY_DRAFT), setInput, setAttachments, ready };
}
