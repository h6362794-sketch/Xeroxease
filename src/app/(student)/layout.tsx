import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth";
import { StudentChrome } from "@/features/student/student-chrome";

export const dynamic = "force-dynamic";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "STUDENT") redirect("/admin");

  return <StudentChrome user={user}>{children}</StudentChrome>;
}
