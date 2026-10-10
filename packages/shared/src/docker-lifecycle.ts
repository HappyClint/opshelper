export function isDockerNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "statusCode" in error && error.statusCode === 404;
}

interface StoppableContainer {
  inspect(): Promise<{ State?: { Running?: boolean } }>;
  stop(options: { t: number }): Promise<unknown>;
}

// A disappeared container is already stopped. Daemon, permission and network
// failures must propagate so callers never record a running container as stopped.
export async function stopDockerContainerIfRunning(container: StoppableContainer) {
  try {
    if (!(await container.inspect()).State?.Running) return false;
    try {
      await container.stop({ t: 10 });
    } catch (error) {
      if (typeof error !== "object" || error === null ||
          !("statusCode" in error) || error.statusCode !== 304) throw error;
    }
    return true;
  } catch (error) {
    if (isDockerNotFound(error)) return false;
    throw error;
  }
}
