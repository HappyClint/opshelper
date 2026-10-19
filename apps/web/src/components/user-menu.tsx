"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { logout } from "@/lib/browser-api";

type UserMenuUser = {
  name: string;
  username: string;
  role: string;
};

function IconUser() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.6-3.4 3.1-5.4 7-5.4s6.4 2 7 5.4" />
    </svg>
  );
}

export function UserMenu({
  user,
  context = "workspace",
}: {
  user: UserMenuUser;
  context?: "workspace" | "admin";
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => firstItemRef.current?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  return (
    <div className="opshelper-user-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="opshelper-user-menu-button"
        aria-label="账户与退出"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="账户与退出"
        onClick={() => setOpen((value) => !value)}
      >
        <IconUser />
      </button>
      {open ? (
        <div className="opshelper-user-menu-popover" id={menuId} role="menu" aria-label="账户菜单">
          <div className="opshelper-user-menu-head">
            <span className="opshelper-user-menu-avatar">
              {Array.from(user.name.trim() || user.username)[0]?.toUpperCase()}
            </span>
            <span className="opshelper-user-menu-identity">
              <span className="opshelper-user-menu-name">{user.name}</span>
              <span className="opshelper-user-menu-handle">@{user.username}</span>
            </span>
          </div>
          <Link
            ref={firstItemRef}
            className="opshelper-user-menu-link"
            role="menuitem"
            href={context === "admin" ? "/admin/account" : "/user"}
            onClick={close}
          >
            {context === "admin" ? "账户设置" : "个人设置"}
          </Link>
          {context === "admin" ? (
            <Link className="opshelper-user-menu-link" role="menuitem" href="/chat" onClick={close}>
              返回工作台
            </Link>
          ) : user.role === "admin" ? (
            <Link className="opshelper-user-menu-link" role="menuitem" href="/admin" onClick={close}>
              管理控制台
            </Link>
          ) : null}
          <button
            className="opshelper-user-menu-logout"
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              void logout().then(() => { window.location.href = "/gateway/login"; });
            }}
          >
            退出
          </button>
        </div>
      ) : null}
    </div>
  );
}
