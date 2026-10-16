"use client";

import type {
  AdminUsersSnapshot,
  AgentDetail,
  AgentSummary,
  UserAgentAssignmentsSnapshot,
} from "@opshelper/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  checkAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getUserAgentAssignments,
  importAgentSkillPackage,
  listAgents,
  reconcileUserAgentAssignments,
  replaceUserAgentAssignments,
  setAgentEnabled,
  updateAgent,
} from "@/lib/browser-api";
import { toast } from "@/lib/toast";
import {
  base64ByteLength,
  buildAgentFileTree,
  countLines,
  formatAgentFileSize,
  parseAgentReferences,
  removeAgentSkillReference,
  textByteLength,
  type AgentSkillGroup,
  type AgentTreeNode,
} from "@/lib/agent-directory";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { prompt as promptDialog } from "@/components/ui/dialog-host";
import { ModelManager } from "@/components/model-manager";
import { GlobalInstructionsManager } from "@/components/global-instructions-manager";
import { AgentMark } from "@/components/chat/assistant";
import {
  agentAssignmentLabel,
  agentCatalogCount,
  agentCheckView,
  agentEnabledView,
  agentModeView,
} from "@/lib/agent-status";
import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconTrash,
  getFileIcon,
} from "@/components/file-icons";
import { IconAlert, IconCheck, IconClose, IconSearch, IconSkill } from "@/components/chat/icons";

type Tab = "catalog" | "assignments" | "models" | "instructions";
type EditorMode = "view" | "create" | "edit";
type UserItem = AdminUsersSnapshot["users"][number];

const NEW_AGENT_TEMPLATE = `---
name: 新智能体
description: 说明这个智能体负责的运维范围
mode: all
---

你是一名运维智能体。先核对事实和影响范围，再执行变更。
`;

const EMPTY_MCP_CONFIGURATION = `{
  "example": {
    "type": "remote",
    "url": "https://mcp.example.com/mcp",
    "enabled": false,
    "oauth": false,
    "headers": {}
  }
}
`;

function addSkillReference(document: string, skillName: string) {
  const closing = document.indexOf("\n---", 4);
  if (closing < 0) return document;
  const frontmatter = document.slice(0, closing);
  if (new RegExp(`^\\s*-\\s+${skillName}\\s*$`, "m").test(frontmatter)) return document;
  const inline = /^(skills:\s*)(\[[^\n]*\])\s*$/m.exec(frontmatter);
  if (inline) {
    try {
      const values = JSON.parse(inline[2]) as unknown;
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
        const next = JSON.stringify([...values, skillName]);
        return document.replace(inline[0], `${inline[1]}${next}`);
      }
    } catch {
      return document;
    }
  }
  if (/^skills:\s*$/m.test(frontmatter)) {
    return document.replace(/^skills:\s*$/m, `skills:\n  - ${skillName}`);
  }
  return `${document.slice(0, closing)}\nskills:\n  - ${skillName}${document.slice(closing)}`;
}

const statusLabels = {
  draining: "等待当前任务",
  revoking: "正在撤销",
  applying: "正在装配",
  ready: "已就绪",
  frozen: "已冻结",
} as const;

function shortHash(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function agentFrontmatterScalar(document: string, key: "name" | "display_name" | "description") {
  const frontmatter = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(document)?.[1] ?? "";
  const value = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter)?.[1]?.trim() ?? "";
  try {
    return value.startsWith("\"") ? JSON.parse(value) as string : value;
  } catch {
    return value;
  }
}

function setAgentFrontmatterScalar(
  document: string,
  key: "name" | "display_name" | "description",
  value: string,
) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(document);
  if (!match) return document;
  const quoted = JSON.stringify(value);
  const field = new RegExp(`^${key}:\\s*.*$`, "m");
  const frontmatter = field.test(match[1])
    ? match[1].replace(field, `${key}: ${quoted}`)
    : `${match[1]}\n${key}: ${quoted}`;
  return `${document.slice(0, match.index)}---\n${frontmatter}\n---${document.slice(match.index + match[0].length)}`;
}

// 左侧目录树的一行文件：图标 + 文件名 + 二进制标记，缩进由深度决定。
function AgentTreeFile({
  path,
  label,
  depth,
  selected,
  binary,
  onSelect,
}: {
  path: string;
  label: string;
  depth: number;
  selected: boolean;
  binary: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      className={`agent-tree-file${selected ? " selected" : ""}`}
      style={{ "--agent-tree-depth": depth } as CSSProperties}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(path)}
    >
      <span className="agent-tree-icon">{getFileIcon(path)}</span>
      <span className="agent-tree-label" title={path}>{label}</span>
      {binary ? <span className="agent-tree-badge">二进制</span> : null}
    </button>
  );
}

/** 目录行徽标用的文件数：递归统计，不把子目录算成文件。 */
function countTreeFiles(nodes: AgentTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.children.length ? countTreeFiles(node.children) : 1),
    0,
  );
}

