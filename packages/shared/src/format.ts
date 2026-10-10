import type { ActivityItem, ContainerStatus } from "./contracts";

export function formatDateLabel(iso: string | null | undefined) {
  if (!iso) {
    return "暂无";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(iso));
}

export function toKindLabel(kind: ActivityItem["kind"]) {
  switch (kind) {
    case "proxy":
      return "代理访问";
    case "start":
      return "容器启动";
    case "stop":
      return "容器停止";
    case "delete":
      return "容器删除";
  }
}

export function toContainerStatus(input: string): ContainerStatus {
  switch (input.toUpperCase()) {
    case "RUNNING":
      return "running";
    case "CREATING":
      return "creating";
    case "DELETING":
      return "deleting";
    case "ERROR":
      return "error";
    default:
      return "stopped";
  }
}
