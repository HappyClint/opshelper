"use client";

import { useState, useTransition } from "react";

import { createUser } from "@/lib/browser-api";
import { toast } from "@/lib/toast";

export function UserCreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const [createRole, setCreateRole] = useState<"user" | "admin">("user");

  return (
    <article className="panel panel-form">
      <div className="panel-header">
        <div className="panel-title">新增用户</div>
        <button
          className="button-secondary"
          type="button"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const formData = new FormData(form);

          startTransition(async () => {
            try {
              const role: "user" | "admin" =
                String(formData.get("role") ?? "user") === "admin"
                  ? "admin"
                  : "user";
              const result = await createUser({
                username: String(formData.get("username") ?? ""),
                name:
                  String(formData.get("name") ?? "").trim() || undefined,
                password: String(formData.get("password") ?? ""),
                role,
                keepContainerAlive:
                  formData.get("keepContainerAlive") === "on",
              });

              form.reset();
              toast.success(`已创建账号 ${result.user.username}`);
              await onCreated();
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : "创建用户失败",
              );
            }
          });
        }}
      >
        <label className="field">
          <span className="field-label">登录账号</span>
          <input
            className="field-input"
            name="username"
            placeholder="例如：zhangsan"
            type="text"
            minLength={3}
            maxLength={32}
            required
          />
        </label>

        <label className="field">
          <span className="field-label">显示名称</span>
          <input
            className="field-input"
            name="name"
            placeholder="留空则默认使用账号名"
            type="text"
            maxLength={64}
          />
        </label>

        <label className="field">
          <span className="field-label">角色</span>
          <select
            className="field-input"
            name="role"
            value={createRole}
            onChange={(event) => {
              setCreateRole(event.target.value === "admin" ? "admin" : "user");
            }}
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">初始密码</span>
          <input
            className="field-input"
            name="password"
            placeholder="至少 6 位"
            type="password"
            minLength={6}
            required
          />
        </label>

        <label className="checkbox-field">
          <input name="keepContainerAlive" type="checkbox" />
          <span>长期保活运行中的容器</span>
        </label>

        <button className="button" disabled={isPending} type="submit">
          {isPending ? "提交中..." : "创建"}
        </button>
      </form>
    </article>
  );
}
