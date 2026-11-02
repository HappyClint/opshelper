"use client";

import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  getFileIcon,
  IconArrowUp,
  IconCopy,
  IconDownload,
  IconEdit,
  IconEye,
  IconFilePlus,
  IconFileUp,
  IconFolder,
  IconFolderPlus,
  IconFolderUp,
  IconRefresh,
  IconScissors,
  IconTrash,
} from "./file-icons";
import { FileContextMenu, type FileContextMenuItem } from "./file-context-menu";
import { FilePreviewModal, isPreviewable } from "./file-preview-modal";
import { Skeleton } from "./ui/skeleton";
import {
  confirm as confirmDialog,
  prompt as promptDialog,
} from "./ui/dialog-host";
import { toast } from "@/lib/toast";
import { uploadStore } from "@/lib/upload-store";
import {
  collectDroppedFiles,
  copyText,
  expandedPathsStorageKey,
  fileDragMimeType,
  formatDate,
  formatSize,
  getDisplayPath,
  isInsidePath,
  parentPath,
  parseJson,
  pathSegments,
  readPersistedExpandedPaths,
  rootLabel,
  rootPath,
  uploadFile,
  type FileInfo,
  type FileTreeRow,
} from "./file-manager/utils";

type FileView = "all" | "uploads" | "outputs";
type FileClipboard = { mode: "copy" | "cut"; items: FileInfo[] };

// chat-uploads 是对话与手动上传的落点，outputs 存放智能体生成的内容。
const scopedViewRoots: Partial<Record<FileView, { path: string; label: string }>> = {
  uploads: { path: `${rootPath}/chat-uploads`, label: "对话上传文件" },
  outputs: { path: `${rootPath}/outputs`, label: "生成文件" },
};

function normalizedWorkspacePath(value?: string) {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (normalized !== rootPath && !normalized.startsWith(`${rootPath}/`)) return null;
  const relativeParts = normalized.slice(rootPath.length).split("/").filter(Boolean);
  if (relativeParts.some((part) => part === "." || part === "..")) return null;
  return relativeParts.length ? `${rootPath}/${relativeParts.join("/")}` : rootPath;
}

function initialDirectories(targetPath: string | null) {
  if (!targetPath || targetPath === rootPath) return [rootPath];
  const parts = targetPath.slice(rootPath.length).split("/").filter(Boolean);
  const paths = [rootPath];
  let cursor = rootPath;
  for (const part of parts.slice(0, -1)) {
    cursor = `${cursor}/${part}`;
    paths.push(cursor);
  }
  return paths;
}

