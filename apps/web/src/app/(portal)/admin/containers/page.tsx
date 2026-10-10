import { redirect } from "next/navigation";

import { AdminPage } from "@/components/admin-shell";
import { AdminContainerList } from "@/components/admin-container-list";
import { IconContainer } from "@/components/chat/icons";
import { getAdminSnapshot } from "@/lib/api";

export default async function AdminContainersPage() {
  const snapshot = await getAdminSnapshot();

  if (!snapshot) {
    redirect("/login");
  }

  return (
    <AdminPage
      title="容器管理"
      subtitle="状态筛选、日志与生命周期操作"
      icon={<IconContainer />}
    >
      <article className="panel">
        <div className="panel-header">
          <div className="panel-title">容器列表</div>
          <div className="mono muted">共 {snapshot.containers.length} 个</div>
        </div>

        <AdminContainerList containers={snapshot.containers} />
      </article>
    </AdminPage>
  );
}
