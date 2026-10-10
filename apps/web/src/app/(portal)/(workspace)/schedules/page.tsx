import { IconClock } from "@/components/chat/icons";
import { ScheduleManager } from "@/components/schedules/schedule-manager";
import { WorkspaceMenuButton } from "@/components/workspace-shell";
import { getChatModels } from "@/lib/api";

export default async function SchedulesPage() {
  const models = await getChatModels().catch(() => ({ models: [], defaultModel: "" }));
  return (
    <main className="opshelper-main opshelper-workspace-main">
      <header className="opshelper-topbar opshelper-page-topbar">
        <WorkspaceMenuButton />
        <span className="opshelper-page-icon" aria-hidden="true"><IconClock /></span>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">定时任务</h1>
          <div className="opshelper-topbar-sub">个人计划和执行记录</div>
        </div>
      </header>
      <ScheduleManager
        models={models.models}
        defaultModel={models.defaultModel}
      />
    </main>
  );
}
