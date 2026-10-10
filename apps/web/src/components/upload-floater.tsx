"use client";

import { useEffect, useState } from "react";

import { uploadStore, type UploadItem } from "@/lib/upload-store";

export function UploadFloater() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => uploadStore.subscribe(setItems), []);

  if (items.length === 0) return null;

  const uploading = items.filter((item) => item.status === "uploading").length;
  const failed = items.filter((item) => item.status === "error").length;
  const done = items.filter((item) => item.status === "done").length;
  const overallProgress = Math.round(
    items.reduce((acc, item) => acc + item.progress, 0) / items.length,
  );

  const summaryLabel =
    uploading > 0
      ? `上传中 ${done}/${items.length}（${overallProgress}%）`
      : failed > 0
        ? `${done}/${items.length} 完成 · ${failed} 失败`
        : `已完成 ${items.length} 项`;

  return (
    <div className="upload-floater" role="status" aria-live="polite">
      <button
        type="button"
        className="upload-floater-summary"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span className="upload-floater-spinner" data-busy={uploading > 0} />
        <span>{summaryLabel}</span>
        <span className="upload-floater-toggle" aria-hidden="true">
          {collapsed ? "▴" : "▾"}
        </span>
      </button>
      {!collapsed ? (
        <div className="upload-floater-list">
          {items.map((item) => (
            <div className="upload-floater-row" key={item.id}>
              <span className="upload-floater-name" title={item.name}>
                {item.name}
              </span>
              <progress value={item.progress} max={100} />
              <span
                className={
                  item.status === "error"
                    ? "upload-floater-status upload-floater-status-error"
                    : "upload-floater-status"
                }
              >
                {item.status === "error"
                  ? item.error ?? "失败"
                  : item.status === "done"
                    ? "✓"
                    : `${item.progress}%`}
              </span>
            </div>
          ))}
          <div className="upload-floater-actions">
            <button
              type="button"
              className="button-secondary upload-floater-clear"
              onClick={() => uploadStore.clear()}
              disabled={uploading > 0}
            >
              {uploading > 0 ? "上传中…" : "清除"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
