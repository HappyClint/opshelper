"use client";

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
    </div>
  );
}
