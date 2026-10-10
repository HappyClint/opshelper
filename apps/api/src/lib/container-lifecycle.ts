export const lifecycleLockTtlMs = 2 * 60 * 1000;
export const wakeAttemptCooldownMs = 15 * 1000;
const startVerificationDelayMs = 2500;

interface StartableContainer {
  inspect: () => Promise<{ State?: { Running?: boolean } }>;
  start: () => Promise<unknown>;
}

/** Only a newly started process needs the startup stability delay. */
export async function startContainerIfNeeded(
  container: StartableContainer,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const inspect = await container.inspect().catch(() => null);
  if (inspect?.State?.Running) return false;
  await container.start();
  await wait(startVerificationDelayMs);
  return true;
}

export class WakeAttemptCoolingDownError extends Error {
  constructor() {
    super("Container wake attempt is already in progress");
    this.name = "WakeAttemptCoolingDownError";
  }
}

export class ContainerLifecycleLockError extends Error {
  constructor() {
    super("Container lifecycle operation is already in progress");
    this.name = "ContainerLifecycleLockError";
  }
}

export function isLifecycleLockExpired(
  lockedAt: Date | null | undefined,
  now = new Date(),
) {
  return !lockedAt || now.getTime() - lockedAt.getTime() >= lifecycleLockTtlMs;
}

export function isWakeAttemptCoolingDown(
  lastWakeAttemptAt: Date | null | undefined,
  now = new Date(),
) {
  return Boolean(
    lastWakeAttemptAt &&
      now.getTime() - lastWakeAttemptAt.getTime() < wakeAttemptCooldownMs,
  );
}
