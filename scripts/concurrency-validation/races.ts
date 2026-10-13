import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { prisma } from "../../apps/api/src/lib/prisma";
import { claimNextExecution } from "../../apps/api/src/lib/conversation-service";
import { pauseSchedule, runScheduleNow } from "../../apps/api/src/lib/schedule-service";
import { processDueSchedule } from "../../apps/worker/src/index";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (process.env.OPSHELPER_CONCURRENCY_TEST !== "1" || database.pathname !== "/opshelper_concurrency_e2e") {
  throw new Error("Requires the dedicated opshelper_concurrency_e2e database and explicit test opt-in");
}
const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
const transaction = prisma.$transaction.bind(prisma);
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function within(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Barrier timeout")), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}
async function fixture() {
  await prisma.user.deleteMany();
  await prisma.agent.deleteMany();
  const agent = await prisma.agent.create({ data: { key: "race", displayName: "race", description: "isolated test", checkStatus: "READY" } });
  const user = await prisma.user.create({ data: { username: "race", name: "race", passwordHash: "not-a-login-hash", agents: { create: { agentId: agent.id } }, container: { create: { name: "race-no-runtime", image: "unused", proxySlug: randomUUID(), status: "STOPPED", configApplyStatus: "READY", desiredGeneration: 1, appliedGeneration: 1 } } } });
  const schedule = await prisma.schedule.create({ data: { userId: user.id, name: "race", prompt: "test", leadAgentKey: "race", participantAgentKeys: [], attachments: [], frequency: "DAILY", localTime: "09:00", nextRunAt: new Date() } });
  return { user, schedule };
}
async function check(name: string, test: () => Promise<void>) {
  try { await test(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  finally { prisma.$transaction = transaction as typeof prisma.$transaction; }
  console.log(`${checks.at(-1)!.passed ? "PASS" : "FAIL"} ${name}`);
}
async function main() {
  await check("manual trigger checked before pause cannot enqueue after pause commits", async () => {
    const { user, schedule } = await fixture();
    const entered = barrier(), release = barrier();
    let armed = true;
    prisma.$transaction = ((callback: any, options: any) => {
      if (!armed) return transaction(callback, options);
      armed = false;
      return (async () => { entered.release(); await release.promise; return transaction(callback, options); })();
    }) as typeof prisma.$transaction;
    const trigger = runScheduleNow(user.id, schedule.id, randomUUID()).then(() => "enqueued", (error) => error.statusCode === 409 ? "rejected" : Promise.reject(error));
    try { await within(entered.promise); await pauseSchedule(user.id, schedule.id); }
    finally { release.release(); }
    assert.equal(await trigger, "rejected");
    assert.equal(await prisma.execution.count(), 0);
  });
  await check("pause winning after queue read cannot resurrect cancelled execution or lease", async () => {
    const { user, schedule } = await fixture();
    const run = await runScheduleNow(user.id, schedule.id, randomUUID());
    const entered = barrier(), release = barrier();
    let armed = true;
    prisma.$transaction = ((callback: any, options: any) => transaction(async (tx: any) => callback(new Proxy(tx, {
      get(target, key) {
        if (key !== "execution") { const value = target[key]; return typeof value === "function" ? value.bind(target) : value; }
        return new Proxy(target.execution, { get(model, method) {
          if (method !== "findUnique") return model[method].bind(model);
          return async (args: any) => {
            const value = await model.findUnique(args);
            if (armed && args.where.id === run.executionId) { armed = false; entered.release(); await release.promise; }
            return value;
          };
        } });
      },
    })), options)) as typeof prisma.$transaction;
    const claim = claimNextExecution();
    try { await within(entered.promise); await pauseSchedule(user.id, schedule.id); }
    finally { release.release(); }
    assert.equal(await claim, null);
    assert.equal((await prisma.execution.findUniqueOrThrow({ where: { id: run.executionId } })).status, "CANCELLED");
    assert.equal((await prisma.containerInstance.findUniqueOrThrow({ where: { userId: user.id } })).activeExecutionId, null);
  });
  await check("claim winning before pause retains already-started execution", async () => {
    const { user, schedule } = await fixture();
    await runScheduleNow(user.id, schedule.id, randomUUID());
    const claim = await claimNextExecution();
    assert.ok(claim);
    await pauseSchedule(user.id, schedule.id);
    assert.equal((await prisma.execution.findUniqueOrThrow({ where: { id: claim.id } })).status, "DISPATCHING");
  });
  await check("two API claimers cannot execute two queued tasks for the same user", async () => {
    const { user, schedule } = await fixture();
    await runScheduleNow(user.id, schedule.id, randomUUID());
    await runScheduleNow(user.id, schedule.id, randomUUID());
    const claims = await Promise.all([claimNextExecution(), claimNextExecution()]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await prisma.execution.count({ where: { status: "DISPATCHING" } }), 1);
    assert.equal(await prisma.execution.count({ where: { status: "QUEUED" } }), 1);
  });
  await check("20 simultaneous manual retries share one execution", async () => {
    const { user, schedule } = await fixture();
    const requestKey = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => runScheduleNow(user.id, schedule.id, requestKey)));
    assert.equal(new Set(results.map((result) => result.executionId)).size, 1);
    assert.equal(await prisma.scheduleRun.count(), 1);
    assert.equal(await prisma.execution.count(), 1);
  });
  await check("20 distinct simultaneous manual requests all enqueue once", async () => {
    const { user, schedule } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => runScheduleNow(user.id, schedule.id, randomUUID())));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 20);
    assert.equal(await prisma.execution.count(), 20);
  });
  await check("50 concurrent due-trigger/pause races leave paused schedules without queued work", async () => {
    for (let i = 0; i < 50; i++) {
      const { user, schedule } = await fixture();
      const results = await Promise.allSettled([processDueSchedule(schedule.id, schedule.nextRunAt!, new Date()), pauseSchedule(user.id, schedule.id)]);
      for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "P2034");
      assert.equal(results[1].status, "fulfilled");
      assert.equal((await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).status, "PAUSED");
      assert.equal(await prisma.execution.count({ where: { status: { in: ["QUEUED", "DISPATCHING", "RUNNING"] } } }), 0);
      assert.ok(await prisma.scheduleRun.count() <= 1);
    }
  });
  await check("10 simultaneous scheduler claims create exactly one due run", async () => {
    const { schedule } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => processDueSchedule(schedule.id, schedule.nextRunAt!, new Date())));
    for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "P2034");
    assert.equal(await prisma.scheduleRun.count(), 1);
    assert.equal(await prisma.execution.count(), 1);
  });
  await writeFile(process.env.CONCURRENCY_REPORT ?? ".temp/concurrency-e2e/races.json", JSON.stringify({ checks }, null, 2));
  await prisma.$disconnect();
  process.exit(checks.every((check) => check.passed) ? 0 : 1);
}
void main().catch((error) => { console.error(error.message); process.exit(1); });
