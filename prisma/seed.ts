import { pathToFileURL } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import { hashPassword } from "../apps/api/src/lib/password";

const defaultOpencodeRuntimeImage = "opshelper/opencode-runtime:1.18.34";

export function resolveSeedContainerImage(
  env: Pick<NodeJS.ProcessEnv, "OPENCODE_DOCKER_IMAGE">,
) {
  return env.OPENCODE_DOCKER_IMAGE?.trim() || defaultOpencodeRuntimeImage;
}

export function resolveInitialAdminPassword(env: Pick<NodeJS.ProcessEnv, "OPSHELPER_ADMIN_PASSWORD">) {
  const password = env.OPSHELPER_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("首次初始化必须设置至少 12 位的 OPSHELPER_ADMIN_PASSWORD");
  }
  return password;
}

// Bootstrap is explicit and never changes an existing installation. Include every
// business model in the guard, including tables that have no User relation.
export async function bootstrapEmptyDatabase(client: PrismaClient, env = process.env) {
  return client.$transaction(async (tx) => {
    const tables = Prisma.dmmf.datamodel.models.map((model) =>
      Prisma.raw(`SELECT 1 FROM "${(model.dbName ?? model.name).replace(/"/g, '""')}"`),
    );
    const [result] = await tx.$queryRaw<{ populated: boolean }[]>(Prisma.sql`
      SELECT EXISTS (${Prisma.join(tables, " UNION ALL ")}) AS populated
    `);
    if (result.populated) {
      throw new Error("数据库已有业务数据，拒绝初始化；升级和恢复只执行迁移");
    }
    const passwordHash = await hashPassword(resolveInitialAdminPassword(env));
    const user = await tx.user.create({
      data: { username: "admin", name: "Platform Admin", role: "ADMIN", passwordHash },
    });
    await tx.containerInstance.create({
      data: {
        userId: user.id,
        name: `opshelper-user-${user.id}`,
        proxySlug: user.id,
        image: resolveSeedContainerImage(env),
        status: "STOPPED",
      },
    });
    return user.id;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  bootstrapEmptyDatabase(prisma)
    .then(() => console.log("[bootstrap] initial administrator created"))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
