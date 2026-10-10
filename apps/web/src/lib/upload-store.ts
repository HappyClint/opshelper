"use client";

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

type Subscriber = (items: UploadItem[]) => void;

let items: UploadItem[] = [];
const subscribers = new Set<Subscriber>();
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  const snapshot = [...items];
  for (const sub of subscribers) sub(snapshot);
}

function maybeScheduleAutoClear() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  if (items.length === 0) return;
  const allSettled = items.every((item) => item.status !== "uploading");
  if (!allSettled) return;
  const hasError = items.some((item) => item.status === "error");
  const timeoutMs = hasError ? 6000 : 1500;
  clearTimer = setTimeout(() => {
    items = [];
    notify();
  }, timeoutMs);
}

export const uploadStore = {
  subscribe(sub: Subscriber): () => void {
    subscribers.add(sub);
    sub([...items]);
    return () => subscribers.delete(sub);
  },
  getSnapshot(): UploadItem[] {
    return [...items];
  },
  add(newItems: UploadItem[]) {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    // Replace any previous fully-settled batch when starting a new one.
    const stillRunning = items.filter((item) => item.status === "uploading");
    items = [...stillRunning, ...newItems];
    notify();
  },
  update(id: string, patch: Partial<UploadItem>) {
    items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
    notify();
    maybeScheduleAutoClear();
  },
  clear() {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    items = [];
    notify();
  },
};
