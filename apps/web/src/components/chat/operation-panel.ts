/**
 * 操作记录面板的展示状态。
 *
 * 一轮对话可能产生几十条工具记录，全部铺开会把对话正文挤出屏幕；用户想回看较早
 * 的记录时，又会因为新记录不断追加而被拉回底部。所以明细区改成固定高度的滚动区：
 * 默认停在最新的几条，用户自己往上滚动后就不再自动跟随。这里只放可测的纯逻辑
 * （每个工具框的展开状态、每轮滚动位置、是否贴着底部），DOM 事件留在组件里。
 * 展开状态按该轮第一条操作记录隔离，不能成为后续工具框或会话的默认值。
 */

import type { ToolOperation } from "./tool-activity";

export const OPERATIONS_PANEL_STORAGE_KEY = "opshelper.chat.operationsPanel";

/** 记住最近多少轮明细区的滚动位置，避免 localStorage 随对话无限增长。 */
export const OPERATION_SCROLL_LIMIT = 20;

/** 距底部多少像素以内仍视为“贴着最新记录”。 */
export const OPERATION_PIN_THRESHOLD = 24;

/** 距顶部多少像素以内视为没有隐藏更早的记录。 */
export const OPERATION_EDGE_THRESHOLD = 4;

export interface OperationsPanelState {
  /** 每个工具框最后一次手动展开/折叠的结果，键是该轮第一条操作记录的 id。 */
  open: Record<string, boolean>;
  /** 每轮明细区的滚动位置，键是该轮第一条操作记录的 id。 */
  scroll: Record<string, number>;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** localStorage 的最小接口，便于在没有 window 的环境里替换。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createOperationsPanelState(): OperationsPanelState {
  return { open: {}, scroll: {} };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 存储内容可能来自旧版本或被手工改坏，读不懂就退回默认值，不能让聊天页崩掉。 */
export function parseOperationsPanelState(raw: string | null | undefined): OperationsPanelState {
  if (!raw) return createOperationsPanelState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createOperationsPanelState();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return createOperationsPanelState();
  }
  const source = parsed as { open?: unknown; scroll?: unknown };
  const open: Record<string, boolean> = {};
  if (source.open && typeof source.open === "object" && !Array.isArray(source.open)) {
    for (const [key, value] of Object.entries(source.open as Record<string, unknown>)) {
      if (key && typeof value === "boolean") open[key] = value;
    }
  }
  const scroll: Record<string, number> = {};
  if (source.scroll && typeof source.scroll === "object" && !Array.isArray(source.scroll)) {
    for (const [key, value] of Object.entries(source.scroll as Record<string, unknown>)) {
      const offset = nonNegativeNumber(value);
      if (key && offset !== null) scroll[key] = offset;
    }
  }
  return { open, scroll };
}

export function serializeOperationsPanelState(state: OperationsPanelState) {
  return JSON.stringify({ open: state.open, scroll: state.scroll });
}

/** 一轮记录的稳定标识：第一条操作的 id 在该轮内不变，新追加的记录不会换键。 */
export function operationsTurnKey(operations: ToolOperation[]) {
  return operations[0]?.id ?? null;
}

export function panelOpen(state: OperationsPanelState, turnKey: string | null) {
  return turnKey ? state.open[turnKey] ?? false : false;
}

export function rememberPanelOpen(
  state: OperationsPanelState,
  turnKey: string | null,
  open: boolean,
): OperationsPanelState {
  if (!turnKey) return state;
  const values = { ...state.open };
  // 折叠本来就是默认值，只持久化用户明确展开的工具框；再次折叠就移除记录。
  if (open) values[turnKey] = true;
  else delete values[turnKey];
  return { ...state, open: values };
}

/** 记录滚动位置；同一个键重新插入，超上限时淘汰最久没看过的那一轮。 */
export function rememberPanelScroll(
  state: OperationsPanelState,
  turnKey: string | null,
  scrollTop: number,
): OperationsPanelState {
  const offset = nonNegativeNumber(scrollTop);
  if (!turnKey || offset === null) return state;
  const scroll: Record<string, number> = { ...state.scroll };
  delete scroll[turnKey];
  scroll[turnKey] = Math.round(offset);
  const keys = Object.keys(scroll);
  for (const stale of keys.slice(0, Math.max(0, keys.length - OPERATION_SCROLL_LIMIT))) {
    delete scroll[stale];
  }
  return { ...state, scroll };
}

export function panelScrollTop(state: OperationsPanelState, turnKey: string | null) {
  if (!turnKey) return null;
  return nonNegativeNumber(state.scroll[turnKey]);
}

export function isPinnedToLatest(metrics: ScrollMetrics, threshold = OPERATION_PIN_THRESHOLD) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function hasEarlierRecords(metrics: ScrollMetrics, threshold = OPERATION_EDGE_THRESHOLD) {
  return metrics.scrollTop > threshold;
}

/** 恢复历史滚动位置时不要落到列表外面：记录可能变短，也可能还没渲染完。 */
export function clampPanelScrollTop(scrollTop: number, metrics: ScrollMetrics) {
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return Math.min(Math.max(0, scrollTop), max);
}

/** 用户往上翻之后新到的记录条数；贴着底部时始终是 0。 */
export function pendingOperationCount(total: number, seen: number, pinned: boolean) {
  if (pinned) return 0;
  return Math.max(0, Math.round(total) - Math.round(seen));
}

export function loadOperationsPanelState(storage: StorageLike | null | undefined) {
  if (!storage) return createOperationsPanelState();
  try {
    return parseOperationsPanelState(storage.getItem(OPERATIONS_PANEL_STORAGE_KEY));
  } catch {
    return createOperationsPanelState();
  }
}

export function saveOperationsPanelState(
  storage: StorageLike | null | undefined,
  state: OperationsPanelState,
) {
  if (!storage) return;
  try {
    storage.setItem(OPERATIONS_PANEL_STORAGE_KEY, serializeOperationsPanelState(state));
  } catch {
    // 隐私模式或配额已满时忽略：只影响下次打开页面时的记忆。
  }
}

/** 取本机 localStorage；隐私模式下取用本身就会抛错，所以整体包一层。 */
export function chatStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}