// 目录树递归渲染：目录行可折叠，文件行交给右侧编辑器。
// 技能包里的 scripts/、assets/ 等子目录都走这里，不再拍平到一层。
function AgentTreeNodes({
  nodes,
  depth,
  selectedFile,
  binaryFiles,
  isOpen,
  onToggle,
  onSelect,
}: {
  nodes: AgentTreeNode[];
  depth: number;
  selectedFile: string;
  binaryFiles: Record<string, string>;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const path = node.file ?? node.path;
        if (!node.children.length) {
          return (
            <AgentTreeFile
              key={path}
              path={path}
              label={node.name}
              depth={depth}
              selected={selectedFile === path}
              binary={Object.hasOwn(binaryFiles, path)}
              onSelect={onSelect}
            />
          );
        }
        return (
          <div className="agent-tree-branch" key={path}>
            <button
              className="agent-tree-folder"
              type="button"
              aria-expanded={isOpen(path)}
              style={{ "--agent-tree-depth": depth } as CSSProperties}
              onClick={() => onToggle(path)}
            >
              <span className="agent-tree-chevron">{isOpen(path) ? <IconChevronDown /> : <IconChevronRight />}</span>
              <span className="agent-tree-icon"><IconFolder /></span>
              <span className="agent-tree-label" title={path}>{node.name}</span>
              <span className="agent-tree-group-count">{countTreeFiles(node.children)}</span>
            </button>
            {isOpen(path) ? (
              <AgentTreeNodes
                nodes={node.children}
                depth={depth + 1}
                selectedFile={selectedFile}
                binaryFiles={binaryFiles}
                isOpen={isOpen}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function AgentManagementPanel({
  initialAgents,
  users,
  scope = "admin",
  onPersonalAgentsChanged,
}: {
  initialAgents: AgentSummary[];
  users: UserItem[];
  scope?: "admin" | "user";
  onPersonalAgentsChanged?: () => Promise<void>;
}) {
  const adminScope = scope === "admin";
  const [tab, setTab] = useState<Tab>("catalog");
  const [agents, setAgents] = useState(initialAgents);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [deleteHintDismissed, setDeleteHintDismissed] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(initialAgents.length ? "view" : "create");
  const [agentKey, setAgentKey] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({ "agent.md": NEW_AGENT_TEMPLATE });
  const [binaryFiles, setBinaryFiles] = useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = useState("agent.md");
  // 只记录“已展开”的目录：默认全部折叠，文件多时列表更清爽。
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const skillUploadRef = useRef<HTMLInputElement>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [disableTarget, setDisableTarget] = useState<AgentDetail | null>(null);
  const [skillDeleteTarget, setSkillDeleteTarget] = useState<AgentSkillGroup | null>(null);

  const activeUsers = useMemo(() => users.filter((user) => user.isActive), [users]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(activeUsers[0]?.id ?? null);
  const [assignment, setAssignment] = useState<UserAgentAssignmentsSnapshot | null>(null);
  const [draftAgentIds, setDraftAgentIds] = useState<string[]>([]);
  const [assignmentBusy, setAssignmentBusy] = useState(false);

  const editorFileNames = useMemo(
    () => [...new Set([...Object.keys(files), ...Object.keys(binaryFiles)])].sort(),
    [binaryFiles, files],
  );

  const references = useMemo(
    () => parseAgentReferences(files["agent.md"] ?? ""),
    [files],
  );
  const agentName = agentFrontmatterScalar(
    files["agent.md"] ?? "",
    agentFrontmatterScalar(files["agent.md"] ?? "", "display_name") ? "display_name" : "name",
  );
  const agentDescription = agentFrontmatterScalar(files["agent.md"] ?? "", "description");
  const agentNameField = agentFrontmatterScalar(files["agent.md"] ?? "", "display_name")
    ? "display_name"
    : "name";
  const fileTree = useMemo(
    () => buildAgentFileTree(editorFileNames, references.skills),
    [editorFileNames, references.skills],
  );
  const selectedIsBinary = Object.hasOwn(binaryFiles, selectedFile);
  const selectedSize = selectedIsBinary
    ? formatAgentFileSize(base64ByteLength(binaryFiles[selectedFile] ?? ""))
    : formatAgentFileSize(textByteLength(files[selectedFile] ?? ""));
  const selectedLines = selectedIsBinary ? null : countLines(files[selectedFile] ?? "");
  const agentDirectory = detail?.key ?? (agentKey.trim() || "新智能体");

  function groupOpen(key: string) {
    return Boolean(openGroups[key]);
  }

  function toggleGroup(key: string) {
    setOpenGroups((current) => ({ ...current, [key]: !current[key] }));
  }

  // 目录默认折叠，选中文件时才展开它所在的各级目录，避免树收起后“打开但看不见”。
  function selectFile(path: string) {
    setSelectedFile(path);
    const parts = path.split("/");
    const opened: string[] = [];
    if (parts.length === 1) {
      opened.push("root");
    } else if (parts[0] === "skills") {
      opened.push("skills");
    } else if (parts[0] === "scripts") {
      opened.push("scripts");
    }
    // 技能包和脚本目录还能再嵌套，逐级补上中间目录。
    for (let index = 2; index < parts.length; index += 1) {
      opened.push(parts.slice(0, index).join("/"));
    }
    if (!opened.length) return;
    setOpenGroups((current) => {
      const next = { ...current };
      for (const key of opened) next[key] = true;
      return next;
    });
  }

  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.key, agent.displayName, agent.description].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [agents, query]);
  const searching = query.trim().length > 0;

  // 目录与详情在同一个画布里切换：进详情后列表不再占位，画布滚动高度骤降。
  // 记住离开列表时的位置，返回时按原位恢复，连续处理多个智能体不用重新找。
  const catalogScrollRef = useRef(0);

  function rememberCatalogScroll() {
    catalogScrollRef.current =
      document.querySelector<HTMLElement>(".opshelper-page-body")?.scrollTop ?? 0;
  }

  function restoreCatalogScroll() {
    const container = document.querySelector<HTMLElement>(".opshelper-page-body");
    if (!container) return;
    const top = catalogScrollRef.current;
    // 等列表重新回到布局里再设位置，否则会被夹回 0。
    requestAnimationFrame(() => { container.scrollTop = top; });
  }

  async function refreshAgents(preferredKey?: string | null) {
    const snapshot = await listAgents(scope);
    setAgents(snapshot.agents);
    if (preferredKey === null) {
      setSelectedKey(null);
      return;
    }
    const nextKey = preferredKey ?? selectedKey;
    if (nextKey && snapshot.agents.some((agent) => agent.key === nextKey)) {
      setSelectedKey(nextKey);
    } else {
      setSelectedKey(snapshot.agents[0]?.key ?? null);
    }
  }

  useEffect(() => {
    if (!selectedKey || editorMode === "create") {
      setDetail(null);
      return;
    }
    let active = true;
    getAgent(selectedKey, scope)
      .then(({ agent }) => {
        if (!active) return;
        setDetail(agent);
        setFiles(agent.files);
        setBinaryFiles(agent.binaryFiles ?? {});
        setOpenGroups({});
        setSelectedFile("agent.md");
      })
      .catch((error) => toast.error(errorMessage(error, "读取智能体失败")));
    return () => { active = false; };
  }, [editorMode, scope, selectedKey]);

  useEffect(() => {
    if (!adminScope || tab !== "assignments" || !selectedUserId) return;
    let active = true;
    setAssignmentBusy(true);
    getUserAgentAssignments(selectedUserId)
      .then((snapshot) => {
        if (!active) return;
        setAssignment(snapshot);
        setDraftAgentIds(snapshot.assignedAgentIds);
      })
      .catch((error) => toast.error(errorMessage(error, "读取分配状态失败")))
      .finally(() => { if (active) setAssignmentBusy(false); });
    return () => { active = false; };
  }, [adminScope, selectedUserId, tab]);

  function beginCreate() {
    setEditorMode("create");
    setSelectedKey(null);
    setDetail(null);
    setAgentKey("");
    setFiles({ "agent.md": NEW_AGENT_TEMPLATE });
    setBinaryFiles({});
    setOpenGroups({});
    setSelectedFile("agent.md");
  }

  function selectAgent(key: string) {
    rememberCatalogScroll();
    setSelectedKey(key);
    setEditorMode("view");
  }

  function closeAgentDetail() {
    setSelectedKey(null);
    setDetail(null);
    setEditorMode("view");
    restoreCatalogScroll();
  }

  function addSupportingFile() {
    const path = newFilePath.trim();
    if (!/^(skills\/[a-z0-9-]+\/SKILL\.md|scripts\/[A-Za-z0-9._-]+)$/.test(path)) {
      toast.error("文件需为 skills/<名称>/SKILL.md 或 scripts/<文件名>");
      return;
    }
    if (Object.hasOwn(files, path) || Object.hasOwn(binaryFiles, path)) {
      toast.error("该文件已存在");
      return;
    }
    setFiles((current) => ({ ...current, [path]: "" }));
    selectFile(path);
    setNewFilePath("");
  }

  function configureMcp() {
    setFiles((current) => Object.hasOwn(current, "mcp.json")
      ? current
      : { ...current, "mcp.json": EMPTY_MCP_CONFIGURATION });
    selectFile("mcp.json");
  }

  function updateAgentMetadata(field: "name" | "display_name" | "description", value: string) {
    setFiles((current) => ({
      ...current,
      "agent.md": setAgentFrontmatterScalar(current["agent.md"] ?? NEW_AGENT_TEMPLATE, field, value),
    }));
  }

  async function uploadSkillPackage(file: File) {
    setBusy(true);
    try {
      const imported = await importAgentSkillPackage(file, scope);
      const importedNames = [...Object.keys(imported.files), ...Object.keys(imported.binaryFiles)];
      const conflict = importedNames.find((name) => Object.hasOwn(files, name) || Object.hasOwn(binaryFiles, name));
      if (conflict) throw new Error(`技能文件已存在：${conflict}`);
      setFiles((current) => ({
        ...current,
        ...imported.files,
        "agent.md": addSkillReference(current["agent.md"] ?? NEW_AGENT_TEMPLATE, imported.skillName),
      }));
      setBinaryFiles((current) => ({ ...current, ...imported.binaryFiles }));
      selectFile(`skills/${imported.skillName}/SKILL.md`);
      toast.success(`已导入 Skill「${imported.skillName}」，保存后生效`);
    } catch (error) {
      toast.error(errorMessage(error, "导入 Skill 包失败"));
    } finally {
      setBusy(false);
    }
  }

  function removeSupportingFile(name: string) {
    setFiles((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    setBinaryFiles((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    selectFile("agent.md");
  }

  function removeSkillDirectory(skill: AgentSkillGroup) {
    const prefix = `skills/${skill.name}/`;
    setFiles((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([name]) => !name.startsWith(prefix)),
      );
      next["agent.md"] = removeAgentSkillReference(next["agent.md"] ?? "", skill.name);
      return next;
    });
    setBinaryFiles((current) => Object.fromEntries(
      Object.entries(current).filter(([name]) => !name.startsWith(prefix)),
    ));
    if (selectedFile.startsWith(prefix)) selectFile("agent.md");
    setOpenGroups((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== prefix.slice(0, -1) && !key.startsWith(prefix)),
    ));
    setSkillDeleteTarget(null);
    toast.success(`已移除 Skill「${skill.name}」，保存后生效`);
  }

  async function saveAgent() {
    setBusy(true);
    try {
      if (editorMode === "create") {
        const response = await createAgent({ key: agentKey.trim(), files, binaryFiles }, scope);
        toast.success(adminScope ? "智能体已创建并通过检查" : "智能体已创建，正在装配到你的运行环境");
        setEditorMode("view");
        await refreshAgents(response.agent.key);
        if (!adminScope) await onPersonalAgentsChanged?.();
      } else if (detail) {
        await updateAgent(detail.key, { files, binaryFiles }, scope);
        toast.success(adminScope ? "目录已保存，受影响用户正在应用新配置" : "智能体已保存，正在更新你的运行环境");
        setEditorMode("view");
        await refreshAgents(detail.key);
        if (!adminScope) await onPersonalAgentsChanged?.();
      }
    } catch (error) {
      toast.error(errorMessage(error, "保存智能体失败"));
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    if (!detail) return;
    setBusy(true);
    try {
      await checkAgent(detail.key);
      await refreshAgents(detail.key);
      const response = await getAgent(detail.key, scope);
      setDetail(response.agent);
      toast.success("模型、工具、技能和脚本检查通过");
    } catch (error) {
      toast.error(errorMessage(error, "依赖检查失败"));
      await refreshAgents(detail.key).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function changeEnabled(agent: AgentDetail, enabled: boolean) {
    setBusy(true);
    try {
      await setAgentEnabled(agent.key, enabled);
      await refreshAgents(agent.key);
      const response = await getAgent(agent.key, scope);
      setDetail(response.agent);
      toast.success(enabled ? "智能体已启用" : "智能体已停用，相关用户环境正在重新装配");
    } catch (error) {
      toast.error(errorMessage(error, enabled ? "启用失败" : "停用失败"));
    } finally {
      setBusy(false);
      setDisableTarget(null);
    }
  }

  async function deleteSelectedAgent(agent: AgentDetail) {
    if (adminScope && agent.assignmentCount > 0) {
      toast.error(`该智能体仍分配给 ${agent.assignmentCount} 位用户，请先撤销分配`);
      return;
    }
    const typed = await promptDialog({
      title: `删除智能体 ${agent.displayName}`,
      description: (
        <>
          该操作会永久删除目录 <span className="mono">data/agents/{agent.key}</span> 和智能体记录；历史会话与个人文件会保留。请输入 <strong>{agent.key}</strong> 确认。
        </>
      ),
      placeholder: agent.key,
      confirmLabel: "删除智能体",
      autoSelect: "none",
      validate: (value) => value === agent.key ? null : "智能体 key 不一致",
    });
    if (typed === null) return;

    setBusy(true);
    try {
      await deleteAgent(agent.key, scope);
      setAgents((current) => current.filter((item) => item.key !== agent.key));
      setSelectedKey(null);
      setDetail(null);
      setEditorMode("view");
      toast.success(`已删除智能体 ${agent.displayName}`);
      await refreshAgents(null).catch(() => {
        toast.error("智能体已删除，但目录刷新失败，请重新载入页面");
      });
      if (!adminScope) await onPersonalAgentsChanged?.();
    } catch (error) {
      toast.error(errorMessage(error, "删除智能体失败"));
    } finally {
      setBusy(false);
    }
  }

  async function saveAssignments() {
    if (!assignment || !selectedUserId) return;
    setAssignmentBusy(true);
    try {
      const snapshot = await replaceUserAgentAssignments(
        selectedUserId,
        draftAgentIds,
        assignment.configuration.desiredGeneration,
      );
      setAssignment(snapshot);
      setDraftAgentIds(snapshot.assignedAgentIds);
      await refreshAgents();
      toast.success(snapshot.configuration.status === "ready" ? "分配已生效" : "分配已保存，运行环境正在处理");
    } catch (error) {
      toast.error(errorMessage(error, "保存分配失败"));
      const latest = await getUserAgentAssignments(selectedUserId).catch(() => null);
      if (latest) {
        setAssignment(latest);
        setDraftAgentIds(latest.assignedAgentIds);
      }
    } finally {
      setAssignmentBusy(false);
    }
  }

  async function retryConfiguration() {
    if (!selectedUserId) return;
    setAssignmentBusy(true);
    try {
      const snapshot = await reconcileUserAgentAssignments(selectedUserId);
      setAssignment(snapshot);
      setDraftAgentIds(snapshot.assignedAgentIds);
      toast.success(snapshot.configuration.status === "ready" ? "运行环境已恢复" : "已开始重新处理");
    } catch (error) {
      toast.error(errorMessage(error, "重新处理失败"));
    } finally {
      setAssignmentBusy(false);
    }
  }

  const assignmentDirty = assignment
    ? [...draftAgentIds].sort().join("|") !== [...assignment.assignedAgentIds].sort().join("|")
    : false;
  const assignmentHasLead = assignment
    ? draftAgentIds.length === 0 || assignment.agents.some((agent) =>
      draftAgentIds.includes(agent.id) && agent.mode !== "subagent")
    : false;

  return (
    <div className="agent-admin">
      {adminScope ? (
        <div className="agent-admin-tabs" role="tablist" aria-label="智能体管理">
          <button className={tab === "catalog" ? "active" : ""} type="button" onClick={() => setTab("catalog")}>智能体目录</button>
          <button className={tab === "assignments" ? "active" : ""} type="button" onClick={() => setTab("assignments")}>用户分配</button>
          <button className={tab === "models" ? "active" : ""} type="button" onClick={() => setTab("models")}>模型连接</button>
          <button className={tab === "instructions" ? "active" : ""} type="button" onClick={() => setTab("instructions")}>全局规则</button>
        </div>
      ) : null}

      {tab === "catalog" ? (
        <div className={`agent-admin-layout ${editorMode === "create" || selectedKey ? "agent-admin-detail-mode" : "agent-admin-list-mode"}`}>
          <section className="agent-catalog" aria-label="智能体目录">
            <div className="agent-catalog-heading">
              <div>
                <h2>智能体目录</h2>
                <p>{adminScope ? "管理团队共用的智能体" : "创建并查看智能体目录"}</p>
              </div>
              <span>{agentCatalogCount(agents.length, filteredAgents.length, searching)}</span>
            </div>
            <div className="agent-admin-toolbar">
              <div className="agent-catalog-search">
                <IconSearch />
                <input
                  className="field-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称或标识"
                  aria-label="搜索智能体名称或标识"
                />
                {searching ? (
                  <button
                    className="agent-catalog-search-clear"
                    type="button"
                    aria-label="清除搜索"
                    title="清除搜索"
                    onClick={() => setQuery("")}
                  >
                    <IconClose />
                  </button>
                ) : null}
              </div>
              <button className="button" type="button" onClick={beginCreate}>新建智能体</button>
            </div>
            <div className="agent-catalog-list">
              {filteredAgents.map((agent) => {
                const enabled = agentEnabledView(agent.isEnabled);
                const check = agentCheckView(agent.checkStatus);
                return (
                  <button
                    key={agent.id}
                    className={`agent-catalog-card${selectedKey === agent.key ? " selected" : ""}`}
                    type="button"
                    onClick={() => selectAgent(agent.key)}
                  >
                    <span className="agent-catalog-card-head">
                      <AgentMark id={agent.key} name={agent.displayName} description={agent.description} />
                      <strong className="agent-catalog-card-name">{agent.displayName}</strong>
                    </span>
                    <span className="agent-catalog-card-desc">
                      {agent.description || "未填写职责说明"}
                    </span>
                    {/* 技术标识排在中文职责之后：先看懂它负责什么，再核对它是哪个 key。 */}
                    <code className="agent-catalog-card-key" title={agent.key}>{agent.key}</code>
                    <span className="agent-catalog-card-foot">
                      <span className="agent-catalog-states">
                        <span className="agent-catalog-state neutral">{agentModeView(agent.mode).label}</span>
                        <span className={`agent-catalog-state ${enabled.tone}`}>
                          <span className="agent-catalog-dot" aria-hidden="true" />
                          {enabled.label}
                        </span>
                        <span className={`agent-catalog-state ${check.tone}`}>
                          {check.tone === "positive" ? <IconCheck /> : null}
                          {check.tone === "danger" ? <IconAlert /> : null}
                          {check.label}
                        </span>
                      </span>
                      <span className="agent-catalog-card-count">{agentAssignmentLabel(agent.assignmentCount)}</span>
                    </span>
                  </button>
                );
              })}
              {!filteredAgents.length ? (
                <div className="agent-catalog-empty">
                  {searching ? (
                    <>
                      <strong>没有找到匹配的智能体</strong>
                      <span>换个名称或标识试试，也可以直接新建</span>
                      <button className="button-secondary" type="button" onClick={() => setQuery("")}>清除搜索</button>
                    </>
                  ) : (
                    <>
                      <strong>还没有智能体</strong>
                      <span>创建一个智能体，配置职责后再分配给用户</span>
                      <button className="button" type="button" onClick={beginCreate}>新建智能体</button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </section>

          <section className="agent-editor panel" aria-label="智能体详情">
            {editorMode === "create" || detail ? (
              <>
                <button className="agent-back-button" type="button" onClick={closeAgentDetail} aria-label="返回智能体目录">← 返回智能体目录</button>
                <div className="panel-header agent-editor-header">
                  <div className="agent-editor-heading">
                    <div className="panel-title">{editorMode === "create" ? "新建智能体" : editorMode === "edit" ? `编辑 ${detail?.displayName ?? "智能体"}` : detail?.displayName}</div>
                    {detail ? <div className="muted mono" title={detail.contentHash ? `内容 hash：${detail.contentHash}` : undefined}>{detail.key}</div> : <div className="muted">{adminScope ? "配置基本信息、能力包与外部工具，保存检查通过后再分配给用户。" : "配置基本信息、能力包与外部工具，保存后系统会自动分配给你。"}</div>}
                  </div>
                  {(adminScope || detail?.canManage) && detail && editorMode === "view" ? <button className="button" type="button" onClick={() => setEditorMode("edit")}>编辑智能体</button> : null}
                </div>

                {detail?.checkError ? <div className="agent-alert agent-alert-error"><strong>依赖检查失败</strong><span>{detail.checkError}</span></div> : null}

                {editorMode === "view" && detail ? (
                  <>
                    <p>{detail.description}</p>
                    <dl className="agent-facts">
                      <div><dt>目录</dt><dd className="mono">data/agents/{detail.key}</dd></div>
                      <div><dt>内容 hash</dt><dd className="mono" title={detail.contentHash ?? undefined}>{detail.contentHash ? shortHash(detail.contentHash) : "尚未检查"}</dd></div>
                      <div><dt>角色模式</dt><dd>{agentModeView(detail.mode).label}</dd></div>
                      <div><dt>检查时间</dt><dd>{detail.checkedAt ? new Date(detail.checkedAt).toLocaleString("zh-CN") : "尚未检查"}</dd></div>
                      <div><dt>源文件</dt><dd>{Object.keys(detail.files).length + Object.keys(detail.binaryFiles ?? {}).length} 个</dd></div>
                      <div><dt>Skill</dt><dd>{new Set(Object.keys({ ...detail.files, ...(detail.binaryFiles ?? {}) }).filter((name) => name.startsWith("skills/")).map((name) => name.split("/")[1])).size} 个</dd></div>
                      <div><dt>MCP</dt><dd>{detail.files["mcp.json"] ? "已配置" : "未配置"}</dd></div>
                    </dl>
                    {adminScope ? (
                      <div className="inline-actions">
                        <button className="button-secondary" type="button" disabled={busy} onClick={runCheck}>重新检查</button>
                        {detail.isEnabled ? (
                          <button className="button-warning" type="button" disabled={busy} onClick={() => setDisableTarget(detail)}>停用</button>
                        ) : (
                          <button className="button" type="button" disabled={busy || detail.checkStatus !== "ready"} onClick={() => changeEnabled(detail, true)}>启用</button>
                        )}
                        <span
                          className="agent-delete-trigger"
                          tabIndex={detail.assignmentCount > 0 ? 0 : undefined}
                          role={detail.assignmentCount > 0 ? "group" : undefined}
                          aria-label={detail.assignmentCount > 0 ? "删除不可用" : undefined}
                          aria-describedby={detail.assignmentCount > 0 ? "agent-delete-hint" : undefined}
                          data-hint-dismissed={deleteHintDismissed}
                          onMouseEnter={() => setDeleteHintDismissed(false)}
                          onFocus={() => setDeleteHintDismissed(false)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setDeleteHintDismissed(true);
                          }}
                        >
                          <button
                            className="button-danger"
                            type="button"
                            disabled={busy || detail.assignmentCount > 0}
                            onClick={() => { void deleteSelectedAgent(detail); }}
                          >
                            {busy ? "处理中…" : "删除"}
                          </button>
                          {detail.assignmentCount > 0 ? (
                            <span className="agent-delete-hint" id="agent-delete-hint" role="tooltip">
                              仍分配给 {detail.assignmentCount} 位用户，请先在“用户分配”中撤销。
                            </span>
                          ) : null}
                        </span>
                      </div>
                    ) : detail.canManage ? (
                      <div className="inline-actions">
                        <button
                          className="button-danger"
                          type="button"
                          disabled={busy}
                          onClick={() => { void deleteSelectedAgent(detail); }}
                        >
                          {busy ? "处理中…" : "删除"}
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="stack">
                    {editorMode === "create" ? (
                      <label className="field"><span className="field-label">目录 key</span><input className="field-input mono" value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="network-ops" /></label>
                    ) : null}
                    <label className="field">
                      <span className="field-label">智能体名称</span>
                      <input
                        className="field-input"
                        value={agentName}
                        onChange={(event) => updateAgentMetadata(agentNameField, event.target.value)}
                        placeholder="例如：网络运维助手"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">职责说明</span>
                      <input
                        className="field-input"
                        value={agentDescription}
                        onChange={(event) => updateAgentMetadata("description", event.target.value)}
                        placeholder="说明这个智能体负责的工作范围"
                      />
                    </label>
                    <div className="agent-editor-actions">
                      <input ref={skillUploadRef} hidden type="file" accept=".zip,application/zip" onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadSkillPackage(file);
                      }} />
                      <button className="button-secondary" type="button" disabled={busy} onClick={() => skillUploadRef.current?.click()}>上传 Skill 包</button>
                      <button className="button-secondary" type="button" disabled={busy} onClick={configureMcp}>配置 MCP</button>
                      <span className="muted">Skill 包使用 ZIP；MCP 支持 remote 和 local 配置。</span>
                    </div>
                    <div className="agent-file-workspace">
                      <aside className="agent-file-tree" aria-label="智能体文件">
                        <div className="agent-tree-head">
                          <span>智能体文件</span>
                          <span className="agent-tree-head-count">{fileTree.skills.length} 技能 · {fileTree.scriptCount} 脚本</span>
                        </div>
                        <div className="agent-tree-body">
                          <button className="agent-tree-group" type="button" aria-expanded={groupOpen("root")} onClick={() => toggleGroup("root")}>
                            <span className="agent-tree-chevron">{groupOpen("root") ? <IconChevronDown /> : <IconChevronRight />}</span>
                            <span className="agent-tree-icon"><IconFolder /></span>
                            <span className="agent-tree-label">定义与配置</span>
                            <span className="agent-tree-group-count">{fileTree.rootFiles.length}</span>
                          </button>
                          {groupOpen("root") ? fileTree.rootFiles.map((name) => (
                            <AgentTreeFile
                              key={name}
                              path={name}
                              label={name}
                              depth={1}
                              selected={selectedFile === name}
                              binary={Object.hasOwn(binaryFiles, name)}
                              onSelect={selectFile}
                            />
                          )) : null}

                          <button className="agent-tree-group" type="button" aria-expanded={groupOpen("skills")} onClick={() => toggleGroup("skills")}>
                            <span className="agent-tree-chevron">{groupOpen("skills") ? <IconChevronDown /> : <IconChevronRight />}</span>
                            <span className="agent-tree-icon agent-tree-icon-skill"><IconSkill /></span>
                            <span className="agent-tree-label">技能</span>
                            <span className="agent-tree-group-count">{fileTree.skills.length}</span>
                          </button>
                          {groupOpen("skills") ? (fileTree.skills.length ? fileTree.skills.map((skill) => {
                            const groupKey = `skills/${skill.name}`;
                            return (
                              <div className="agent-tree-branch" key={groupKey}>
                                <div className="agent-tree-skill-row">
                                  <button className="agent-tree-folder" type="button" aria-expanded={groupOpen(groupKey)} style={{ "--agent-tree-depth": 1 } as CSSProperties} onClick={() => toggleGroup(groupKey)}>
                                    <span className="agent-tree-chevron">{groupOpen(groupKey) ? <IconChevronDown /> : <IconChevronRight />}</span>
                                    <span className="agent-tree-icon"><IconFolder /></span>
                                    <span className="agent-tree-label" title={`skills/${skill.name}`}>{skill.name}</span>
                                    <span className={`agent-tree-badge${skill.referenced ? " agent-tree-badge-on" : ""}`}>{skill.referenced ? "已引用" : "未引用"}</span>
                                    <span className="agent-tree-group-count">{skill.fileCount}</span>
                                  </button>
                                  <button
                                    className="agent-tree-skill-delete"
                                    type="button"
                                    aria-label={`删除技能 ${skill.name}`}
                                    title={`删除技能 ${skill.name}`}
                                    onClick={() => setSkillDeleteTarget(skill)}
                                  >
                                    <IconTrash />
                                  </button>
                                </div>
                                {groupOpen(groupKey) ? (
                                  <AgentTreeNodes
                                    nodes={skill.nodes}
                                    depth={2}
                                    selectedFile={selectedFile}
                                    binaryFiles={binaryFiles}
                                    isOpen={groupOpen}
                                    onToggle={toggleGroup}
                                    onSelect={selectFile}
                                  />
                                ) : null}
                              </div>
                            );
                          }) : <p className="agent-tree-empty">还没有技能包。上传 ZIP，或手动添加 skills/&lt;名称&gt;/SKILL.md。</p>) : null}

                          <button className="agent-tree-group" type="button" aria-expanded={groupOpen("scripts")} onClick={() => toggleGroup("scripts")}>
                            <span className="agent-tree-chevron">{groupOpen("scripts") ? <IconChevronDown /> : <IconChevronRight />}</span>
                            <span className="agent-tree-icon"><IconFolder /></span>
                            <span className="agent-tree-label">脚本</span>
                            <span className="agent-tree-group-count">{fileTree.scriptCount}</span>
                          </button>
                          {groupOpen("scripts") ? (fileTree.scripts.length ? (
                            <AgentTreeNodes
                              nodes={fileTree.scripts}
                              depth={1}
                              selectedFile={selectedFile}
                              binaryFiles={binaryFiles}
                              isOpen={groupOpen}
                              onToggle={toggleGroup}
                              onSelect={selectFile}
                            />
                          ) : <p className="agent-tree-empty">还没有脚本文件。</p>) : null}

                          {fileTree.others.length ? fileTree.others.map((path) => (
                            <AgentTreeFile
                              key={path}
                              path={path}
                              label={path}
                              depth={1}
                              selected={selectedFile === path}
                              binary={Object.hasOwn(binaryFiles, path)}
                              onSelect={selectFile}
                            />
                          )) : null}
                        </div>
                        <div className="agent-tree-add">
                          <input
                            className="field-input mono"
                            value={newFilePath}
                            onChange={(event) => setNewFilePath(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              addSupportingFile();
                            }}
                            placeholder="skills/name/SKILL.md"
                            aria-label="新增文件路径"
                          />
                          <button className="button-secondary" type="button" onClick={addSupportingFile}>添加</button>
                        </div>
                      </aside>

                      <section className="agent-file-pane" aria-label={`${selectedFile} 编辑器`}>
                        <header className="agent-file-pane-head">
                          <div className="agent-file-crumbs">
                            <span className="agent-file-crumb-root">data/agents/{agentDirectory}</span>
                            <span className="agent-file-crumb-sep" aria-hidden="true">/</span>
                            <span className="agent-file-crumb-current">{selectedFile}</span>
                          </div>
                          <div className="agent-file-pane-tools">
                            <span className="muted">{selectedSize}{selectedLines === null ? "" : ` · ${selectedLines} 行`}</span>
                            {selectedFile !== "agent.md" ? <button className="text-button danger" type="button" onClick={() => removeSupportingFile(selectedFile)}>删除文件</button> : null}
                          </div>
                        </header>
                        <div className="agent-file-pane-body">
                          {selectedIsBinary ? (
                            <div className="agent-binary-file">
                              <strong>二进制资源</strong>
                              <span className="muted">该文件来自 Skill ZIP，不能在线编辑；保存时会按原内容写入。</span>
                              <span className="mono">{selectedSize}</span>
                            </div>
                          ) : (
                            <textarea
                              className="field-textarea mono agent-source-editor"
                              aria-label={`编辑 ${selectedFile}`}
                              value={files[selectedFile] ?? ""}
                              onChange={(event) => setFiles((current) => ({ ...current, [selectedFile]: event.target.value }))}
                              spellCheck={false}
                            />
                          )}
                        </div>
                        <footer className="agent-file-pane-foot">
                          保存前检查模型、工具、Skill、脚本和 MCP；每个 Skill 仅授权给所属智能体，MCP 服务名会在运行时加上智能体 key 前缀。
                          {selectedFile === "mcp.json" ? " mcp.json 顶层是服务名到 OpenCode MCP 配置的对象；凭据会进入获配用户的只读运行时配置。" : ""}
                        </footer>
                      </section>
                    </div>
                    <div className="inline-actions">
                      <button className="button" type="button" disabled={busy || !files["agent.md"]?.trim()} onClick={saveAgent}>{busy ? "保存中…" : "保存并检查"}</button>
                      <button className="button-secondary" type="button" disabled={busy} onClick={() => {
                        if (detail) {
                          setFiles(detail.files);
                          setBinaryFiles(detail.binaryFiles ?? {});
                          setEditorMode("view");
                        } else {
                          closeAgentDetail();
                        }
                      }}>取消</button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="um-detail-placeholder agent-detail-loading">
                <button className="agent-back-button" type="button" onClick={closeAgentDetail}>← 返回智能体目录</button>
                <div className="muted">正在读取智能体详情…</div>
              </div>
            )}
          </section>
        </div>
      ) : adminScope && tab === "assignments" ? (
        <div className="agent-assignment-layout">
          <section className="agent-user-list" aria-label="用户列表">
            {activeUsers.map((user) => (
              <button className={`agent-user-row${selectedUserId === user.id ? " selected" : ""}`} key={user.id} type="button" onClick={() => setSelectedUserId(user.id)}>
                <strong>{user.name}</strong>
                <span className="muted">@{user.username}</span>
              </button>
            ))}
            {!activeUsers.length ? <div className="um-empty">没有可分配的启用用户。</div> : null}
          </section>
          <section className="agent-assignment-detail panel">
            {assignment ? (
              <>
                <div className="panel-header">
                  <div><div className="panel-title">{assignment.user.name}</div><div className="muted">@{assignment.user.username}</div></div>
                  <span className={`agent-config-status status-${assignment.configuration.status}`}>{statusLabels[assignment.configuration.status]}</span>
                </div>
                <div className="agent-config-strip">
                  <div><span>配置代次</span><strong>{assignment.configuration.appliedGeneration} / {assignment.configuration.desiredGeneration}</strong></div>
                  <div><span>期望清单</span><strong>{assignment.configuration.expectedAgentKeys.length} 个</strong></div>
                  <div><span>实际清单</span><strong>{assignment.configuration.actualAgentKeys.length} 个</strong></div>
                </div>
                {assignment.configuration.error ? <div className="agent-alert agent-alert-error"><strong>运行环境保持冻结</strong><span>{assignment.configuration.error}</span></div> : null}
                <div className="agent-assignment-options">
                  {assignment.agents.map((agent) => {
                    const checked = draftAgentIds.includes(agent.id);
                    const disabled = !agent.isEnabled || agent.checkStatus !== "ready";
                    return (
                      <label className={`agent-assignment-option${checked ? " checked" : ""}${disabled ? " disabled" : ""}`} key={agent.id}>
                        <input type="checkbox" checked={checked} disabled={disabled || assignmentBusy} onChange={(event) => setDraftAgentIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))} />
                        <span><strong>{agent.displayName}</strong><small className="mono">{agent.key} · {agentModeView(agent.mode).label}</small><small>{agent.description}</small></span>
                      </label>
                    );
                  })}
                </div>
                <div className="agent-assignment-foot">
                  <span className={assignmentHasLead ? "muted" : "agent-assignment-warning"}>{assignmentHasLead ? "同一用户的智能体共享该用户固定环境；子智能体仅用于协作调用。" : "至少选择一个主智能体或主/子智能体。"}</span>
                  <div className="inline-actions">
                    {assignment.configuration.action === "retry" ? <button className="button-secondary" type="button" disabled={assignmentBusy} onClick={retryConfiguration}>重新装配</button> : null}
                    <button className="button" type="button" disabled={!assignmentDirty || assignmentBusy || !assignmentHasLead} onClick={saveAssignments}>{assignmentBusy ? "处理中…" : "保存并应用"}</button>
                  </div>
                </div>
              </>
            ) : <div className="um-detail-placeholder"><div className="muted">{assignmentBusy ? "正在读取分配状态…" : "选择一个用户分配智能体。"}</div></div>}
          </section>
        </div>
      ) : adminScope && tab === "models" ? (
        <section className="panel agent-model-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">平台模型连接</div>
              <div className="muted">保存后，系统逐个更新受影响的用户环境。</div>
            </div>
          </div>
          <ModelManager onDirty={() => toast.info("模型配置已保存，用户环境正在更新")} />
        </section>
      ) : adminScope ? (
        <section className="panel global-instructions-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">全局规则</div>
              <div className="muted">统一约束所有用户与智能体；任务明确指定的目录和要求仍应优先遵循。</div>
            </div>
          </div>
          <GlobalInstructionsManager />
        </section>
      ) : null}

      <ConfirmDialog
        open={skillDeleteTarget !== null}
        title={`删除技能 ${skillDeleteTarget?.name ?? ""}`}
        description={skillDeleteTarget ? `将删除该技能目录中的 ${skillDeleteTarget.fileCount} 个文件${skillDeleteTarget.referenced ? "，并从 agent.md 中移除引用" : ""}。保存并检查后生效。` : undefined}
        confirmLabel="删除技能"
        variant="danger"
        onCancel={() => setSkillDeleteTarget(null)}
        onConfirm={() => { if (skillDeleteTarget) removeSkillDirectory(skillDeleteTarget); }}
      />

      {adminScope ? (
        <ConfirmDialog
          open={disableTarget !== null}
          title={`停用 ${disableTarget?.displayName ?? "智能体"}`}
          description="相关用户会立即停止当前协作任务并重建运行环境；历史会话和个人文件会保留。"
          confirmLabel="停用并重新装配"
          variant="danger"
          busy={busy}
          onCancel={() => setDisableTarget(null)}
          onConfirm={() => { if (disableTarget) void changeEnabled(disableTarget, false); }}
        />
      ) : null}
    </div>
  );
}
