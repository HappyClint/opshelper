"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { login } from "@/lib/browser-api";

function IconEye({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );
}

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const username = String(formData.get("username") ?? "");
        const password = String(formData.get("password") ?? "");

        startTransition(async () => {
          try {
            setError(null);
            await login({ username, password });
            router.push("/chat");
            router.refresh();
          } catch (nextError) {
            setError(
              nextError instanceof Error ? nextError.message : "登录失败",
            );
          }
        });
      }}
    >
      <label className="field">
        <span className="field-label">账号</span>
        <input
          className="field-input"
          name="username"
          placeholder="请输入账号"
          type="text"
          required
          autoComplete="username"
        />
      </label>

      <label className="field">
        <span className="field-label">密码</span>
        <div className="field-input-wrap">
          <input
            className="field-input field-input-with-suffix"
            name="password"
            placeholder="请输入密码"
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
          />
          <button
            type="button"
            className="field-input-suffix"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
            title={showPassword ? "隐藏密码" : "显示密码"}
            tabIndex={-1}
          >
            <IconEye open={showPassword} />
          </button>
        </div>
      </label>

      {error ? (
        <div className="flash flash-error">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          {error}
        </div>
      ) : null}

      <button className="button" disabled={isPending} type="submit">
        {isPending ? "登录中..." : "进入平台"}
      </button>

      <div className="login-footer-hint muted">忘记密码？请联系管理员</div>

    </form>
  );
}
