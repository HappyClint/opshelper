"use client";

import { useState, useTransition } from "react";

import { changePassword } from "@/lib/browser-api";

export function AdminAccountSettings({
  username,
  name,
}: {
  username: string;
  name: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <article className="panel panel-form">
      <div className="panel-header">
        <div className="panel-title">账户信息</div>
      </div>

      <div className="field">
        <span className="field-label">用户名</span>
        <div className="mono">{username}</div>
      </div>
      <div className="field">
        <span className="field-label">显示名称</span>
        <div>{name}</div>
      </div>

      <div className="panel-header" style={{ marginTop: 18 }}>
        <div className="panel-title">修改密码</div>
      </div>

      {success ? (
        <div className="flash flash-success">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          密码修改成功
          <button
            className="button-secondary"
            type="button"
            style={{ marginLeft: "auto" }}
            onClick={() => setSuccess(false)}
          >
            再次修改
          </button>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const currentPassword = String(formData.get("currentPassword") ?? "");
            const newPassword = String(formData.get("newPassword") ?? "");
            const confirmPassword = String(formData.get("confirmPassword") ?? "");

            if (newPassword !== confirmPassword) {
              setError("两次输入的新密码不一致");
              return;
            }

            if (newPassword.length < 6) {
              setError("新密码长度不能少于6位");
              return;
            }

            const form = event.currentTarget;
            startTransition(async () => {
              try {
                setError(null);
                await changePassword(currentPassword, newPassword);
                form.reset();
                setSuccess(true);
              } catch (nextError) {
                setError(
                  nextError instanceof Error ? nextError.message : "修改密码失败",
                );
              }
            });
          }}
        >
          <label className="field">
            <span className="field-label">当前密码</span>
            <input
              className="field-input"
              name="currentPassword"
              placeholder="请输入当前密码"
              type="password"
              required
              autoComplete="current-password"
            />
          </label>

          <label className="field">
            <span className="field-label">新密码</span>
            <input
              className="field-input"
              name="newPassword"
              placeholder="请输入新密码（至少6位）"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </label>

          <label className="field">
            <span className="field-label">确认新密码</span>
            <input
              className="field-input"
              name="confirmPassword"
              placeholder="请再次输入新密码"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </label>

          {error ? (
            <div className="flash flash-error">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              {error}
            </div>
          ) : null}

          <div className="inline-actions">
            <button className="button" disabled={pending} type="submit">
              {pending ? "提交中..." : "确认修改"}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
