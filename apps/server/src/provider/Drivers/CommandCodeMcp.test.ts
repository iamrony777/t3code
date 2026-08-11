import { describe, expect, it } from "@effect/vitest";

import { commandCodeMcpAddArgs, commandCodeMcpRemoveArgs } from "./CommandCodeMcp.ts";

describe("commandCodeMcpAddArgs", () => {
  it("writes an http server with the credential header into local scope", () => {
    const args = commandCodeMcpAddArgs({
      endpoint: "http://127.0.0.1:4000/mcp",
      authorizationHeader: "Bearer token-123",
    });
    expect(args.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "local", "t3-code"]);
    expect(JSON.parse(args[5]!)).toEqual({
      type: "http",
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer token-123" },
    });
  });

  it("removes the same entry it adds", () => {
    expect(commandCodeMcpRemoveArgs()).toEqual(["mcp", "remove", "--scope", "local", "t3-code"]);
  });
});
