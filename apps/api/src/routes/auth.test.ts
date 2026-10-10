import assert from "node:assert/strict";
import test from "node:test";

import { resolveDesktopOpenRedirect } from "./auth";

test("desktop login redirects stay on the local site", () => {
  assert.equal(resolveDesktopOpenRedirect("/gateway/chat?conversation=example"), "/gateway/chat?conversation=example");
  for (const url of [undefined, "https://external.example", "//external.example", "/\\external.example", "/\n/external.example"]) {
    assert.equal(resolveDesktopOpenRedirect(url), "/gateway/");
  }
});
