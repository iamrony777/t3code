import { UsageProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER, visibleProviders } from "./usageProviders";

describe("PROVIDER_ORDER", () => {
  // The maps keyed by `UsageProviderKind` are exhaustiveness-checked by the
  // type system; the order array is not. A provider added to the contract but
  // missed here would be invisible in every chart, legend and table without a
  // single compile error, so assert the coverage instead.
  it("covers every provider the contract defines", () => {
    expect([...PROVIDER_ORDER].sort()).toEqual([...UsageProviderKind.literals].sort());
  });
});

describe("visibleProviders", () => {
  it("keeps reading order and drops providers with no data", () => {
    expect(visibleProviders([{ provider: "claude" }, { provider: "commandcode" }])).toEqual([
      "claude",
      "commandcode",
    ]);
  });

  it("falls back to the full order when nothing reported", () => {
    // Nothing to narrow to, and the empty state still has to render a page.
    expect(visibleProviders([])).toEqual(PROVIDER_ORDER);
  });
});
