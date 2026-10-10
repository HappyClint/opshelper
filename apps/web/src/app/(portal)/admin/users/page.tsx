import { redirect } from "next/navigation";

import { AdminPage } from "@/components/admin-shell";
import { IconUsers } from "@/components/chat/icons";
import { UserManagementPanel } from "@/components/user-management-panel";
import { getAdminUsersSnapshot } from "@/lib/api";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const query = (await searchParams).q ?? "";
  const snapshot = await getAdminUsersSnapshot(query);

  if (!snapshot) {
    redirect("/login");
  }

  return (
    <AdminPage
      title="用户管理"
      subtitle="账号、角色与容器保活"
      icon={<IconUsers />}
    >
      <UserManagementPanel query={snapshot.query} users={snapshot.users} />
    </AdminPage>
  );
}
