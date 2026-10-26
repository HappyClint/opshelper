"use client";

import Link from "next/link";
import type { UserPortalSnapshot } from "@opshelper/shared";

import { AdminAccountSettings } from "./admin-account-settings";
import { ContainerActions, startActionState, stopActionState } from "./container-actions";
import { StatusPill } from "./status-pill";

export function UserSettings({ snapshot }: { snapshot: UserPortalSnapshot }) {
  const { user, container } = snapshot;

  return (
    <div className="opshelper-settings-stack">
      <article className="panel panel-form">
        <div className="panel-header">
          <div className="panel-title">我的工作台容器</div>
          {container ? (
            <StatusPill status={container.status} />
          ) : (
            <span className="muted">未创建</span>
          )}
        </div>

        {container ? (
          <>
            <div className="field">
              <span className="field-label">最近活动</span>
              <div className="mono">{container.lastActivityAtLabel}</div>
            </div>
            <ContainerActions
              actions={[
                {
                  label: "启动",
                  path: "/v1/users/me/container/start",
                  ...startActionState(container.status),
                },
                {
                  label: "停止",
                  path: "/v1/users/me/container/stop",
                  confirm: "确定停止你的工作台容器吗？需先完成当前执行或处理恢复状态；文件与聊天记录会保留。",
                  ...stopActionState(container.status),
                },
                {
                  label: "重启",
                  path: "/v1/users/me/container/restart",
                  confirm: "确定重启你的工作台容器吗？需先完成当前执行或处理恢复状态；文件与聊天记录会保留。",
                },
              ]}
            />
          </>
        ) : (
          <div className="muted">
            尚未创建容器。打开工作台聊天页时会自动为你创建并启动。
          </div>
        )}
      </article>

      <AdminAccountSettings username={user.username} name={user.name} />

      <article className="panel panel-form">
        <div className="panel-header">
          <div className="panel-title">智能体编辑</div>
        </div>
        <div className="muted">
          从个人设置可直接进入智能体目录，创建或编辑你的智能体；保存后会自动分配到你的运行环境。
        </div>
        <div className="inline-actions" style={{ marginTop: 12 }}>
          <Link className="button-secondary" href="/agents">
            进入智能体编辑界面
          </Link>
        </div>
      </article>
    </div>
  );
}
