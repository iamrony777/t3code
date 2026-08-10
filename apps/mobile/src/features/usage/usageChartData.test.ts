import { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildChartDays } from "./usageChartData";
import { PROVIDER_ORDER, visibleProviders } from "./usageProviders";

// `usageProviders` reaches for `useColorScheme`; only its pure exports are
// under test here, and the real module cannot be parsed outside Metro.
vi.mock("react-native", () => ({ useColorScheme: () => "dark" }));

const days = ["2026-08-01", "2026-08-02"];

const daily: readonly DailyTotals[] = [
  {
    day: "2026-08-01",
    costUsd: 30,
    totalTokens: 300,
    byProvider: new Map([
      ["codex", { costUsd: 10, totalTokens: 100 }],
      ["claude", { costUsd: 20, totalTokens: 200 }],
    ]),
  },
  // 2026-08-02 is deliberately absent: a day with no activity.
];

// What the screen passes: only the providers that reported in this window.
const providers = visibleProviders([{ provider: "codex" }, { provider: "claude" }]);

describe("PROVIDER_ORDER", () => {
  // The maps keyed by `UsageProviderKind` are exhaustiveness-checked by the
  // type system; the order array is not. A provider added to the contract but
  // missed here would be invisible in the chart and legend with no compile
  // error, so assert the coverage instead.
  it("covers every provider the contract defines", () => {
    expect([...PROVIDER_ORDER].sort()).toEqual([...UsageProviderKind.literals].sort());
  });
});

describe("buildChartDays", () => {
  it("stacks only the providers it was given", () => {
    // Regression: every provider in PROVIDER_ORDER was stacked unconditionally,
    // so a provider the user never ran added a zero band to every bar.
    const [first] = buildChartDays(days, daily, "cost", providers);

    expect(first?.values).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
    ]);
  });

  it("zero-fills days with no activity", () => {
    expect(buildChartDays(days, daily, "cost", providers).map((day) => day.total)).toEqual([30, 0]);
  });

  it("totals the same with or without the empty providers", () => {
    // The stack has to keep adding up to the headline `mergeUsage` computed.
    const narrowed = buildChartDays(days, daily, "tokens", providers);
    const full = buildChartDays(days, daily, "tokens", PROVIDER_ORDER);

    expect(narrowed.map((day) => day.total)).toEqual(full.map((day) => day.total));
    expect(narrowed[0]?.total).toBe(300);
  });
});
