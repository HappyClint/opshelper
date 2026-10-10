import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getSession } from "@/lib/api";

export default async function LoginPage() {
  const session = await getSession();

  if (session.authenticated && session.user) {
    redirect("/chat");
  }


  return (
    <div className="shell shell-sidebar-hidden shell-headerless">
      <main className="main">
        <div className="content content-wide">
          <div className="login-wrapper login-wrapper-standalone">
            <div className="login-card">
              <article className="panel">
                <div className="login-header">
                  <div className="login-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)" }}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </div>
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
