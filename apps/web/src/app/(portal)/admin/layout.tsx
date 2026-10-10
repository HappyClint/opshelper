import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AdminShell } from "@/components/admin-shell";
import { getSession } from "@/lib/api";

export default async function AdminLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const session = await getSession();

  if (!session.authenticated || session.user?.role !== "admin") {
    redirect("/login");
  }

  return <AdminShell user={session.user}>{children}</AdminShell>;
}
