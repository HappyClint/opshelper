import type { FastifyRequest } from "fastify";

export function redactRequestUrl(url: string) {
  try {
    const parsed = new URL(url, "http://localhost");
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:token|password|secret|api[_-]?key|authorization)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.pathname + parsed.search;
  } catch {
    return "[INVALID URL]";
  }
}

export const requestLoggerOptions = {
  redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
  serializers: {
    req(request: FastifyRequest) {
      return {
        method: request.method,
        url: redactRequestUrl(request.url),
        hostname: request.hostname,
        remoteAddress: request.ip,
      };
    },
  },
};
