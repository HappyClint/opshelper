import { redirect } from "next/navigation";

import { AdminPage } from "@/components/admin-shell";
import { IconSliders } from "@/components/chat/icons";
import { UserSettings } from "@/components/user-settings";
import { getSession, getUserPortalSnapshot } from "@/lib/api";

export default async function AdminAccountPage() {
  const session = await getSession();

  if (!session.authenticated || !session.user || session.user.role !== "admin") {
    redirect("/login");
  }

  const snapshot = await getUserPortalSnapshot();

  if (!snapshot) {
    redirect("/login");
  }

  return (
    <AdminPage
      title="个人设置"
      subtitle="工作台容器、账户信息与密码"
      icon={<IconSliders />}
    >
      <div className="opshelper-settings-stack">
        <UserSettings snapshot={snapshot} />
      </div>
    </AdminPage>
  );
}
