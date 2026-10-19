import { redirect } from "next/navigation";

import { IconSliders } from "@/components/chat/icons";
import { UserSettings } from "@/components/user-settings";
import { WorkspaceMenuButton, WorkspaceUserMenu } from "@/components/workspace-shell";
import { getSession, getUserPortalSnapshot } from "@/lib/api";

// 与 /files、/schedules 同属工作台页面：共用工作台外壳、页面顶栏与 .opshelper-page-body 画布，
// 不再使用登录页那套 Chrome 外壳。
export default async function UserSettingsPage() {
  const session = await getSession();

  if (!session.authenticated || !session.user) {
    redirect("/login");
  }

  const snapshot = await getUserPortalSnapshot();

  if (!snapshot) {
    redirect("/login");
  }

  return (
    <main className="opshelper-main opshelper-workspace-main">
      <header className="opshelper-topbar opshelper-page-topbar">
        <WorkspaceMenuButton />
        <span className="opshelper-page-icon" aria-hidden="true"><IconSliders /></span>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">个人设置</h1>
          <div className="opshelper-topbar-sub">工作台容器、账户信息与密码</div>
        </div>
        <WorkspaceUserMenu />
      </header>
      <div className="opshelper-page-body">
        <UserSettings snapshot={snapshot} />
      </div>
    </main>
  );
}
