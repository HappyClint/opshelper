"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { ContainerStatus } from "@opshelper/shared";

import { mutateContainer } from "@/lib/browser-api";
import { confirm as confirmDialog } from "@/components/ui/dialog-host";
import { toast } from "@/lib/toast";

export interface ContainerActionSpec {
  label: string;
  path: string;
  method?: "POST" | "DELETE";
  variant?: "secondary" | "danger";
  confirm?: string;
  // 当前状态下没有意义的动作直接禁用，而不是让用户点一次再被后端告知无效。
  disabled?: boolean;
  disabledHint?: string;
}

type ContainerActionState = Pick<ContainerActionSpec, "disabled" | "disabledHint">;

// 容器状态取自数据库，可能与 Docker 实际状态短暂不一致，所以只挡掉明确无意义的动作。
// 「重启」与「重建环境」不在此列：它们要留给容器没响应、但库里状态看不出来的时候。
// recovery 由调用方给出本页确实存在的恢复入口（工作台是「重启」，管理页还有「重建环境」）。
const TRANSITIONAL: ContainerStatus[] = ["creating", "deleting"];

function unavailable(disabledHint: string): ContainerActionState {
  return { disabled: true, disabledHint };
}

export function startActionState(status: ContainerStatus, recovery = "重启"): ContainerActionState {
  if (TRANSITIONAL.includes(status)) {
    return unavailable("容器状态处理中，请稍后刷新再操作");
  }
  return status === "running"
    ? unavailable(`容器已在运行；无响应时可尝试「${recovery}」`)
    : {};
}

export function stopActionState(status: ContainerStatus): ContainerActionState {
  if (TRANSITIONAL.includes(status)) {
    return unavailable("容器状态处理中，请稍后刷新再操作");
  }
  return status === "stopped" ? unavailable("容器已停止") : {};
}

export function ContainerActions({
  actions,
  onActionStart,
}: {
  actions: ContainerActionSpec[];
  onActionStart?: (action: ContainerActionSpec) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="inline-actions">
      {actions.map((action) => {
        const needsConfirm =
          Boolean(action.confirm) ||
          action.variant === "danger" ||
          action.method === "DELETE" ||
          action.label === "停止";
        const variant: "default" | "danger" =
          action.variant === "danger" ? "danger" : "default";

        return (
          <button
            key={`${action.method ?? "POST"}-${action.path}`}
            className={
              action.variant === "danger" ? "button-danger" : "button-secondary"
            }
            disabled={isPending || action.disabled}
            title={action.disabled ? action.disabledHint : undefined}
            type="button"
            onClick={async () => {
              if (needsConfirm) {
                const ok = await confirmDialog({
                  title: `${action.label}`,
                  description:
                    action.confirm ?? `确定执行「${action.label}」操作吗？`,
                  confirmLabel: action.label,
                  variant,
                });
                if (!ok) return;
              }

              onActionStart?.(action);
              startTransition(async () => {
                try {
                  await mutateContainer(action.path, action.method);
                  toast.success(`${action.label}操作已执行`);
                  router.refresh();
                } catch (nextError) {
                  toast.error(
                    nextError instanceof Error ? nextError.message : "操作失败",
                  );
                }
              });
            }}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
