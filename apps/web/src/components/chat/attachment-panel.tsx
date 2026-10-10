"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { parentPath, rootPath, type FileInfo } from "../file-manager/utils";
import { IconChevron, IconClose, IconFolder, IconPaperclip } from "./icons";
import type { MentionFile } from "./types";

// 与 chat.css 的 960px 断点保持一致：窄屏时附件面板是覆盖式浮层，
// 需要把焦点移入面板并让背景不可交互，否则键盘用户会落到被遮挡的控件上。
const OVERLAY_MEDIA_QUERY = "(max-width: 960px)";
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AttachmentPanel({
  onAttach,
  onUpload,
  onClose,
}: {
  onAttach: (file: MentionFile) => void;
  onUpload: (files: File[]) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(rootPath);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const load = useCallback(async (nextPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/v1/users/me/files/list?path=${encodeURIComponent(nextPath)}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null) as { files?: FileInfo[]; message?: string } | null;
      if (!response.ok) throw new Error(payload?.message ?? "文件列表加载失败");
      setFiles(payload?.files ?? []);
      setPath(nextPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(rootPath);
  }, [load]);

  useEffect(() => {
    const query = window.matchMedia(OVERLAY_MEDIA_QUERY);
    const sync = () => setOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!overlay) return;
    const panel = panelRef.current;
    const shell = panel?.closest(".opshelper-shell");
    if (!panel || !shell) return;
    const background = Array.from(shell.children).filter((element) => element !== panel);
    const previousFocus = document.activeElement as HTMLElement | null;
    panel.focus();
    for (const element of background) element.setAttribute("inert", "");
    return () => {
      for (const element of background) element.removeAttribute("inert");
      if (!panel.contains(document.activeElement)) previousFocus?.focus?.();
    };
  }, [overlay]);

  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // 背景已 inert，这里只把 Tab 循环限制在面板内部。
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !panel.contains(active);
      if (event.shiftKey ? active === first || active === panel || outside : active === last || outside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, overlay]);

  return (
    <aside
      className="opshelper-attachment-panel"
      id="opshelper-attachment-panel"
      ref={panelRef}
      tabIndex={-1}
      aria-label="添加附件"
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay ? true : undefined}
    >
      <div className="opshelper-files-head">
        <button onClick={() => void load(parentPath(path))} disabled={path === rootPath} title="上一级">
          <span className="opshelper-attachment-back"><IconChevron open={false} /></span>
        </button>
        <div className="opshelper-files-title">添加附件</div>
        <button onClick={onClose} title="关闭"><IconClose /></button>
      </div>
      <div className="opshelper-attachment-path">{path.replace(/^\/workspace\/?/, "工作目录/").replace(/\/$/, "")}</div>
      <div className="opshelper-attachment-actions">
        <button className="opshelper-btn" onClick={() => inputRef.current?.click()}>
          <IconPaperclip /> 上传并添加
        </button>
        <input
          ref={inputRef}
          hidden
          multiple
          type="file"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (selected.length > 0) onUpload(selected);
          }}
        />
      </div>
      <div className="opshelper-attachment-list">
        {loading ? <div className="opshelper-attachment-empty">正在加载…</div> : null}
        {error ? <div className="opshelper-attachment-error">{error}</div> : null}
        {!loading && !error && files.length === 0 ? <div className="opshelper-attachment-empty">当前目录没有文件</div> : null}
        {files.map((file) => file.type === "directory" ? (
          <button className="opshelper-attachment-row" key={file.path} onClick={() => void load(file.path)}>
            <IconFolder />
            <span>{file.name}</span>
            <IconChevron open={false} />
          </button>
        ) : (
          <div className="opshelper-attachment-row" key={file.path}>
            <IconPaperclip />
            <span>{file.name}</span>
            <button
              className="opshelper-attachment-add"
              onClick={() => onAttach({
                rel: file.path.replace(/^\/workspace\/?/, ""),
                path: file.path,
                filename: file.name,
              })}
            >
              添加
            </button>
          </div>
        ))}
      </div>
      <LinkToFiles />
    </aside>
  );
}

function LinkToFiles() {
  return (
    <Link className="opshelper-attachment-manage" href="/files">
      进入完整文件管理
    </Link>
  );
}
