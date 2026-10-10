import { redirect } from "next/navigation";

import { getSession } from "@/lib/api";

export default async function HomePage() {
  const session = await getSession();

  if (!session.authenticated || !session.user) {
    redirect("/login");
  }

  redirect("/chat");
}
