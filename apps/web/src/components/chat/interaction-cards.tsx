"use client";

import { useState } from "react";

import { IconAsk, IconShield } from "./icons";
import type { PendingPermission, PendingQuestion } from "./interactions";
import { operationKind, toolDisplayName } from "./tool-activity";

export function QuestionCard({
  question,
  onAnswer,
  submitting = false,
}: {
  question: PendingQuestion;
  onAnswer: (answers: string[][]) => void;
  submitting?: boolean;
}) {
  // One selection set + one custom-text entry per sub-question, by index.
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  const toggle = (index: number, label: string, multiple: boolean) => {
    setSelected((prev) => {
      const current = prev[index] ?? [];
      if (!multiple) {
        return { ...prev, [index]: current.includes(label) ? [] : [label] };
      }
      return {
        ...prev,
        [index]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      };
    });
  };

  // Every sub-question needs at least one option picked or custom text filled in.
  const ready = question.questions.every((_, index) => {
    const picks = selected[index]?.length ?? 0;
    const text = custom[index]?.trim() ? 1 : 0;
    return picks + text > 0;
  });

  const submit = () => {
    const answers = question.questions.map((_, index) => {
      const picks = [...(selected[index] ?? [])];
      const text = custom[index]?.trim();
      if (text) picks.push(text);
      return picks;
    });
    onAnswer(answers);
  };

  return (
    <div className="opshelper-question">
      <div className="opshelper-question-head">
        <IconAsk />
        <span>助理需要你的确认</span>
      </div>
      {question.questions.map((item, index) => (
        <div className="opshelper-q-block" key={index}>
          <div className="opshelper-q-title">{item.header || item.question}</div>
          {item.header && item.question && item.question !== item.header ? (
            <div className="opshelper-q-detail">{item.question}</div>
          ) : null}
          <div className="opshelper-q-options">
            {item.options.map((option) => {
              const active = (selected[index] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  className={`opshelper-q-option${active ? " sel" : ""}`}
                  title={option.description}
                  onClick={() => toggle(index, option.label, Boolean(item.multiple))}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {item.custom !== false ? (
            <input
              aria-label={item.header || item.question}
              className="opshelper-q-custom"
              placeholder="自定义回答…"
              value={custom[index] ?? ""}
              onChange={(e) =>
                setCustom((prev) => ({ ...prev, [index]: e.target.value }))
              }
            />
          ) : item.options.length === 0 ? (
            <p role="alert">此问题没有可用的回答方式，请停止任务后重新发起。</p>
          ) : null}
        </div>
      ))}
      <button className="opshelper-q-submit" disabled={!ready || submitting} onClick={submit}>
        提交
      </button>
    </div>
  );
}

export function PermissionCard({
  permission,
  onRespond,
}: {
  permission: PendingPermission;
  onRespond: (response: "once" | "reject") => void;
}) {
  const toolLabel = permission.tool ? toolDisplayName(permission.tool) : null;
  const kind = permission.tool ? operationKind(permission.tool) : "other";
  const title = toolLabel && permission.title.trim().toLowerCase() === permission.tool?.trim().toLowerCase()
    ? toolLabel
    : permission.title;
  // 标题已经是分类说法时不再重复贴同一个标签。
  const tagLabel = toolLabel && toolLabel !== title ? toolLabel : null;
  const impact = kind === "change"
    ? "允许后可能修改工作区文件。"
    : kind === "command"
      ? "允许后将执行命令，可能更改文件或运行环境。"
      : kind === "network"
        ? "允许后将访问外部服务。"
        : kind === "integration"
          ? "允许后将调用扩展工具，可能访问外部服务。"
          : null;

  return (
    <div className="opshelper-permission" role="group" aria-label={`需要授权：${title}`}>
      <div className="opshelper-permission-head">
        <IconShield />
        <span className="opshelper-permission-title">{title}</span>
        {tagLabel ? <span className="opshelper-permission-tag">{tagLabel}</span> : null}
      </div>
      {impact ? <div className="opshelper-permission-impact">{impact}</div> : null}
      {permission.detail ? (
        <pre className="opshelper-permission-detail">{permission.detail}</pre>
      ) : null}
      <div className="opshelper-permission-actions">
        <button className="opshelper-perm-btn primary" onClick={() => onRespond("once")}>
          允许一次
        </button>
        <button className="opshelper-perm-btn danger" onClick={() => onRespond("reject")}>
          拒绝
        </button>
      </div>
    </div>
  );
}
