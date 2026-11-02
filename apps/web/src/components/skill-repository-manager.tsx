"use client";

import type { SkillRepositorySkillSummary } from "@opshelper/shared";
import { useMemo, useRef, useState } from "react";

import {
  createSkillRepositorySkill,
  deleteSkillRepositorySkill,
  listSkillRepository,
} from "@/lib/browser-api";
import { toast } from "@/lib/toast";
import { IconSearch } from "@/components/chat/icons";
import { prompt as promptDialog } from "@/components/ui/dialog-host";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function SkillRepositoryManager({
  initialSkills,
}: {
  initialSkills: SkillRepositorySkillSummary[];
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState(initialSkills);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedDescriptions, setExpandedDescriptions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => skill.name.toLowerCase().includes(needle));
  }, [query, skills]);
  const visibleSkillNames = filteredSkills.map((skill) => skill.name);
  const allVisibleSelected = visibleSkillNames.length > 0 &&
    visibleSkillNames.every((name) => selected.includes(name));

  async function refreshSkills() {
    const snapshot = await listSkillRepository();
    setSkills(snapshot.skills);
    setSelected((current) => current.filter((name) => snapshot.skills.some((skill) => skill.name === name)));
  }

  function toggleSkill(name: string) {
    setSelected((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  }

  function toggleAllVisibleSkills() {
    setSelected((current) => {
      if (allVisibleSelected) {
        const visible = new Set(visibleSkillNames);
        return current.filter((name) => !visible.has(name));
      }
      return [...new Set([...current, ...visibleSkillNames])];
    });
  }

  function toggleDescription(name: string) {
    setExpandedDescriptions((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  }

  async function uploadSkills(files: File[]) {
    if (!files?.length) return;
    setBusy(true);
    const succeeded: string[] = [];
    const failed: Array<{ name: string; message: string }> = [];
    try {
      for (const file of Array.from(files)) {
        try {
          const response = await createSkillRepositorySkill(file);
          succeeded.push(response.skill.name);
        } catch (error) {
          failed.push({ name: file.name, message: errorMessage(error, "上传失败") });
        }
      }
      await refreshSkills();
      if (succeeded.length) {
        toast.success(`已添加 ${succeeded.length} 个技能到仓库`);
      }
      if (failed.length) {
        toast.error(`有 ${failed.length} 个技能添加失败：${failed[0].message}`);
      }
    } catch (error) {
      toast.error(errorMessage(error, "刷新技能仓库失败"));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelectedSkills() {
    if (!selected.length) return;
    const typed = await promptDialog({
      title: `删除 ${selected.length} 个仓库技能`,
      description: (
        <>
          该操作会永久删除选中的仓库技能。请输入 <strong>DELETE</strong> 确认。
        </>
      ),
      placeholder: "DELETE",
      confirmLabel: "删除选中技能",
      autoSelect: "none",
      validate: (value) => value === "DELETE" ? null : "请输入 DELETE",
    });
    if (typed === null) return;

    setBusy(true);
    const failed: Array<{ name: string; message: string }> = [];
    try {
      for (const name of selected) {
        try {
          await deleteSkillRepositorySkill(name);
        } catch (error) {
          failed.push({ name, message: errorMessage(error, "删除失败") });
        }
      }
      await refreshSkills();
      if (!failed.length) {
        toast.success(`已删除 ${selected.length} 个仓库技能`);
      } else {
        toast.error(`有 ${failed.length} 个技能删除失败：${failed[0].name}（${failed[0].message}）`);
      }
    } catch (error) {
      toast.error(errorMessage(error, "刷新技能仓库失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">技能仓库</div>
          <div className="muted">支持批量上传/删除；搜索按技能 name 模糊匹配。</div>
        </div>
        <div className="mono muted">共 {skills.length} 个</div>
      </div>

      <div className="agent-admin-toolbar">
        <div className="agent-catalog-search">
          <IconSearch />
          <input
            className="field-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按技能名称搜索"
            aria-label="按技能名称搜索"
          />
        </div>
        <input
          ref={uploadRef}
          hidden
          type="file"
          accept=".zip,application/zip"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.target.value = "";
            void uploadSkills(files);
          }}
        />
        <button className="button-secondary" type="button" disabled={busy} onClick={() => uploadRef.current?.click()}>
          添加技能
        </button>
        <label className="skill-repository-select-all">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={busy || !filteredSkills.length}
            onChange={toggleAllVisibleSkills}
          />
          <span>全选当前结果</span>
        </label>
        <button className="button-danger" type="button" disabled={busy || !selected.length} onClick={() => { void removeSelectedSkills(); }}>
          删除选中（{selected.length}）
        </button>
      </div>

      <div className="stack">
        {filteredSkills.map((skill) => {
          const checked = selected.includes(skill.name);
          return (
            <label key={skill.name} className={`agent-assignment-option${checked ? " checked" : ""}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={() => toggleSkill(skill.name)}
              />
              <span>
                <button
                  className="skill-repository-name"
                  type="button"
                  aria-expanded={expandedDescriptions.includes(skill.name)}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleDescription(skill.name);
                  }}
                >
                  {skill.name}
                </button>
                <button
                  className={`skill-repository-description${expandedDescriptions.includes(skill.name) ? " expanded" : ""}`}
                  type="button"
                  aria-expanded={expandedDescriptions.includes(skill.name)}
                  title="点击展开或收起技能说明"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleDescription(skill.name);
                  }}
                >
                  {skill.description}
                </button>
                <small className="mono">{skill.fileCount} 个文件 · 更新于 {new Date(skill.updatedAt).toLocaleString("zh-CN")}</small>
              </span>
            </label>
          );
        })}
        {!filteredSkills.length ? (
          <div className="agent-catalog-empty">
            <strong>没有匹配的技能</strong>
            <span>尝试更短的关键字，或先添加技能 ZIP。</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
