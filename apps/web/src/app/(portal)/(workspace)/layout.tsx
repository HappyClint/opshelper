import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";

import { WorkspaceShell } from "@/components/workspace-shell";
import { getSession } from "@/lib/api";

export default async function WorkspaceLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const session = await getSession();
  if (!session.authenticated || !session.user) redirect("/login");

  return (
    <Suspense fallback={<div className="opshelper-boot"><div className="opshelper-spinner" /><div className="opshelper-boot-text">正在打开运维工作台…</div></div>}>
      <WorkspaceShell user={session.user}>{children}</WorkspaceShell>
    </Suspense>
  );
}
