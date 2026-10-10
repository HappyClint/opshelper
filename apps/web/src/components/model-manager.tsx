"use client";

import { useCallback, useEffect, useState } from "react";

import { confirm as confirmDialog } from "./ui/dialog-host";
import { toast } from "@/lib/toast";

const API_BASE = "/v1/admin/opencode/models";
// 与后端 MODEL_ID_RE 一致：厂商模型 id 常见字符（点/冒号/斜杠），不含空白。
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

interface ModelRow {
  /** 稳定的行 key（新增行没有天然 id，用它驱动 React 列表）。 */
  key: string;
  id: string;
  name: string;
}

interface ModelSettings {
  baseURL: string;
  apiKey: string;
  models: { id: string; name: string }[];
  defaultModel: string;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    return data.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

let rowSeq = 0;
function newRowKey(): string {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
}

/**
 * 模型管理：维护共享配置里唯一的 openai 兼容自定义模型组（provider.custom）——
 * 组级 baseURL + API Key，组内若干模型（id + 显示名 + 默认标记）。整组覆盖式
 * 保存。后端会冻结新任务，并逐个重建受影响的用户运行环境。
 */
export function ModelManager({ onDirty }: { onDirty: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [defaultKey, setDefaultKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(API_BASE, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as ModelSettings;
      setBaseURL(data.baseURL);
      setApiKey(data.apiKey);
      const nextRows = data.models.map(
        (m): ModelRow => ({ key: newRowKey(), id: m.id, name: m.name }),
      );
      setRows(nextRows);
      setDefaultKey(
        nextRows.find((r) => r.id === data.defaultModel)?.key ?? null,
      );
      setLoaded(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载模型配置失败");
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = useCallback(
    (key: string, patch: Partial<Pick<ModelRow, "id" | "name">>) => {
      setRows((prev) =>
        prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const addRow = useCallback(() => {
    const row: ModelRow = { key: newRowKey(), id: "", name: "" };
    setRows((prev) => [...prev, row]);
    // 第一行自动成为默认模型，省一次点击。
    setDefaultKey((prev) => prev ?? row.key);
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((prev) => {
      const next = prev.filter((row) => row.key !== key);
      setDefaultKey((current) =>
        current === key ? (next[0]?.key ?? null) : current,
      );
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    const models = rows
      .map((row) => ({ ...row, id: row.id.trim(), name: row.name.trim() }))
      .filter((row) => row.id.length > 0 || row.name.length > 0);
    for (const row of models) {
      if (!MODEL_ID_RE.test(row.id)) {
        toast.error(
          `模型 ID「${row.id || "（空）"}」不合法：仅允许字母、数字与 . _ : / -，不含空白`,
        );
        return;
      }
    }
    if (new Set(models.map((m) => m.id)).size !== models.length) {
      toast.error("模型 ID 不能重复");
      return;
    }
    if (models.length > 0 && !/^https?:\/\//.test(baseURL.trim())) {
      toast.error("接口地址 (baseURL) 需以 http:// 或 https:// 开头");
      return;
    }
    const defaultModel =
      models.find((m) => m.key === defaultKey)?.id ?? models[0]?.id ?? "";
    if (models.length === 0) {
      const ok = await confirmDialog({
        title: "清空模型组？",
        description:
          "保存后将移除自定义模型组：聊天界面不再显示模型选择器，容器内也没有默认模型，重启后用户将无法对话，请尽快重新配置。",
        confirmLabel: "清空并保存",
        variant: "danger",
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const response = await fetch(API_BASE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: baseURL.trim(),
          apiKey: apiKey.trim(),
          models: models.map((m) => ({ id: m.id, name: m.name })),
          defaultModel,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("已保存");
      onDirty();
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [rows, baseURL, apiKey, defaultKey, load, onDirty]);

  if (!loaded) {
    return <div className="opshelper-skill-empty">加载中…</div>;
  }

  return (
    <div className="opshelper-skill-editor opshelper-model-manager">
      <div className="opshelper-skill-files-hint">
        所有模型共用同一个 OpenAI 兼容接口地址与 API
        Key，仅模型 ID 不同。保存后，正在执行任务的用户会先等待本次任务结束，
        空闲用户会直接更新配置；更新期间不能开始新任务。
      </div>

      <label className="opshelper-skill-field">
        <span>接口地址 (baseURL，OpenAI 兼容，通常以 /v1 结尾)</span>
        <input
          value={baseURL}
          placeholder="例如 https://dashscope.aliyuncs.com/compatible-mode/v1"
          onChange={(e) => setBaseURL(e.target.value)}
        />
      </label>

      <label className="opshelper-skill-field">
        <span>API Key（留空表示该接口无需鉴权）</span>
        <div className="opshelper-model-key-row">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="button"
            className="opshelper-skill-btn small"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </label>

      <div className="opshelper-skill-field">
        <span>模型列表（默认模型用于新用户与未手动切换的用户）</span>
        {rows.length === 0 ? (
          <div className="opshelper-skill-files-hint">
            还没有模型。点击「新增模型」添加第一个。
          </div>
        ) : (
          <div className="opshelper-model-rows">
            <div className="opshelper-model-row opshelper-model-row-head">
              <span className="opshelper-model-col-default">默认</span>
              <span className="opshelper-model-col-id">模型 ID（接口的 model 参数）</span>
              <span className="opshelper-model-col-name">显示名（用户在聊天界面看到的）</span>
              <span className="opshelper-model-col-actions" />
            </div>
            {rows.map((row, index) => (
              <div key={row.key} className="opshelper-model-row">
                <label className="opshelper-model-col-default">
                  <input
                    type="radio"
                    name="opshelper-default-model"
                    checked={defaultKey === row.key}
                    onChange={() => setDefaultKey(row.key)}
                    aria-label={`设为默认模型（第 ${index + 1} 行）`}
                  />
                  <span className="opshelper-model-mobile-label">默认模型</span>
                </label>
                <label className="opshelper-model-col-id">
                  <span className="opshelper-model-mobile-label">模型 ID</span>
                  <input
                    aria-label={`模型 ID（第 ${index + 1} 行）`}
                    value={row.id}
                    placeholder="例如 qwen-plus"
                    spellCheck={false}
                    onChange={(e) => updateRow(row.key, { id: e.target.value })}
                  />
                </label>
                <label className="opshelper-model-col-name">
                  <span className="opshelper-model-mobile-label">显示名</span>
                  <input
                    aria-label={`显示名（第 ${index + 1} 行）`}
                    value={row.name}
                    placeholder="留空使用模型 ID"
                    onChange={(e) => updateRow(row.key, { name: e.target.value })}
                  />
                </label>
                <span className="opshelper-model-col-actions">
                  <button
                    className="opshelper-skill-btn small danger"
                    onClick={() => removeRow(row.key)}
                  >
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="opshelper-skill-toolbar">
          <button className="opshelper-skill-btn small" onClick={addRow}>
            新增模型
          </button>
        </div>
      </div>

      <div className="opshelper-skill-editor-actions">
        <button
          className="opshelper-skill-btn primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
