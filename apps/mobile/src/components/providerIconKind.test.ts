import { describe, expect, it } from "vite-plus/test";

import { providerIconKind } from "./providerIconKind";

describe("providerIconKind", () => {
  it("maps Command Code explicitly instead of treating it as Codex", () => {
    expect(providerIconKind("commandcode")).toBe("commandcode");
    expect(providerIconKind("codex")).toBe("codex");
    expect(providerIconKind("future-provider")).toBe("unknown");
  });
});
