// 侧栏会话列表的折叠规则。侧栏高度固定，会话会一直增长，所以默认只列最近若干条，
// 其余用“显示更早”按钮展开；搜索和“当前会话”是两条例外，抽成纯函数便于回归。

/** 默认折叠后仍会列出的最近会话条数。 */
export const RECENT_CONVERSATION_LIMIT = 10;

export interface ConversationHistoryWindow<T> {
  /** 实际渲染的会话，顺序与入参一致。 */
  listed: readonly T[];
  /** 被折叠起来的更早会话条数。 */
  earlierCount: number;
  /** 是否显示“显示更早 / 收起”按钮。 */
  expandable: boolean;
  /** 当前是否处于展开状态。 */
  expanded: boolean;
}

export function resolveConversationHistory<T extends { id: string }>(
  conversations: readonly T[],
  {
    activeConversationId,
    searchTerm,
    showAll,
    limit = RECENT_CONVERSATION_LIMIT,
  }: {
    activeConversationId: string | null;
    searchTerm: string;
    showAll: boolean;
    limit?: number;
  },
): ConversationHistoryWindow<T> {
  const earlierCount = Math.max(0, conversations.length - limit);
  const activeIndex = conversations.findIndex((item) => item.id === activeConversationId);
  // 搜索时列出全部命中结果；当前会话落在“更早”的部分时同样整体展开，
  // 否则打开一条旧会话后，侧栏里看不到自己停在哪儿。
  const expandable = searchTerm.trim() === "" && earlierCount > 0 && activeIndex < limit;
  const expanded = expandable && showAll;
  const listed = expandable && !expanded ? conversations.slice(0, limit) : conversations;
  return { listed, earlierCount, expandable, expanded };
}
