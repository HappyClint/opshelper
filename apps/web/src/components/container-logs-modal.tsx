"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface ContainerLogsModalProps {
  endpoint: string;
  title: string;
  onClose: () => void;
}

interface LogsResponse {
  logs: string;
  tail: number;
}

export function ContainerLogsModal({ endpoint, title, onClose }: ContainerLogsModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [tail, setTail] = useState(200);

  const load = useCallback(
    async (nextTail: number) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${endpoint}?tail=${nextTail}`);
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(payload?.message ?? "读取日志失败");
        }
        const data = (await response.json()) as LogsResponse;
        setLogs(data.logs);
        setTail(data.tail);
      } catch (err) {
        setError(err instanceof Error ? err.message : "读取日志失败");
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    void load(200);
  }, [load]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="file-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="container-logs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="container-logs-header">
          <div className="container-logs-title">{title}</div>
          <div className="container-logs-actions">
            <select
              className="container-logs-tail-select"
              value={tail}
              onChange={(e) => void load(Number.parseInt(e.target.value, 10))}
              aria-label="行数"
            >
              <option value={100}>最近 100 行</option>
              <option value={200}>最近 200 行</option>
              <option value={500}>最近 500 行</option>
              <option value={1000}>最近 1000 行</option>
            </select>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void load(tail)}
              disabled={loading}
            >
              {loading ? "加载中…" : "刷新"}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={onClose}
              aria-label="关闭"
            >
              关闭
            </button>
          </div>
        </header>
        <div className="container-logs-body">
          {loading && !logs ? (
            <div className="container-logs-empty">加载日志…</div>
          ) : error ? (
            <div className="container-logs-empty container-logs-error">{error}</div>
          ) : logs.trim() ? (
            <pre className="container-logs-pre mono">{logs}</pre>
          ) : (
            <div className="container-logs-empty">暂无日志输出</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
