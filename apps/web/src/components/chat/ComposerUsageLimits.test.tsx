import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitsBannerItem } from "./ComposerUsageLimits";

const checkedAt = "2026-09-03T11:00:00.000Z";

function provider(driver: "claudeAgent" | "codex", plan: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", label: plan },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    globalOptions: [],
    usageLimits: {
      checkedAt,
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 25 }],
    },
  };
}

describe("usageLimitsBannerItem", () => {
  it.each([
    ["claudeAgent", "Claude Max"],
    ["codex", "Codex Pro"],
  ] as const)("shows the %s auth plan when account usage is absent", (driver, plan) => {
    const native = provider(driver, plan);
    const report = collectProviderUsageLimits(
      native.instanceId,
      [native],
      [],
      Date.parse(checkedAt),
    );
    if (!report) throw new Error("usage limits report is required");

    const banner = usageLimitsBannerItem(
      `usage-limits:${driver}`,
      report,
      EnvironmentId.make("laptop"),
      () => {},
    );

    expect(banner.description).toContain(plan);
  });
});
