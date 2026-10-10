export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modified_at: number;
}

export interface FileTreeRow {
  file: FileInfo;
  level: number;
}

export interface DroppedFile {
  file: File;
  targetPath: string;
  filename: string;
}

export interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

export interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void;
}

export interface FileSystemDirectoryReaderLike {
  readEntries: (
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
}

export interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader: () => FileSystemDirectoryReaderLike;
}

export interface DataTransferItemWithEntry {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

// The opencode working directory (/workspace) — the user's shared workspace all
// agents operate in, and the root the gateway's file API is scoped to.
export const rootPath = "/workspace";
export const rootLabel = "工作目录";
export const fileDragMimeType = "application/x-opshelper-file-paths";
export const expandedPathsStorageKey = "opshelper.fileManager.expandedPaths";

export function readPersistedExpandedPaths(): Set<string> {
  const fallback = new Set([rootPath]);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(expandedPathsStorageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const next = new Set<string>([rootPath]);
    for (const value of parsed) {
      if (typeof value === "string" && value.startsWith(rootPath)) next.add(value);
    }
    return next;
  } catch {
    return fallback;
  }
}

export function parentPath(path: string) {
  if (!path || path === rootPath) return rootPath;
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= rootPath.length) return rootPath;
  return trimmed.slice(0, index);
}

export function formatSize(size: number | null) {
  if (size === null) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(seconds: number) {
  // 紧凑格式 YYYY/MM/DD HH:mm，与工作区其它时间显示一致（去掉秒与冗长的本地化串）。
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function getDisplayPath(path: string) {
  if (path === rootPath) return rootLabel;
  return `${rootLabel}/${path.slice(rootPath.length).replace(/^\/+/, "")}`;
}

export function pathSegments(path: string): Array<{ label: string; path: string }> {
  const segments: Array<{ label: string; path: string }> = [
    { label: rootLabel, path: rootPath },
  ];
  if (path === rootPath) return segments;
  const rest = path.slice(rootPath.length).replace(/^\/+/, "");
  const parts = rest.split("/").filter(Boolean);
  let acc = rootPath;
  for (const part of parts) {
    acc = `${acc}/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

export function isInsidePath(path: string, possibleParent: string) {
  return path === possibleParent || path.startsWith(`${possibleParent}/`);
}

export function joinWorkspacePath(basePath: string, relativePath: string) {
  const cleanBase = basePath.replace(/\/+$/, "");
  const cleanRelative = relativePath.replace(/^\/+|\/+$/g, "");
  return cleanRelative ? `${cleanBase}/${cleanRelative}` : cleanBase;
}

export async function parseJson<T>(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "请求失败");
  }
  return payload as T;
}

export function uploadFile(
  targetPath: string,
  file: File,
  filename: string,
  onProgress: (progress: number) => void,
) {
  return new Promise<{ success: boolean; path: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append("path", targetPath);
    form.append("file", file, filename);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      let payload: unknown = null;
      try {
        payload = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        payload = null;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(payload as { success: boolean; path: string });
        return;
      }
      reject(new Error((payload as { message?: string } | null)?.message ?? "上传失败"));
    };
    request.onerror = () => reject(new Error("上传失败"));
    request.open("POST", "/v1/users/me/files/upload");
    request.send(form);
  });
}

export function readFileEntry(entry: FileSystemFileEntryLike) {
  return new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

export function readDirectoryEntries(reader: FileSystemDirectoryReaderLike) {
  return new Promise<FileSystemEntryLike[]>((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

export async function collectEntryFiles(
  entry: FileSystemEntryLike,
  targetPath: string,
  relativeDir = "",
): Promise<DroppedFile[]> {
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntryLike);
    return [{
      file,
      targetPath: joinWorkspacePath(targetPath, relativeDir),
      filename: file.name || entry.name,
    }];
  }

  if (!entry.isDirectory) return [];

  const directory = entry as FileSystemDirectoryEntryLike;
  const reader = directory.createReader();
  const files: DroppedFile[] = [];
  let batch = await readDirectoryEntries(reader);

  while (batch.length > 0) {
    for (const child of batch) {
      files.push(
        ...(await collectEntryFiles(
          child,
          targetPath,
          joinWorkspacePath(relativeDir, entry.name),
        )),
      );
    }
    batch = await readDirectoryEntries(reader);
  }

  return files;
}

export async function collectDroppedFiles(dataTransfer: DataTransfer, targetPath: string): Promise<DroppedFile[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => (item as DataTransferItemWithEntry).webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntryLike => Boolean(entry));

  if (entries.length > 0) {
    const nestedFiles = await Promise.all(entries.map((entry) => collectEntryFiles(entry, targetPath)));
    return nestedFiles.flat();
  }

  return Array.from(dataTransfer.files ?? []).map((file) => ({
    file,
    targetPath,
    filename: file.name,
  }));
}

function copyTextFallback(text: string) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.width = "1px";
  textArea.style.height = "1px";
  textArea.style.opacity = "0";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back below for browsers that expose Clipboard API but deny writes.
    }
  }

  if (!copyTextFallback(text)) {
    throw new Error("浏览器拒绝复制，请手动复制路径");
  }
}
