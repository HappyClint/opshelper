import { redirect } from "next/navigation";

import { AdminPage } from "@/components/admin-shell";
import { IconSkill } from "@/components/chat/icons";
import { SkillRepositoryManager } from "@/components/skill-repository-manager";
import { getSkillRepositorySnapshot } from "@/lib/api";

export default async function AdminSkillRepositoryPage() {
  const snapshot = await getSkillRepositorySnapshot();

  if (!snapshot) {
    redirect("/login");
  }

  return (
    <AdminPage
      title="技能仓库"
      subtitle="统一维护可导入的技能包"
      icon={<IconSkill />}
    >
      <SkillRepositoryManager initialSkills={snapshot.skills} />
    </AdminPage>
  );
}
