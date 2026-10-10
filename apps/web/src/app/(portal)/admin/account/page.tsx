import { redirect } from "next/navigation";

import { AdminAccountSettings } from "@/components/admin-account-settings";
import { AdminPage } from "@/components/admin-shell";
import { IconSliders } from "@/components/chat/icons";
import { getSession } from "@/lib/api";

export default async function AdminAccountPage() {
  const session = await getSession();

  if (!session.authenticated || !session.user || session.user.role !== "admin") {
    redirect("/login");
  }

  return (
    <AdminPage
      title="账户设置"
      subtitle="管理员账号信息与密码"
      icon={<IconSliders />}
    >
      <div className="opshelper-settings-stack">
        <AdminAccountSettings
          username={session.user.username}
          name={session.user.name}
        />
      </div>
    </AdminPage>
  );
}
