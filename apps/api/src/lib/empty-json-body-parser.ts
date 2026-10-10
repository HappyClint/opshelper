import type { FastifyInstance, FastifyRequest } from "fastify";

type ParserDone = (error: Error | null, body?: unknown) => void;

export function registerEmptyJsonBodyParser(app: FastifyInstance) {
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");

  const parseJsonBody = (
    request: FastifyRequest,
    body: string,
    done: ParserDone,
  ) => {
    if (body.trim() === "") {
      done(null, undefined);
      return;
    }

    defaultJsonParser(request, body, done);
  };

  app.addContentTypeParser("application/json", { parseAs: "string" }, parseJsonBody);
  app.addContentTypeParser(/^application\/.+\+json$/i, { parseAs: "string" }, parseJsonBody);
}
