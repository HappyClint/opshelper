import type { ContainerStatus } from "@opshelper/shared";

const classMap: Record<ContainerStatus, string> = {
  creating: "status status-creating",
  running: "status status-running",
  stopped: "status status-stopped",
  deleting: "status status-error",
  error: "status status-error",
};

// 界面统一中文，原始状态值保留在 title 里方便对照 API 与日志。
const labelMap: Record<ContainerStatus, string> = {
  creating: "创建中",
  running: "运行中",
  stopped: "已停止",
  deleting: "删除中",
  error: "异常",
};

export function StatusPill({ status }: { status: ContainerStatus }) {
  const label = labelMap[status] ?? status;
  return (
    <span className={classMap[status]} title={status}>{label}</span>
  );
}
