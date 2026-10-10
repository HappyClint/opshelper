// Shared chat composer types.

// A file queued on the composer to send with the next prompt. Composer uploads
// start as "uploading"; `@` mentions of existing workspace files are "ready"
// immediately. Only "ready" attachments are forwarded to opencode.
export interface Attachment {
  id: string;
  path: string; // absolute workspace path inside the container
  filename: string;
  mime: string;
  status: "uploading" | "ready" | "error";
  source: "upload" | "mention";
}

// A workspace file surfaced by the `@` autocomplete.
export interface MentionFile {
  rel: string; // path relative to the workspace root (display)
  path: string; // absolute path inside the container
  filename: string;
}
