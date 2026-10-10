"use client";

import { prompt as promptDialog } from "@/components/ui/dialog-host";

import type { AdminUsersSnapshot } from "@opshelper/shared";
import { useTransition } from "react";

import { deleteUser, updateUser } from "@/lib/browser-api";
import { toast } from "@/lib/toast";

type UserItem = AdminUsersSnapshot["users"][number];

export function UserEditForm({
  user,
  onCancel,
  onUpdated,
  onDeleted,
}: {
  user: UserItem;
  onCancel: () => void;
  onUpdated: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const [isDeleting, startDeleteTransition] = useTransition();

  async function handleDelete() {
    const typed = await promptDialog({
      title: `删除账号 @${user.username}`,
      description: `该操作不可撤销。请输入用户名 ${user.username} 以确认删除。`,
      placeholder: user.username,
      confirmLabel: "删除账号",
      validate: (value) =>
        value.trim() === user.username ? null : "用户名不一致",
    });
    if (!typed) return;
    startDeleteTransition(async () => {
      try {
        await deleteUser(user.id);
        toast.success(`已删除账号 ${user.username}`);
        await onDeleted();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "删除用户失败");
      }
    });
  }

  const busy = isPending || isDeleting;

  return (
    <article className="panel panel-form">
      <div className="panel-header">
        <div className="panel-title">编辑用户</div>
        <button
          className="button-secondary"
          type="button"
          onClick={onCancel}
        >
          关闭
        </button>
      </div>
      <div className="um-detail-user-header">
        <div className="um-detail-avatar">
          {user.name?.charAt(0).toUpperCase() ?? "U"}
        </div>
        <div>
          <div className="um-detail-name">{user.name}</div>
          <div className="muted">@{user.username}</div>
        </div>
      </div>
      <form
        key={user.id}
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);

          startTransition(async () => {
            try {
              await updateUser(user.id, {
                username: String(formData.get("username") ?? ""),
                name: String(formData.get("name") ?? ""),
                password:
                  String(formData.get("password") ?? "").trim() ||
                  undefined,
                role:
                  String(formData.get("role") ?? "user") === "admin"
                    ? "admin"
                    : "user",
                isActive: formData.get("isActive") === "on",
                keepContainerAlive:
                  formData.get("keepContainerAlive") === "on",
              });

              toast.success(`已更新账号 ${user.username}`);
              await onUpdated();
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : "更新用户失败",
              );
            }
          });
        }}
      >
        <label className="field">
          <span className="field-label">登录账号</span>
          <input
            className="field-input"
            defaultValue={user.username}
            name="username"
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
            defaultValue={user.name}
            name="name"
            type="text"
            maxLength={64}
            required
          />
        </label>

        <label className="field">
          <span className="field-label">角色</span>
          <select
            className="field-input"
            defaultValue={user.role}
            name="role"
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">重置密码</span>
          <input
            className="field-input"
            name="password"
            placeholder="留空则不修改"
            type="password"
            minLength={6}
          />
        </label>

        <label className="checkbox-field">
          <input
            defaultChecked={user.isActive ?? true}
            name="isActive"
            type="checkbox"
          />
          <span>启用该账号</span>
        </label>

        <label className="checkbox-field">
          <input
            defaultChecked={user.keepContainerAlive ?? false}
            name="keepContainerAlive"
            type="checkbox"
          />
          <span>长期保活运行中的容器</span>
        </label>

        <button className="button" disabled={busy} type="submit">
          {isPending ? "保存中..." : "保存修改"}
        </button>
      </form>

      <div className="um-danger-zone">
        <div className="um-danger-zone-header">
          <div className="um-danger-zone-title">删除账号</div>
          <div className="muted">
            彻底删除该用户、关联容器与数据。该操作不可撤销，确认时需输入用户名。
          </div>
        </div>
        <button
          className="button-danger"
          type="button"
          disabled={busy}
          onClick={handleDelete}
        >
          {isDeleting ? "删除中..." : "删除账号"}
        </button>
      </div>
    </article>
  );
}
