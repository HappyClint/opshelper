"use client";

import type { AgentSummary } from "@opshelper/shared";

import { AgentManagementPanel } from "@/components/agent-management-panel";
import { useWorkspace } from "@/components/workspace-shell";

export function UserAgentCatalog({ initialAgents }: { initialAgents: AgentSummary[] }) {
  const { refreshHome } = useWorkspace();

  return (
    <AgentManagementPanel
      initialAgents={initialAgents}
      users={[]}
      scope="user"
      onPersonalAgentsChanged={() => refreshHome(undefined, { activate: false })}
    />
  );
}
