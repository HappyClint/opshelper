"use client";

import type { AdminUsersSnapshot } from "@opshelper/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { listUsers } from "@/lib/browser-api";
import { Skeleton } from "@/components/ui/skeleton";
import { UserCreateForm } from "@/components/user-create-form";
import { UserEditForm } from "@/components/user-edit-form";
import { toast } from "@/lib/toast";

type UserItem = AdminUsersSnapshot["users"][number];

type PanelMode = "view" | "create" | "edit";

type SortField = "username" | "createdAt" | "status";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 20;

function compareUsers(a: UserItem, b: UserItem, field: SortField, dir: SortDir) {
  let cmp = 0;
  if (field === "username") {
    cmp = a.username.localeCompare(b.username);
  } else if (field === "createdAt") {
    cmp = a.createdAt.localeCompare(b.createdAt);
  } else if (field === "status") {
    const av = a.isActive ? 1 : 0;
    const bv = b.isActive ? 1 : 0;
    cmp = av - bv;
  }
  return dir === "asc" ? cmp : -cmp;
}

export function UserManagementPanel({
  users: initialUsers,
  query: initialQuery,
}: {
  users: UserItem[];
  query: string;
}) {
  const router = useRouter();
  const [users, setUsers] = useState<UserItem[]>(initialUsers);
  const [query, setQuery] = useState<string>(initialQuery);
  const [searching, setSearching] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(
    initialUsers[0]?.id ?? null,
  );
  const [mode, setMode] = useState<PanelMode>("view");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const isInitialQuerySync = useRef(true);

  // Debounce search query → fetch + URL sync.
  useEffect(() => {
    if (isInitialQuerySync.current) {
      isInitialQuerySync.current = false;
      return;
    }
    const handle = window.setTimeout(() => {
      const trimmed = query.trim();
      const params = new URLSearchParams(window.location.search);
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
      const search = params.toString();
      router.replace(`/admin/users${search ? `?${search}` : ""}`, { scroll: false });

      setSearching(true);
      listUsers(trimmed)
        .then((snapshot) => {
          if (snapshot) {
            setUsers(snapshot.users);
            setPage(1);
          }
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : "搜索用户失败");
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [query, router]);

  useEffect(() => {
    if (!users.length) {
      setSelectedUserId(null);
      return;
    }
    if (!selectedUserId || !users.some((u) => u.id === selectedUserId)) {
      setSelectedUserId(users[0]?.id ?? null);
    }
  }, [selectedUserId, users]);

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => compareUsers(a, b, sortField, sortDir)),
    [users, sortField, sortDir],
  );
  const totalPages = Math.max(1, Math.ceil(sortedUsers.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedUsers = useMemo(
    () => sortedUsers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sortedUsers, safePage],
  );

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, users],
  );

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "createdAt" ? "desc" : "asc");
    }
    setPage(1);
  }

  async function refreshUsers() {
    try {
      const snapshot = await listUsers(query.trim());
      if (snapshot) setUsers(snapshot.users);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新用户列表失败");
    }
  }

  function sortIndicator(field: SortField) {
    if (sortField !== field) return null;
    return <span className="um-sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  return (
    <div className="um-layout">
      {/* Left: user list */}
      <div className="um-list-section">
        <div className="um-list-header">
          <div className="um-search-wrap">
            <input
              className="field-input um-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索账号或显示名..."
              type="search"
              aria-label="搜索用户"
            />
            {query ? (
              <button
                type="button"
                className="um-search-clear"
                aria-label="清除搜索"
                title="清除"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            ) : null}
            {searching ? (
              <span className="um-search-status muted">搜索中…</span>
            ) : null}
          </div>
          <button
            className="button"
            type="button"
            onClick={() => setMode("create")}
          >
            新增用户
          </button>
        </div>

        <div className="um-table">
          <div className="um-table-head">
            <button
              className="um-th-button"
              type="button"
              onClick={() => toggleSort("username")}
            >
              用户 {sortIndicator("username")}
            </button>
            <span>角色</span>
            <button
              className="um-th-button"
              type="button"
              onClick={() => toggleSort("status")}
            >
              状态 {sortIndicator("status")}
            </button>
            <button
              className="um-th-button"
              type="button"
              onClick={() => toggleSort("createdAt")}
            >
              创建时间 {sortIndicator("createdAt")}
            </button>
          </div>
          {searching && users.length === 0 ? (
            <div className="skeleton-list" role="status" aria-label="正在搜索用户">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="um-table-row um-table-row-skeleton" key={i}>
                  <div className="um-user-cell">
                    <Skeleton height={14} width="55%" />
                    <Skeleton height={11} width="38%" className="skeleton-mt" />
                  </div>
                  <Skeleton height={20} width={42} />
                  <Skeleton height={20} width={50} />
                  <Skeleton height={14} width="60%" />
                </div>
              ))}
            </div>
          ) : pagedUsers.length ? (
            pagedUsers.map((user) => {
              const isSelected = user.id === selectedUserId;

              return (
                <div
                  key={user.id}
                  className={`um-table-row${isSelected ? " um-table-row-selected" : ""}`}
                  onClick={() => {
                    setSelectedUserId(user.id);
                    setMode("edit");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedUserId(user.id);
                      setMode("edit");
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="um-user-cell">
                    <div className="um-user-name">{user.name}</div>
                    <div className="muted">@{user.username}</div>
                  </div>
                  <div>
                    <span className="tag">{user.role === "admin" ? "管理员" : "用户"}</span>
                  </div>
                  <div>
                    <span className={`tag ${user.isActive ? "tag-active" : "tag-muted"}`}>
                      {user.isActive ? "启用" : "停用"}
                    </span>
                    {user.keepContainerAlive ? (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        保活
                      </span>
                    ) : null}
                  </div>
                  <div className="mono">{user.createdAtLabel}</div>
                </div>
              );
            })
          ) : (
            <div className="um-empty">当前查询条件下没有匹配用户。</div>
          )}
        </div>

        {sortedUsers.length > PAGE_SIZE ? (
          <div className="um-pagination">
            <button
              className="button-secondary"
              type="button"
              disabled={safePage === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <span className="muted">
              第 {safePage} / {totalPages} 页 · 共 {sortedUsers.length} 个账号
            </span>
            <button
              className="button-secondary"
              type="button"
              disabled={safePage === totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </button>
          </div>
        ) : null}
      </div>

      {/* Right: detail panel */}
      <div className="um-detail-section">
        {mode === "create" ? (
          <UserCreateForm
            onCancel={() => setMode("view")}
            onCreated={async () => {
              setMode("view");
              await refreshUsers();
              router.refresh();
            }}
          />
        ) : mode === "edit" && selectedUser ? (
          <UserEditForm
            user={selectedUser}
            onCancel={() => setMode("view")}
            onUpdated={async () => {
              await refreshUsers();
              router.refresh();
            }}
            onDeleted={async () => {
              setMode("view");
              await refreshUsers();
              router.refresh();
            }}
          />
        ) : (
          <div className="um-detail-placeholder">
            <div className="um-detail-placeholder-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="32" height="32"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <div className="muted">点击用户行进行编辑，或点击「新增用户」创建账号</div>
          </div>
        )}
      </div>
    </div>
  );
}
