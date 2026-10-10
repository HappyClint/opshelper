import { FileManager } from "@/components/file-manager";
import { IconFolder } from "@/components/chat/icons";
import { WorkspaceMenuButton } from "@/components/workspace-shell";

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const query = await searchParams;
  const initialPath = Array.isArray(query.path) ? query.path[0] : query.path;

  return (
    <main className="opshelper-main opshelper-workspace-main">
      <header className="opshelper-topbar opshelper-page-topbar">
        <WorkspaceMenuButton />
        <span className="opshelper-page-icon" aria-hidden="true"><IconFolder /></span>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">我的文件</h1>
          <div className="opshelper-topbar-sub">所有智能体共用的完整文件管理</div>
        </div>
      </header>
      <div className="user-files-page">
        <section className="user-files-content">
          <FileManager initialPath={initialPath} />
        </section>
      </div>
    </main>
  );
}
