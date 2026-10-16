import { redirect } from "next/navigation";

import { IconAgent } from "@/components/chat/icons";
import { UserAgentCatalog } from "@/components/user-agent-catalog";
import { WorkspaceMenuButton } from "@/components/workspace-shell";
import { getSession, getUserAgentCatalogSnapshot } from "@/lib/api";

export default async function UserAgentsPage() {
  const session = await getSession();

  if (!session.authenticated || !session.user) {
    redirect("/login");
  }

  const snapshot = await getUserAgentCatalogSnapshot();

  if (!snapshot) {
    redirect("/login");
  }

  return (
    <main className="opshelper-main opshelper-workspace-main">
      <header className="opshelper-topbar opshelper-page-topbar">
        <WorkspaceMenuButton />
        <span className="opshelper-page-icon" aria-hidden="true"><IconAgent /></span>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">智能体目录</h1>
          <div className="opshelper-topbar-sub">创建并查看智能体；保存后自动分配到你的运行环境</div>
        </div>
      </header>
      <div className="opshelper-page-body">
        <UserAgentCatalog initialAgents={snapshot.agents} />
      </div>
    </main>
  );
}
