"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { confirm as confirmDialog } from "./ui/dialog-host";
import { toast } from "@/lib/toast";

const API_BASE = "/v1/admin/opencode/instructions";

interface GlobalInstructionsSettings {
  content: string;
  maxBytes: number;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    return data.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export function GlobalInstructionsManager() {
  const [loaded, setLoaded] = useState(false);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [maxBytes, setMaxBytes] = useState(100 * 1024);
  const [saving, setSaving] = useState(false);
  const byteLength = useMemo(() => new TextEncoder().encode(content).byteLength, [content]);
  const dirty = content !== savedContent;

  const load = useCallback(async () => {
    try {
      const response = await fetch(API_BASE, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as GlobalInstructionsSettings;
      setContent(data.content);
      setSavedContent(data.content);
      setMaxBytes(data.maxBytes);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载全局规则失败");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!content.trim() && savedContent.trim()) {
      const confirmed = await confirmDialog({
        title: "清空全局规则？",
        description: "保存后将移除所有用户运行环境中的全局 AGENTS.md；各智能体自己的 agent.md 不受影响。",
        confirmLabel: "清空并保存",
        variant: "danger",
      });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const response = await fetch(API_BASE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as GlobalInstructionsSettings;
      setContent(data.content);
      setSavedContent(data.content);
      setMaxBytes(data.maxBytes);
      toast.success("全局规则已保存，用户运行环境正在更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存全局规则失败");
    } finally {
      setSaving(false);
    }
  }, [content, savedContent]);

  if (!loaded) return <div className="opshelper-skill-empty">加载中…</div>;

  return (
    <div className="global-instructions-manager">
      <div className="opshelper-skill-files-hint">
        这里的规则会应用于所有用户和智能体。
        保存后，正在执行任务的用户会先完成当前任务，随后系统逐个重建运行环境。
      </div>
      <label className="field global-instructions-field">
        <span className="field-label">平台通用规则</span>
        <textarea
          className="field-textarea mono global-instructions-editor"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={"# 平台通用规则\n\n- 当前工作目录和用户持久化文件根目录为 /workspace。\n- 如果任务明确指定输出目录，必须优先使用该目录。"}
          spellCheck={false}
        />
      </label>
      <div className="global-instructions-footer">
        <span className={`global-instructions-count ${byteLength > maxBytes ? "danger-text" : "muted"}`}>
          {byteLength.toLocaleString("zh-CN")} / {maxBytes.toLocaleString("zh-CN")} 字节
        </span>
        <div className="inline-actions">
          <button
            className="button-secondary"
            type="button"
            disabled={!dirty || saving}
            onClick={() => {
              setContent(savedContent);
            }}
          >
            撤销修改
          </button>
          <button
            className="button"
            type="button"
            disabled={!dirty || saving || byteLength > maxBytes}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存并应用"}
          </button>
        </div>
      </div>
    </div>
  );
}
