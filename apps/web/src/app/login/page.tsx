import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/chat/icons";
import { LoginForm } from "@/components/login-form";
import { getSession } from "@/lib/api";

export default async function LoginPage() {
  const session = await getSession();

  if (session.authenticated && session.user) {
    redirect("/chat");
  }


  return (
    <div className="shell shell-sidebar-hidden shell-headerless opshelper-chat-shell opshelper-login-page">
      <main className="main">
        <div className="content content-wide">
          <div className="login-wrapper login-wrapper-standalone">
            <div className="login-card">
              <article className="panel">
                <div className="login-header">
                  <div className="login-brand"><BrandLogo /></div>
                  <div className="panel-title">登录小信运维助手</div>
                  <div className="muted">使用账号进入平台</div>
                </div>
                <LoginForm />
              </article>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