export function FileManager({
  compact = false,
  initialPath,
}: {
  compact?: boolean;
  initialPath?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [entriesByPath, setEntriesByPath] = useState<Record<string, FileInfo[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(readPersistedExpandedPaths);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [moveItems, setMoveItems] = useState<FileInfo[] | null>(null);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null);
  const [draggedPaths, setDraggedPaths] = useState<string[]>([]);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<FileInfo | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    | { position: { x: number; y: number }; target: "row"; file: FileInfo }
    | { position: { x: number; y: number }; target: "blank"; parentPath: string }
    | null
  >(null);
  const [view, setView] = useState<FileView>("all");
  const [searchText, setSearchText] = useState("");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const requestedPath = useMemo(() => normalizedWorkspacePath(initialPath), [initialPath]);

  const scope = scopedViewRoots[view];
  const scopeRoot = scope?.path ?? rootPath;
  const canGoUp = currentPath !== scopeRoot;
  const apiBase = "/v1/users/me/files";
  const downloadBase = useMemo(() => `${apiBase}/download?path=`, [apiBase]);

  const listUrl = useCallback(
    (path: string) =>
      `/v1/users/me/files/list?path=${encodeURIComponent(path)}${
        showHidden ? "&showHidden=1" : ""
      }`,
    [showHidden],
  );

  const load = useCallback(
    async (path: string) => {
      const nextPath = path || rootPath;
      const response = await fetch(listUrl(nextPath), { cache: "no-store" });
      const payload = await parseJson<{ files: FileInfo[] }>(response);
      setEntriesByPath((previous) => ({
        ...previous,
        [nextPath]: payload.files,
      }));
      setCurrentPath(nextPath);
    },
    [listUrl],
  );

  const treeRows = useMemo<FileTreeRow[]>(
    () => (entriesByPath[currentPath] ?? []).map((file) => ({ file, level: 0 })),
    [entriesByPath, currentPath],
  );

  const searchKeyword = searchText.trim().toLowerCase();
  const isFlatView = searchKeyword.length > 0;
  const visibleRows = useMemo(() => {
    if (!isFlatView) return treeRows;
    const rows: FileTreeRow[] = [];
    const seen = new Set<string>();
    for (const list of Object.values(entriesByPath)) {
      for (const file of list) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        if (scope && !file.path.startsWith(`${scope.path}/`)) continue;
        if (searchKeyword && !file.name.toLowerCase().includes(searchKeyword)) continue;
        rows.push({ file, level: 0 });
      }
    }
    return rows.sort((a, b) => a.file.name.localeCompare(b.file.name));
  }, [isFlatView, treeRows, entriesByPath, searchKeyword, scope]);

  const visibleFiles = useMemo(() => visibleRows.map((row) => row.file), [visibleRows]);
  const selectedFiles = useMemo(
    () => visibleFiles.filter((file) => selectedPaths.has(file.path)),
    [selectedPaths, visibleFiles],
  );
  const fileByPath = useMemo(() => {
    const files = new Map<string, FileInfo>();
    for (const entryList of Object.values(entriesByPath)) {
      for (const file of entryList) files.set(file.path, file);
    }
    return files;
  }, [entriesByPath]);
  const directoryOptions = useMemo(() => {
    const directories = new Map<string, string>([[rootPath, rootLabel]]);
    for (const files of Object.values(entriesByPath)) {
      for (const file of files) {
        if (file.type === "directory") directories.set(file.path, getDisplayPath(file.path));
      }
    }
    return Array.from(directories, ([path, label]) => ({ path, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [entriesByPath]);

  const rootLoaded = currentPath in entriesByPath;
  const visibleSelectedCount = visibleFiles.filter((file) => selectedPaths.has(file.path)).length;
  const allVisibleSelected = visibleFiles.length > 0 && visibleSelectedCount === visibleFiles.length;

  useEffect(() => {
    let cancelled = false;
    const initialPaths = Array.from(new Set([
      ...expandedPaths,
      ...initialDirectories(requestedPath),
    ]));
    if (!initialPaths.includes(rootPath)) initialPaths.unshift(rootPath);

    (async () => {
      try {
        const results = await Promise.all(
          initialPaths.map(async (p) => {
            try {
              const response = await fetch(listUrl(p), { cache: "no-store" });
              const payload = await parseJson<{ files: FileInfo[] }>(response);
              return [p, payload.files] as const;
            } catch {
              return [p, null] as const;
            }
          }),
        );
        if (cancelled) return;
        const next: Record<string, FileInfo[]> = {};
        const liveExpanded = new Set<string>([rootPath]);
        for (const [p, files] of results) {
          if (files !== null) {
            next[p] = files;
            if (p !== rootPath) liveExpanded.add(p);
          }
        }
        setEntriesByPath(next);
        if (requestedPath && requestedPath !== rootPath) {
          const targetParent = parentPath(requestedPath);
          const target = next[targetParent]?.find((file) => file.path === requestedPath);
          setCurrentPath(targetParent);
          if (target) {
            setSelectedPaths(new Set([requestedPath]));
            setFocusedPath(requestedPath);
            if (isPreviewable(target.name)) setPreviewItem(target);
          } else {
            toast.error("结果文件已不存在或无法访问");
          }
        }
        // Drop persisted entries whose folders no longer exist.
        if (
          liveExpanded.size !== expandedPaths.size ||
          Array.from(expandedPaths).some((p) => !liveExpanded.has(p))
        ) {
          setExpandedPaths(liveExpanded);
        }
      } catch (error) {
        if (cancelled) return;
        toast.error(error instanceof Error ? error.message : "文件加载失败");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchView(next: FileView) {
    setView(next);
    setSearchText("");
    setSelectedPaths(new Set());
    const target = scopedViewRoots[next]?.path ?? rootPath;
    run(async () => {
      try {
        await load(target);
      } catch {
        // 目录尚未创建时按空目录展示。
        setEntriesByPath((previous) => ({ ...previous, [target]: [] }));
        setCurrentPath(target);
      }
    });
  }

  function downloadItems(items: FileInfo[]) {
    items.forEach((file, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = `${downloadBase}${encodeURIComponent(file.path)}`;
        anchor.download = file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * 300);
    });
  }

  useEffect(() => {
    if (!focusedPath) return;
    const frame = requestAnimationFrame(() => {
      treeRef.current?.querySelector<HTMLElement>(
        `[data-file-path="${CSS.escape(focusedPath)}"]`,
      )?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedPath, visibleRows]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        expandedPathsStorageKey,
        JSON.stringify(Array.from(expandedPaths).filter((p) => p !== rootPath)),
      );
    } catch {
      // localStorage may be unavailable (private mode / quota) — ignore.
    }
  }, [expandedPaths]);

  const didMountHidden = useRef(false);
  useEffect(() => {
    if (!didMountHidden.current) {
      didMountHidden.current = true;
      return;
    }
    // 切换「显示隐藏文件」后重新拉取当前展开的全部目录。
    run(() => refreshTree(currentPath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "操作失败");
      }
    });
  }

  async function refreshTree(...affectedPaths: string[]) {
    const pathsToLoad = new Set<string>([rootPath, scopeRoot]);
    for (const p of affectedPaths) pathsToLoad.add(p);
    for (const p of expandedPaths) pathsToLoad.add(p);

    const results = await Promise.all(
      Array.from(pathsToLoad).map(async (p) => {
        try {
          const response = await fetch(listUrl(p), { cache: "no-store" });
          const payload = await parseJson<{ files: FileInfo[] }>(response);
          return [p, payload.files] as const;
        } catch {
          return [p, null] as const;
        }
      }),
    );

    const next: Record<string, FileInfo[]> = {};
    for (const [p, files] of results) {
      if (files !== null) next[p] = files;
    }
    setEntriesByPath(next);
  }

  function toggleDirectory(file: FileInfo) {
    if (file.type !== "directory") return;
    setSearchText("");
    setSelectedPaths(new Set());
    setFocusedPath(null);
    run(() => load(file.path));
  }

  function toggleSelected(path: string) {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) {
        for (const file of visibleFiles) next.delete(file.path);
      } else {
        for (const file of visibleFiles) next.add(file.path);
      }
      return next;
    });
  }

  async function moveSelectedItems(items: FileInfo[], targetDir: string) {
    const sourceDirs = items.map((item) => parentPath(item.path));
    for (const item of items) {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourcePath: item.path, targetDir }),
        }),
      );
    }
    setSelectedPaths(new Set());
    setMoveItems(null);
    toast.success(items.length === 1 ? "已移动" : `已移动 ${items.length} 项`);
    await refreshTree(targetDir, ...sourceDirs);
  }

  function canPasteTo(targetDir: string) {
    if (!fileClipboard || fileClipboard.items.length === 0) return false;
    return !fileClipboard.items.some((item) =>
      item.type === "directory" && isInsidePath(targetDir, item.path),
    );
  }

  function copyOrCutItems(items: FileInfo[], mode: FileClipboard["mode"]) {
    if (items.length === 0) return;
    const topLevelItems = items.filter((item) => !items.some((candidate) =>
      candidate.path !== item.path &&
      candidate.type === "directory" &&
      isInsidePath(item.path, candidate.path),
    ));
    setFileClipboard({ mode, items: topLevelItems });
    toast.success(mode === "copy" ? `已复制 ${topLevelItems.length} 项` : `已剪切 ${topLevelItems.length} 项`);
  }

  async function pasteItems(targetDir: string) {
    if (!fileClipboard) return;
    if (!canPasteTo(targetDir)) throw new Error("不能粘贴到所选文件夹自身或其子目录");
    const { items, mode } = fileClipboard;
    if (mode === "cut") {
      await moveSelectedItems(items, targetDir);
      setFileClipboard(null);
      return;
    }

    for (const item of items) {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/copy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourcePath: item.path, targetDir }),
        }),
      );
    }
    toast.success(items.length === 1 ? "已复制" : `已复制 ${items.length} 项`);
    await refreshTree(targetDir);
  }

  async function startRename(file: FileInfo) {
    const parentDir = parentPath(file.path);
    const siblingNames = new Set(
      (entriesByPath[parentDir] ?? [])
        .filter((sibling) => sibling.path !== file.path)
        .map((sibling) => sibling.name),
    );
    const nextName = await promptDialog({
      title: `重命名 ${file.type === "directory" ? "文件夹" : "文件"}`,
      description: `位于 ${getDisplayPath(parentDir)}`,
      defaultValue: file.name,
      placeholder: "新名称",
      confirmLabel: "重命名",
      autoSelect: file.type === "directory" ? "all" : "stem",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "名称不能为空";
        if (trimmed === file.name) return null;
        if (trimmed.includes("/")) return "名称不能包含 /";
        if (trimmed === "." || trimmed === "..") return "名称无效";
        if (siblingNames.has(trimmed)) return "该名称已存在";
        return null;
      },
    });
    if (!nextName) return;
    const trimmed = nextName.trim();
    if (trimmed === file.name) return;
    run(async () => {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourcePath: file.path,
            targetDir: parentDir,
            targetName: trimmed,
          }),
        }),
      );
      toast.success("已重命名");
      await refreshTree(parentDir);
    });
  }

  async function deleteItems(items: FileInfo[]) {
    const parents = items.map((item) => parentPath(item.path));
    for (const file of items) {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: file.path }),
        }),
      );
    }
    setSelectedPaths(new Set());
    toast.success(items.length === 1 ? "已删除" : `已删除 ${items.length} 项`);
    await refreshTree(...parents);
  }

  function buildNameValidator(parentDir: string) {
    const siblings = new Set((entriesByPath[parentDir] ?? []).map((file) => file.name));
    return (value: string): string | null => {
      if (!value) return "名称不能为空";
      if (value.includes("/")) return "名称不能包含 /";
      if (value === "." || value === "..") return "名称无效";
      if (siblings.has(value)) return "该名称已存在";
      return null;
    };
  }

  async function handleCreateFolder(parentDir: string) {
    const name = await promptDialog({
      title: "新建文件夹",
      description: `位于 ${getDisplayPath(parentDir)}`,
      placeholder: "文件夹名称",
      confirmLabel: "创建",
      validate: buildNameValidator(parentDir),
    });
    if (!name) return;
    run(async () => {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/mkdir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `${parentDir.replace(/\/+$/, "")}/${name}` }),
        }),
      );
      if (parentDir !== rootPath) {
        setExpandedPaths((previous) => new Set(previous).add(parentDir));
      }
      await refreshTree(parentDir);
    });
  }

  async function handleCreateFile(parentDir: string) {
    const name = await promptDialog({
      title: "新建文件",
      description: `位于 ${getDisplayPath(parentDir)}`,
      placeholder: "文件名（含扩展名）",
      confirmLabel: "创建",
      validate: buildNameValidator(parentDir),
    });
    if (!name) return;
    run(async () => {
      await parseJson<{ success: boolean }>(
        await fetch("/v1/users/me/files/touch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `${parentDir.replace(/\/+$/, "")}/${name}` }),
        }),
      );
      if (parentDir !== rootPath) {
        setExpandedPaths((previous) => new Set(previous).add(parentDir));
      }
      await refreshTree(parentDir);
    });
  }

  async function copyDisplayPath(file: FileInfo) {
    try {
      await copyText(getDisplayPath(file.path));
      toast.success("路径已复制");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "复制失败");
    }
  }

  async function confirmDelete(file: FileInfo) {
    const isDir = file.type === "directory";
    const ok = await confirmDialog({
      title: `删除${isDir ? "文件夹" : "文件"} ${file.name}`,
      description: isDir
        ? "该文件夹及其全部子内容会被删除，且无法恢复。"
        : "该文件会被删除，且无法恢复。",
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!ok) return;
    run(() => deleteItems([file]));
  }

  async function confirmBulkDelete(items: FileInfo[]) {
    const dirCount = items.filter((item) => item.type === "directory").length;
    const preview = items.slice(0, 5).map((item) => item.name);
    const moreCount = Math.max(0, items.length - preview.length);
    const description = (
      <>
        <div>将删除以下 {items.length} 项，且无法恢复：</div>
        <ul>
          {preview.map((name) => (
            <li key={name}>{name}</li>
          ))}
          {moreCount > 0 ? <li>及其他 {moreCount} 项…</li> : null}
        </ul>
        {dirCount > 0 ? (
          <div>⚠️ 其中包含 {dirCount} 个文件夹，将递归删除全部子内容。</div>
        ) : null}
      </>
    );
    const ok = await confirmDialog({
      title: `删除 ${items.length} 项`,
      description,
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!ok) return;
    run(() => deleteItems(items));
  }

  function buildContextMenuItems(): FileContextMenuItem[] {
    if (!contextMenu) return [];
    if (contextMenu.target === "blank") {
      const parentDir = contextMenu.parentPath;
      return [
        ...(fileClipboard ? [
          {
            label: "粘贴到此处",
            disabled: !canPasteTo(parentDir),
            onSelect: () => run(() => pasteItems(parentDir)),
          },
          { divider: true as const },
        ] : []),
        { label: "新建文件", icon: <IconFilePlus />, onSelect: () => handleCreateFile(parentDir) },
        { label: "新建文件夹", icon: <IconFolderPlus />, onSelect: () => handleCreateFolder(parentDir) },
        { divider: true },
        { label: "上传文件", icon: <IconFileUp />, onSelect: () => fileInputRef.current?.click() },
        { label: "上传文件夹", icon: <IconFolderUp />, onSelect: () => folderInputRef.current?.click() },
      ];
    }
    const file = contextMenu.file;
    const isDir = file.type === "directory";
    const items: FileContextMenuItem[] = [];
    if (isDir) {
      items.push(
        {
          label: "打开",
          icon: <IconFolder />,
          onSelect: () => toggleDirectory(file),
        },
        { divider: true },
        { label: "新建文件", icon: <IconFilePlus />, onSelect: () => handleCreateFile(file.path) },
        { label: "新建文件夹", icon: <IconFolderPlus />, onSelect: () => handleCreateFolder(file.path) },
        { divider: true },
      );
    } else if (isPreviewable(file.name)) {
      items.push(
        {
          label: "打开",
          icon: <IconEye />,
          onSelect: () => setPreviewItem(file),
        },
        { divider: true },
      );
    }
    items.push(
      { label: "重命名", icon: <IconEdit />, onSelect: () => void startRename(file) },
      { label: "复制", icon: <IconCopy />, onSelect: () => copyOrCutItems(selectedPaths.has(file.path) ? selectedFiles : [file], "copy") },
      { label: "剪切", icon: <IconScissors />, onSelect: () => copyOrCutItems(selectedPaths.has(file.path) ? selectedFiles : [file], "cut") },
      { label: "复制相对路径", icon: <IconCopy />, onSelect: () => void copyDisplayPath(file) },
      {
        label: "下载",
        icon: <IconDownload />,
        onSelect: () => {
          window.location.href = `${downloadBase}${encodeURIComponent(file.path)}`;
        },
      },
      { divider: true },
      { label: "删除", icon: <IconTrash />, danger: true, onSelect: () => confirmDelete(file) },
    );
    return items;
  }

  function openRowContextMenu(event: ReactMouseEvent, file: FileInfo) {
    event.preventDefault();
    event.stopPropagation();
    setFocusedPath(file.path);
    setContextMenu({ position: { x: event.clientX, y: event.clientY }, target: "row", file });
  }

  function openBlankContextMenu(event: ReactMouseEvent, parentDir: string) {
    event.preventDefault();
    setContextMenu({ position: { x: event.clientX, y: event.clientY }, target: "blank", parentPath: parentDir });
  }

  async function uploadFiles(
    files: Array<{ file: File; targetPath: string; filename: string }>,
    doneText: string,
    refreshPath = currentPath,
  ) {
    const items = files.map((item, index) => ({
      id: `${Date.now()}-${index}-${item.filename}`,
      name: item.filename,
      progress: 0,
      status: "uploading" as const,
    }));
    uploadStore.add(items);

    let failedCount = 0;
    let cursor = 0;
    const concurrency = Math.min(4, files.length);

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= files.length) return;
        const item = files[index];
        const id = items[index].id;
        try {
          await uploadFile(item.targetPath, item.file, item.filename, (progress) => {
            uploadStore.update(id, { progress });
          });
          uploadStore.update(id, { progress: 100, status: "done" });
        } catch (error) {
          failedCount += 1;
          uploadStore.update(id, {
            status: "error",
            error: error instanceof Error ? error.message : "上传失败",
          });
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (failedCount > 0) {
      toast.error(`部分文件上传失败（${failedCount}/${files.length}）`);
    } else {
      toast.success(doneText);
    }
    const uploadDirs = Array.from(new Set(files.map((f) => f.targetPath)));
    await refreshTree(refreshPath, ...uploadDirs);
  }

  function focusRow(path: string) {
    setFocusedPath(path);
    requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector<HTMLElement>(
        `[data-file-path="${CSS.escape(path)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      const items = selectedFiles.length > 0
        ? selectedFiles
        : focusedPath
          ? visibleFiles.filter((file) => file.path === focusedPath)
          : [];
      if (key === "c" || key === "x") {
        event.preventDefault();
        copyOrCutItems(items, key === "c" ? "copy" : "cut");
        return;
      }
      if (key === "v" && fileClipboard) {
        event.preventDefault();
        run(() => pasteItems(currentPath));
        return;
      }
    }
    const rows = visibleRows;
    if (rows.length === 0) return;
    const idx = focusedPath
      ? rows.findIndex((r) => r.file.path === focusedPath)
      : -1;
    const current = idx >= 0 ? rows[idx].file : null;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = rows[Math.min(rows.length - 1, idx + 1)] ?? rows[0];
      focusRow(next.file.path);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = rows[Math.max(0, idx - 1)] ?? rows[0];
      focusRow(next.file.path);
      return;
    }
    if (!current) {
      if (event.key === "Enter" || event.key === "ArrowRight") {
        event.preventDefault();
        focusRow(rows[0].file.path);
      }
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (current.type === "directory") toggleDirectory(current);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (canGoUp) run(() => load(parentPath(currentPath)));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (current.type === "directory") {
        toggleDirectory(current);
      } else {
        setPreviewItem(current);
      }
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      if (canGoUp) run(() => load(parentPath(currentPath)));
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      void confirmDelete(current);
      return;
    }
  }

  function getDragItems(file: FileInfo) {
    if (selectedPaths.has(file.path)) {
      return selectedFiles.length > 0 ? selectedFiles : [file];
    }
    return [file];
  }

  function startFileDrag(event: DragEvent<HTMLDivElement>, file: FileInfo) {
    const items = getDragItems(file);
    const paths = items.map((item) => item.path);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(fileDragMimeType, JSON.stringify(paths));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
    setDraggedPaths(paths);
  }

  function canDropInternalItems(targetDir: string, items: FileInfo[]) {
    return items.every((item) => item.path !== targetDir && !(item.type === "directory" && isInsidePath(targetDir, item.path)));
  }

  function handleDragOver(
    event: DragEvent,
    targetDir: string,
    options: { allowMove?: boolean } = {},
  ) {
    const allowMove = options.allowMove ?? true;
    const isInternalDrag = draggedPaths.length > 0;
    if (isInternalDrag && !allowMove) {
      // Reject internal-drag drops here so that "loose" drops on container
      // padding don't silently move files to the current folder.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = isInternalDrag ? "move" : "copy";
    setDragOverPath(targetDir);
  }

  function handleDragLeave(event: DragEvent, targetDir: string) {
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOverPath((previous) => (previous === targetDir ? null : previous));
  }

  function handleDrop(
    event: DragEvent,
    targetDir: string,
    options: { allowMove?: boolean } = {},
  ) {
    const allowMove = options.allowMove ?? true;
    event.preventDefault();
    event.stopPropagation();
    setDragOverPath(null);

    const rawPaths = event.dataTransfer.getData(fileDragMimeType);
    if (rawPaths) {
      setDraggedPaths([]);
      if (!allowMove) return;
      run(async () => {
        const paths = JSON.parse(rawPaths) as string[];
        const items = paths
          .map((path) => fileByPath.get(path))
          .filter((file): file is FileInfo => Boolean(file));
        if (items.length === 0) return;
        if (!canDropInternalItems(targetDir, items)) {
          throw new Error("不能移动到自身或子目录");
        }
        await moveSelectedItems(items, targetDir);
      });
      return;
    }

    setDraggedPaths([]);
    if (event.dataTransfer.files.length === 0 && event.dataTransfer.items.length === 0) return;
    run(async () => {
      const files = await collectDroppedFiles(event.dataTransfer, targetDir);
      if (files.length === 0) return;
      await uploadFiles(files, files.length === 1 ? "文件已上传" : `已上传 ${files.length} 个文件`, targetDir);
    });
  }

  return (
    <article className={compact ? "panel file-manager file-manager-compact" : "panel file-manager file-manager-with-sidebar"}>
      {!compact ? (
        <nav className="file-sidebar" aria-label="文件分类">
          {([
            ["all", "全部文件"],
            ["uploads", "对话上传文件"],
            ["outputs", "生成文件"],
          ] as Array<[FileView, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={view === key ? "is-active" : ""}
              aria-current={view === key ? "page" : undefined}
              onClick={() => switchView(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="file-manager-main">
      <div className="panel-header file-manager-header">
        <div className="file-manager-pathbar">
          <button
            className="file-manager-up"
            type="button"
            disabled={!canGoUp || isPending}
            onClick={() => run(() => load(parentPath(currentPath)))}
            title="返回上一级目录"
            aria-label="返回上一级目录"
          >
            <IconArrowUp />
          </button>
          <div className="file-manager-pathbar-text">
            <nav
              className="file-breadcrumb"
              aria-label="目录路径"
              title={getDisplayPath(currentPath)}
            >
              {pathSegments(currentPath)
                .filter((segment) => isInsidePath(segment.path, scopeRoot))
                .map((segment) => (segment.path === scopeRoot && scope ? { ...segment, label: scope.label } : segment))
                .map((segment, idx, all) => {
                const isLast = idx === all.length - 1;
                const dropOver = dragOverPath === segment.path;
                return (
                  <span className="file-breadcrumb-item" key={segment.path}>
                    {idx > 0 ? (
                      <span className="file-breadcrumb-sep" aria-hidden="true">/</span>
                    ) : null}
                    <button
                      type="button"
                      className={`file-breadcrumb-segment${
                        isLast ? " file-breadcrumb-segment-current" : ""
                      }${dropOver ? " file-breadcrumb-segment-drop" : ""}`}
                      aria-current={isLast ? "page" : undefined}
                      disabled={isPending}
                      onClick={() => {
                        if (segment.path !== currentPath) {
                          run(() => load(segment.path));
                        }
                      }}
                      onDragOver={(event) => handleDragOver(event, segment.path)}
                      onDragLeave={(event) => handleDragLeave(event, segment.path)}
                      onDrop={(event) => handleDrop(event, segment.path)}
                      onContextMenu={(event) => openBlankContextMenu(event, segment.path)}
                      title={getDisplayPath(segment.path)}
                    >
                      {segment.label}
                    </button>
                  </span>
                );
              })}
            </nav>
          </div>
        </div>
        <div className="inline-actions file-manager-toolbar">
          {fileClipboard ? (
            <button
              className="button-secondary file-manager-action"
              type="button"
              disabled={isPending || !canPasteTo(currentPath)}
              onClick={() => run(() => pasteItems(currentPath))}
              title={`粘贴 ${fileClipboard.items.length} 项到当前目录`}
            >
              粘贴 {fileClipboard.items.length} 项
            </button>
          ) : null}
          <button
            className="button file-manager-action"
            type="button"
            disabled={isPending}
            onClick={() => fileInputRef.current?.click()}
            title="上传文件"
          >
            <IconFileUp />
            <span>上传文件</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (selected.length === 0) return;
              run(() =>
                uploadFiles(
                  selected.map((file) => ({ file, targetPath: currentPath, filename: file.name })),
                  "文件已上传",
                ),
              );
            }}
          />
          <div className="file-new-menu">
            <button
              className="button-secondary file-manager-action"
              type="button"
              disabled={isPending}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen((value) => !value)}
              onBlur={(event) => {
                if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) {
                  setNewMenuOpen(false);
                }
              }}
              title="新建"
            >
              <span aria-hidden="true">+</span>
              <span>新建</span>
            </button>
            {newMenuOpen ? (
              <div className="file-new-menu-list" role="menu">
                <button type="button" role="menuitem" onClick={() => { setNewMenuOpen(false); void handleCreateFile(currentPath); }}>
                  <IconFilePlus /> 新建文件
                </button>
                <button type="button" role="menuitem" onClick={() => { setNewMenuOpen(false); void handleCreateFolder(currentPath); }}>
                  <IconFolderPlus /> 新建文件夹
                </button>
              </div>
            ) : null}
          </div>
          <button
            className="button-secondary file-manager-action"
            type="button"
            disabled={isPending}
            onClick={() => folderInputRef.current?.click()}
            title="上传文件夹"
          >
            <IconFolderUp />
            <span>上传文件夹</span>
          </button>
          <input
            ref={folderInputRef}
            type="file"
            hidden
            multiple
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (selected.length === 0) return;
              run(() =>
                uploadFiles(
                  selected.map((file) => {
                    const relativePath = file.webkitRelativePath || file.name;
                    const parts = relativePath.split("/").filter(Boolean);
                    const filename = parts.pop() ?? file.name;
                    const relativeDir = parts.join("/");
                    return {
                      file,
                      filename,
                      targetPath: relativeDir ? `${currentPath.replace(/\/+$/, "")}/${relativeDir}` : currentPath,
                    };
                  }),
                  "文件夹已上传",
                ),
              );
            }}
          />
          <button
            className={`button-secondary file-manager-action file-manager-hidden${
              showHidden ? " is-active" : ""
            }`}
            type="button"
            disabled={isPending}
            onClick={() => setShowHidden((value) => !value)}
            title={showHidden ? "隐藏以 . 开头的文件" : "显示以 . 开头的隐藏文件"}
            aria-pressed={showHidden}
          >
            <IconEye />
            <span>隐藏文件</span>
          </button>
          <button
            className="file-icon-button"
            type="button"
            disabled={isPending}
            onClick={() => run(() => refreshTree(currentPath))}
            title="刷新"
            aria-label="刷新文件列表"
          >
            <IconRefresh />
          </button>
        </div>
      </div>

      {!compact ? (
        <div className="file-view-bar">
          <input
            className="field-input file-search-input"
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索已加载的文件名"
            aria-label="搜索文件"
          />
        </div>
      ) : null}

      <div
        ref={treeRef}
        className={`file-tree${dragOverPath === currentPath ? " file-tree-drop-target" : ""}${selectedPaths.size > 0 ? " file-tree-selecting" : ""}`}
        role="tree"
        aria-label="工作区文件树"
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onDragOver={(event) => handleDragOver(event, currentPath, { allowMove: false })}
        onDragLeave={(event) => handleDragLeave(event, currentPath)}
        onDrop={(event) => handleDrop(event, currentPath, { allowMove: false })}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            openBlankContextMenu(event, currentPath);
          }
        }}
      >
        {!rootLoaded ? (
          <div className="skeleton-list" role="status" aria-label="正在加载文件">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={28} width={`${65 + ((i * 13) % 30)}%`} />
            ))}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="file-empty">
            <span className="file-empty-icon" aria-hidden="true"><IconFolder /></span>
            <strong>{isFlatView ? "没有匹配的文件" : "这个文件夹是空的"}</strong>
            <span>{isFlatView ? "换个关键词试试。" : "把本机文件拖到这里，或点右上角「上传文件」。"}</span>
          </div>
        ) : (
          <>
            <div className="file-tree-row file-tree-row-head">
              {!compact ? (
                <>
                  <label className="file-check">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="选择全部可见文件" />
                  </label>
                  {selectedFiles.length > 0 ? (
                    <div className="file-head-bulk">
                      <strong>已选 {selectedFiles.length} 项</strong>
                      <button type="button" disabled={isPending} onClick={() => copyOrCutItems(selectedFiles, "copy")}>复制</button>
                      <button type="button" disabled={isPending} onClick={() => copyOrCutItems(selectedFiles, "cut")}><IconScissors />剪切</button>
                      <button type="button" disabled={isPending} onClick={() => setMoveItems(selectedFiles)}>移动</button>
                      <button type="button" disabled={isPending} onClick={() => downloadItems(selectedFiles)}>下载</button>
                      <button type="button" className="is-danger" disabled={isPending} onClick={() => void confirmBulkDelete(selectedFiles)}>删除</button>
                      <button type="button" onClick={() => setSelectedPaths(new Set())}>取消选择</button>
                    </div>
                  ) : (
                    <>
                      <span className="file-tree-head-label">名称</span>
                      <span className="file-tree-head-count">{visibleRows.length} 项</span>
                    </>
                  )}
                </>
              ) : null}
            </div>
            {visibleRows.map(({ file, level }) => {
              const isDirectory = file.type === "directory";
              const isSelected = focusedPath === file.path;
              const isChecked = selectedPaths.has(file.path);

              return (
                <div
                  className={`file-tree-row${isSelected ? " file-tree-row-selected" : ""}${isChecked ? " file-tree-row-checked" : ""}${fileClipboard?.mode === "cut" && fileClipboard.items.some((item) => item.path === file.path) ? " file-tree-row-cut" : ""}${dragOverPath === file.path ? " file-tree-row-drop-target" : ""}`}
                  key={file.path}
                  data-file-path={file.path}
                  role="treeitem"
                  draggable
                  onDragStart={(event) => startFileDrag(event, file)}
                  onDragEnd={() => {
                    setDraggedPaths([]);
                    setDragOverPath(null);
                  }}
                  onDragOver={isDirectory ? (event) => handleDragOver(event, file.path) : undefined}
                  onDragLeave={isDirectory ? (event) => handleDragLeave(event, file.path) : undefined}
                  onDrop={isDirectory ? (event) => handleDrop(event, file.path) : undefined}
                  onDoubleClick={() => {
                    setFocusedPath(file.path);
                    if (isDirectory) {
                      toggleDirectory(file);
                      return;
                    }
                    // 双击始终「打开」：可预览类型直接展示，不可预览类型在弹窗内
                    // 给出明确的下载入口，避免静默下载这种不可预测的行为。
                    setPreviewItem(file);
                  }}
                  onContextMenu={(event) => openRowContextMenu(event, file)}
                  style={{ "--file-level": level } as CSSProperties & Record<"--file-level", number>}
                >
                  {!compact ? (
                    <label className="file-check">
                      <input type="checkbox" checked={isChecked} onChange={() => toggleSelected(file.path)} aria-label={`选择 ${file.name}`} />
                    </label>
                  ) : null}
                  <div className="file-tree-main">
                    <button
                      className="file-name file-tree-name"
                      type="button"
                      disabled={isPending}
                      onClick={(event) => {
                        const target = event.target as HTMLElement;
                        void target;
                        if (isDirectory) {
                          toggleDirectory(file);
                          return;
                        }
                        setFocusedPath(file.path);
                      }}
                      title={isDirectory ? `打开 ${file.name}` : `双击打开 ${file.name}`}
                    >
                      <span className={`file-icon${isDirectory ? " file-icon-folder" : ""}`} aria-hidden="true">
                        {isDirectory ? <IconFolder /> : getFileIcon(file.name)}
                      </span>
                      <span className="file-name-text">{file.name}</span>
                    </button>
                    {!compact ? (
                      <span className="file-tree-meta">
                        <span className="file-tree-type">{isDirectory ? "文件夹" : formatSize(file.size)}</span>
                        {isFlatView ? <span className="file-tree-date">{getDisplayPath(parentPath(file.path))}</span> : null}
                        <span className="file-tree-sep" aria-hidden="true">·</span>
                        <span className="file-tree-date">{formatDate(file.modified_at)}</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="file-row-actions">
                    {!isDirectory ? (
                      isPreviewable(file.name) ? (
                        <button
                          type="button"
                          className="file-row-quick-action"
                          draggable={false}
                          title={`预览 ${file.name}`}
                          aria-label={`预览 ${file.name}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setFocusedPath(file.path);
                            setPreviewItem(file);
                          }}
                        >
                          <IconEye />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="file-row-quick-action"
                          draggable={false}
                          title={`下载 ${file.name}`}
                          aria-label={`下载 ${file.name}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            window.location.href = `${downloadBase}${encodeURIComponent(file.path)}`;
                          }}
                        >
                          <IconDownload />
                        </button>
                      )
                    ) : null}
                    <button
                      type="button"
                      className="file-row-quick-action"
                      draggable={false}
                      title="复制相对路径"
                      aria-label={`复制 ${file.name} 的相对路径`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void copyDisplayPath(file);
                      }}
                    >
                      <IconCopy />
                    </button>
                    <button
                      type="button"
                      className="file-row-quick-action"
                      draggable={false}
                      title="更多操作"
                      aria-label={`${file.name} 的更多操作`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setFocusedPath(file.path);
                        setContextMenu({ position: { x: rect.left, y: rect.bottom + 4 }, target: "row", file });
                      }}
                    >
                      ⋯
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="file-manager-footer">
        <div className="note">
          这里的文件会挂载到小信运维助手容器内。可以拖拽本机文件或文件夹到目标目录，也可以拖动列表内项目整理目录。
        </div>

        {!compact ? (
          <div
            className={`file-dropzone${dragOverPath === "__dropzone__" ? " is-over" : ""}`}
            onDragOver={(event) => {
              if (draggedPaths.length > 0) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragOverPath("__dropzone__");
            }}
            onDragLeave={() => setDragOverPath((previous) => (previous === "__dropzone__" ? null : previous))}
            onDrop={(event) => handleDrop(event, currentPath, { allowMove: false })}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click();
            }}
          >
            拖拽文件到此处，快速上传到 {getDisplayPath(currentPath)}
          </div>
        ) : null}
      </div>
      </div>

      {moveItems ? (
        <div className="file-dialog-backdrop" role="presentation">
          <form
            className="file-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const targetDir = String(form.get("targetDir") || rootPath);
              run(() => moveSelectedItems(moveItems, targetDir));
            }}
          >
            <div className="file-dialog-title">移动 {moveItems.length} 项</div>
            <select className="field-input" name="targetDir" defaultValue={currentPath}>
              {directoryOptions
                .filter((option) => !moveItems.some((item) => item.type === "directory" && isInsidePath(option.path, item.path)))
                .map((option) => (
                  <option key={option.path} value={option.path}>{option.label}</option>
                ))}
            </select>
            <div className="inline-actions file-dialog-actions">
              <button className="button" type="submit" disabled={isPending}>移动</button>
              <button className="button-secondary" type="button" onClick={() => setMoveItems(null)}>取消</button>
            </div>
          </form>
        </div>
      ) : null}

      {previewItem ? (
        <FilePreviewModal
          filename={previewItem.name}
          workspacePath={previewItem.path}
          apiBase={apiBase}
          onClose={() => setPreviewItem(null)}
          onSaved={() => {
            toast.success("文件已保存");
            void refreshTree(currentPath);
          }}
          siblings={visibleRows
            .filter((r) => r.file.type === "file" && isPreviewable(r.file.name))
            .map((r) => ({ name: r.file.name, path: r.file.path }))}
          onNavigate={(target) => {
            const next = visibleRows.find((r) => r.file.path === target.path);
            if (next) {
              setPreviewItem(next.file);
              setFocusedPath(next.file.path);
            }
          }}
        />
      ) : null}

      <FileContextMenu
        position={contextMenu?.position ?? null}
        items={buildContextMenuItems()}
        onClose={() => setContextMenu(null)}
      />
    </article>
  );
}
