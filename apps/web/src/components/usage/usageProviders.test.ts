import { UsageProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

describe("PROVIDER_ORDER", () => {
  // The maps keyed by `UsageProviderKind` are exhaustiveness-checked by the
  // type system; the order array is not. A provider added to the contract but
  // missed here would be invisible in every chart, legend and table without a
  // single compile error, so assert the coverage instead.
  it("covers every provider the contract defines", () => {
    expect([...PROVIDER_ORDER].sort()).toEqual([...UsageProviderKind.literals].sort());
  });

  it("presents Command Code with its product name and a distinct series color", () => {
    expect(PROVIDER_PRESENTATION.commandcode.label).toBe("Command Code");
    expect(PROVIDER_PRESENTATION.commandcode.color).not.toBe(PROVIDER_PRESENTATION.codex.color);
    expect(PROVIDER_PRESENTATION.commandcode.mark).toBeTypeOf("function");
    expect(PROVIDER_PRESENTATION.opencode.label).toBe("OpenCode");
    expect(PROVIDER_PRESENTATION.opencode.mark).toBeTypeOf("function");
  });
});
