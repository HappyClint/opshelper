import { redirect } from "next/navigation";

import { AdminPage } from "@/components/admin-shell";
import { AgentManagementPanel } from "@/components/agent-management-panel";
import { IconAgent } from "@/components/chat/icons";
import { getAdminAgentsSnapshot, getAdminUsersSnapshot } from "@/lib/api";

export default async function AdminAgentsPage() {
  const [agentSnapshot, userSnapshot] = await Promise.all([
    getAdminAgentsSnapshot(),
    getAdminUsersSnapshot(),
  ]);

  if (!agentSnapshot || !userSnapshot) {
    redirect("/login");
  }

  return (
    <AdminPage
      title="智能体与分配"
      subtitle="目录、分配与平台配置"
      icon={<IconAgent />}
    >
      <AgentManagementPanel
        initialAgents={agentSnapshot.agents}
        users={userSnapshot.users}
      />
    </AdminPage>
  );
}
