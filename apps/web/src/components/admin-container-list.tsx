"use client";

import { useMemo, useState } from "react";
import type { ContainerStatus, ContainerSummary } from "@opshelper/shared";

import { ContainerActions, startActionState, stopActionState } from "./container-actions";
import { ContainerLogsModal } from "./container-logs-modal";
import { StatusPill } from "./status-pill";

type ContainerRow = ContainerSummary & { lastActivityAtLabel: string };

type StatusFilter = "all" | "running" | "stopped" | "error";
type SortField = "lastActivity" | "name";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 20;

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
  { value: "error", label: "异常" },
];

function matchFilter(status: ContainerStatus, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "error") return status === "error";
  if (filter === "running") return status === "running" || status === "creating";
  if (filter === "stopped") return status === "stopped" || status === "deleting";
  return true;
}

function compareRows(a: ContainerRow, b: ContainerRow, field: SortField, dir: SortDir) {
  let cmp = 0;
  if (field === "name") {
    cmp = a.name.localeCompare(b.name);
  } else if (field === "lastActivity") {
    const av = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bv = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    cmp = av - bv;
  }
  return dir === "asc" ? cmp : -cmp;
}

export function AdminContainerList({ containers }: { containers: ContainerRow[] }) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("lastActivity");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [logsContainer, setLogsContainer] = useState<ContainerRow | null>(null);

  const filtered = useMemo(
    () => containers.filter((c) => matchFilter(c.status, filter)),
    [containers, filter],
  );
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareRows(a, b, sortField, sortDir)),
    [filtered, sortField, sortDir],
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sorted, safePage],
  );

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "lastActivity" ? "desc" : "asc");
    }
    setPage(1);
  }

  if (containers.length === 0) {
    return (
      <div className="empty-hero">
        <div className="empty-hero-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <div className="muted">暂无容器记录。</div>
      </div>
    );
  }

  return (
    <>
      <div className="admin-container-controls">
        <div className="admin-status-chips" role="tablist" aria-label="状态筛选">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`admin-status-chip${filter === f.value ? " admin-status-chip-active" : ""}`}
              onClick={() => {
                setFilter(f.value);
                setPage(1);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="admin-sort-controls">
          <button
            type="button"
            className={`button-secondary admin-sort-button${sortField === "lastActivity" ? " admin-sort-button-active" : ""}`}
            onClick={() => toggleSort("lastActivity")}
          >
            按最近活动 {sortField === "lastActivity" ? (sortDir === "asc" ? "↑" : "↓") : ""}
          </button>
          <button
            type="button"
            className={`button-secondary admin-sort-button${sortField === "name" ? " admin-sort-button-active" : ""}`}
            onClick={() => toggleSort("name")}
          >
            按名称 {sortField === "name" ? (sortDir === "asc" ? "↑" : "↓") : ""}
          </button>
        </div>
      </div>

      {paged.length > 0 ? (
        <div className="list">
          {paged.map((container) => (
            <div className="row" key={container.id}>
              <div>
                <div className="row-title">
                  {container.name}

                </div>
                <div className="muted">{container.ownerName}</div>
              </div>
              <StatusPill status={container.status} />
              <div className="mono">{container.lastActivityAtLabel}</div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setLogsContainer(container)}
                >
                  日志
                </button>
                <ContainerActions
                  actions={[
                    {
                      label: "启动",
                      path: `/v1/admin/containers/${container.id}/start`,
                      ...startActionState(container.status, "重启或重建环境"),
                    },
                    {
                      label: "停止",
                      path: `/v1/admin/containers/${container.id}/stop`,
                      confirm: `确定停止容器「${container.name}」吗？`,
                      ...stopActionState(container.status),
                    },
                    {
                      label: "重建环境",
                      path: `/v1/admin/containers/${container.id}/update-runtime`,
                      confirm: `将立即重建容器「${container.name}」并使用当前最新镜像，需要先完成当前执行或处理恢复状态。用户文件与聊天记录会保留。继续吗？`,
                    },
                    {
                      label: "移除容器",
                      path: `/v1/admin/containers/${container.id}`,
                      method: "DELETE",
                      variant: "danger",
                      confirm: `确定移除容器「${container.name}」吗？用户文件、聊天记录和智能体分配会保留，下次使用时自动重建。`,
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-hero">
          <div className="muted">该筛选条件下没有匹配容器。</div>
        </div>
      )}

      {logsContainer ? (
        <ContainerLogsModal
          endpoint={`/v1/admin/containers/${logsContainer.id}/logs`}
          title={`${logsContainer.name} · 最近日志`}
          onClose={() => setLogsContainer(null)}
        />
      ) : null}

      {sorted.length > PAGE_SIZE ? (
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
            第 {safePage} / {totalPages} 页 · 共 {sorted.length} 个容器
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
    </>
  );
}
