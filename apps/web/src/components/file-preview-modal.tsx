"use client";

import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import markdownItHighlightjs from "markdown-it-highlightjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { IconClose, IconDownload, IconEdit, IconEye, IconSave } from "./file-icons";
import { confirm as confirmDialog } from "./ui/dialog-host";

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "log",
  "csv",
  "tsv",
  "xml",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "bash",
  "zsh",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "sql",
  "env",
  "gitignore",
  "dockerfile",
]);

const PDF_EXTENSIONS = new Set(["pdf"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

export type PreviewKind = "text" | "markdown" | "html" | "pdf" | "image";

function getExtension(name: string) {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return name.toLowerCase();
  return name.slice(idx + 1).toLowerCase();
}

export function getPreviewKind(filename: string): PreviewKind | null {
  const ext = getExtension(filename);
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

export function isPreviewable(filename: string): boolean {
  return getPreviewKind(filename) !== null;
}

export interface PreviewSibling {
  name: string;
  path: string;
}

interface FilePreviewModalProps {
  filename: string;
  workspacePath: string;
  apiBase: string;
  onClose: () => void;
  onSaved?: () => void;
  siblings?: PreviewSibling[];
  onNavigate?: (sibling: PreviewSibling) => void;
}

interface ContentResponse {
  content: string;
  size: number;
  modified_at: number;
  encoding: "utf-8";
}

interface ErrorPayload {
  message?: string;
  currentModifiedAt?: number;
  limit?: number;
  size?: number;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(
  markdownItHighlightjs,
  { hljs, inline: false, auto: true },
);

async function parseError(response: Response): Promise<ErrorPayload & { status: number }> {
  let payload: ErrorPayload | null = null;
  try {
    payload = (await response.json()) as ErrorPayload;
  } catch {
    payload = null;
  }
  return { status: response.status, ...(payload ?? {}) };
}

export function FilePreviewModal({
  filename,
  workspacePath,
  apiBase,
  onClose,
  onSaved,
  siblings,
  onNavigate,
}: FilePreviewModalProps) {
  const kind = useMemo(() => getPreviewKind(filename), [filename]);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(kind !== "pdf" && kind !== "image");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [modifiedAt, setModifiedAt] = useState<number | null>(null);
  const [view, setView] = useState<"edit" | "preview">(
    kind === "markdown" || kind === "html" ? "preview" : "edit",
  );
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isText = kind === "text" || kind === "markdown" || kind === "html";
  const dirty = isText && content !== originalContent;

  const navIndex = useMemo(() => {
    if (!siblings || siblings.length === 0) return -1;
    return siblings.findIndex((s) => s.path === workspacePath);
  }, [siblings, workspacePath]);
  const prevSibling =
    siblings && navIndex > 0 ? siblings[navIndex - 1] : null;
  const nextSibling =
    siblings && navIndex >= 0 && navIndex < siblings.length - 1
      ? siblings[navIndex + 1]
      : null;

  const goSibling = useCallback(
    async (target: PreviewSibling) => {
      if (!onNavigate) return;
      if (dirty) {
        const ok = await confirmDialog({
          title: "放弃未保存的修改？",
          description: "切换文件会丢失当前未保存的改动。",
          confirmLabel: "切换",
          variant: "danger",
        });
        if (!ok) return;
      }
      onNavigate(target);
    },
    [dirty, onNavigate],
  );

  const loadContent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiBase}/content?path=${encodeURIComponent(workspacePath)}`,
      );
      if (!response.ok) {
        const err = await parseError(response);
        const message =
          err.status === 413
            ? `文件超出大小限制（${err.limit ? Math.round(err.limit / 1024) : "?"} KB），无法预览`
            : err.status === 415
              ? "该文件不是文本文件，无法预览"
              : err.message ?? "读取文件失败";
        throw new Error(message);
      }
      const data = (await response.json()) as ContentResponse;
      setContent(data.content);
      setOriginalContent(data.content);
      setModifiedAt(data.modified_at);
      setForceOverwrite(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取文件失败");
    } finally {
      setLoading(false);
    }
  }, [apiBase, workspacePath]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isText) {
      void loadContent();
    }
  }, [isText, loadContent]);

  useEffect(() => {
    setView(kind === "markdown" || kind === "html" ? "preview" : "edit");
  }, [kind, workspacePath]);

  const handleSave = useCallback(async () => {
    if (!isText) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: workspacePath,
          content,
          expectedModifiedAt: forceOverwrite ? undefined : modifiedAt ?? undefined,
        }),
      });
      if (!response.ok) {
        const err = await parseError(response);
        if (err.status === 409 && err.currentModifiedAt !== undefined) {
          setModifiedAt(err.currentModifiedAt);
          setForceOverwrite(true);
          setError(
            "文件在此期间已被其他进程修改。再点一次「保存」将以你的内容覆盖。",
          );
          return;
        }
        if (err.status === 413) {
          setError(
            `内容超出大小限制（${err.limit ? Math.round(err.limit / 1024) : "?"} KB）`,
          );
          return;
        }
        setError(err.message ?? "保存失败");
        return;
      }
      const data = (await response.json()) as { modified_at: number };
      setOriginalContent(content);
      setModifiedAt(data.modified_at);
      setForceOverwrite(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [apiBase, content, forceOverwrite, isText, modifiedAt, onSaved, workspacePath]);

  const handleClose = useCallback(async () => {
    if (dirty) {
      const ok = await confirmDialog({
        title: "放弃未保存的修改？",
        description: "当前文件存在未保存的改动，关闭后将丢失这些内容。",
        confirmLabel: "放弃修改",
        variant: "danger",
      });
      if (!ok) return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (isText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!saving && !loading) void handleSave();
      }
      const inEditable =
        event.target instanceof HTMLElement &&
        (event.target.tagName === "TEXTAREA" ||
          event.target.tagName === "INPUT" ||
          event.target.isContentEditable);
      if (inEditable) return;
      if (event.key === "ArrowLeft" && prevSibling) {
        event.preventDefault();
        void goSibling(prevSibling);
      } else if (event.key === "ArrowRight" && nextSibling) {
        event.preventDefault();
        void goSibling(nextSibling);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goSibling, handleClose, handleSave, isText, loading, nextSibling, prevSibling, saving]);

  const renderedHtml = useMemo(() => {
    if (kind !== "markdown") return "";
    return md.render(content);
  }, [content, kind]);

  const pdfSrc = useMemo(() => {
    if (kind !== "pdf") return "";
    return `${apiBase}/download?path=${encodeURIComponent(workspacePath)}&inline=1`;
  }, [apiBase, kind, workspacePath]);

  const imageSrc = useMemo(() => {
    if (kind !== "image") return "";
    return `${apiBase}/download?path=${encodeURIComponent(workspacePath)}&inline=1`;
  }, [apiBase, kind, workspacePath]);

  if (!mounted) return null;

  return createPortal(
    <div className="file-dialog-backdrop file-preview-backdrop" role="presentation">
      <div className="file-preview-modal" role="dialog" aria-modal="true" aria-label={`预览 ${filename}`}>
        <header className="file-preview-header">
          <div className="file-preview-title" title={workspacePath}>
            {filename}
          </div>
          <div className="file-preview-actions">
            {siblings && siblings.length > 1 ? (
              <>
                <button
                  type="button"
                  className="button-secondary file-preview-icon-button"
                  onClick={() => prevSibling && void goSibling(prevSibling)}
                  disabled={!prevSibling}
                  aria-label="上一个文件"
                  title="上一个文件 (←)"
                >
                  ‹
                </button>
                <span className="file-preview-counter mono">
                  {navIndex + 1} / {siblings.length}
                </span>
                <button
                  type="button"
                  className="button-secondary file-preview-icon-button"
                  onClick={() => nextSibling && void goSibling(nextSibling)}
                  disabled={!nextSibling}
                  aria-label="下一个文件"
                  title="下一个文件 (→)"
                >
                  ›
                </button>
              </>
            ) : null}
            {kind === "markdown" || kind === "html" ? (
              <div className="file-preview-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "edit"}
                  aria-label="编辑"
                  title="编辑"
                  className={view === "edit" ? "button file-preview-icon-button" : "button-secondary file-preview-icon-button"}
                  onClick={() => setView("edit")}
                >
                  <IconEdit />
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "preview"}
                  aria-label="预览"
                  title="预览"
                  className={view === "preview" ? "button file-preview-icon-button" : "button-secondary file-preview-icon-button"}
                  onClick={() => setView("preview")}
                >
                  <IconEye />
                </button>
              </div>
            ) : null}
            {isText ? (
              <button
                type="button"
                className="button file-preview-icon-button"
                disabled={!dirty || saving || loading}
                onClick={handleSave}
                aria-label={saving ? "保存中" : dirty ? "保存" : "已保存"}
                title={saving ? "保存中…" : dirty ? "保存 (⌘S)" : "已保存"}
              >
                <IconSave />
              </button>
            ) : null}
            <button
              type="button"
              className="button-secondary file-preview-icon-button"
              onClick={handleClose}
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="file-preview-body">
          {kind === null ? (
            <div className="file-preview-empty file-preview-unsupported">
              <p>该类型无法在线预览。</p>
              <a
                className="button file-preview-download"
                href={`${apiBase}/download?path=${encodeURIComponent(workspacePath)}`}
              >
                <IconDownload />
                <span>下载文件</span>
              </a>
            </div>
          ) : loading ? (
            <div className="file-preview-empty">加载中…</div>
          ) : kind === "pdf" ? (
            <iframe className="pdf-frame" src={pdfSrc} title={filename} />
          ) : kind === "image" ? (
            <div className="preview-image-stage">
              <img className="preview-image" src={imageSrc} alt={filename} />
            </div>
          ) : kind === "markdown" && view === "preview" ? (
            <div
              className="md-preview"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : kind === "html" && view === "preview" ? (
            <iframe
              className="html-preview-frame"
              sandbox="allow-scripts"
              srcDoc={content}
              title={filename}
            />
          ) : (
            <textarea
              ref={textareaRef}
              className="file-preview-textarea mono"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              wrap="off"
            />
          )}
        </div>

        {error ? (
          <div className="flash flash-error file-preview-flash">{error}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
