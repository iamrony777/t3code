import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import type { ProviderAccountUsageSnapshot } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import * as accountUsagePresentation from "./accountUsagePresentation";

function snapshot(accountUsage: ServerProvider["accountUsage"]): ProviderAccountUsageSnapshot {
  if (!accountUsage) throw new Error("account usage is required");
  return {
    environmentId: EnvironmentId.make("phone"),
    environmentLabel: "Phone",
    provider: {
      instanceId: ProviderInstanceId.make("commandcode"),
      driver: ProviderDriverKind.make("commandcode"),
      displayName: "Command Code Work",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-03T11:00:00.000Z",
      models: [],
      globalOptions: [],
      slashCommands: [],
      skills: [],
      accountUsage,
    },
  };
}

describe("presentAccountUsage", () => {
  it("keeps partial totals alongside a precise unavailable diagnostic", () => {
    const presentation = accountUsagePresentation.presentAccountUsage(
      snapshot({
        checkedAt: "2026-09-03T11:00:00.000Z",
        accountLabel: "Team",
        plan: "Pro",
        tokens: { total: 42_000 },
        creditsBalance: { purchased: 12 },
        unavailable: { reason: "probeFailed", message: "Authentication expired." },
      }),
    );

    expect(presentation.label).toBe("Command Code Work");
    expect(presentation.context).toContain("Team · Phone · cached");
    expect(presentation.unavailable).toBe("Authentication expired.");
    expect(presentation.rows).toEqual([
      { label: "Plan / status", value: "Pro" },
      { label: "Tokens", value: "42K total" },
      { label: "Credits balance", value: "12 purchased" },
    ]);
  });

  it("omits empty credit groups instead of rendering invented totals", () => {
    const presentation = accountUsagePresentation.presentAccountUsage(
      snapshot({
        checkedAt: "2026-09-03T11:00:00.000Z",
        creditsUsed: {},
        creditsBalance: {},
      }),
    );

    expect(presentation.rows).toEqual([]);
  });
});

describe("providerLimitsDetail", () => {
  it("keeps the account label as context and takes the plan from account usage", () => {
    const provider = snapshot({
      checkedAt: "2026-09-03T11:00:00.000Z",
      accountId: "https://api.commandcode.ai:user:user-123",
      accountLabel: "rony",
      plan: "Pro",
    }).provider;

    expect(
      accountUsagePresentation.providerLimitsDetail({
        ...provider,
        auth: { status: "authenticated", label: "rony" },
      }),
    ).toBe("rony · Pro");
  });

  it.each([
    ["claudeAgent", "Claude Max"],
    ["codex", "Codex Pro"],
  ] as const)("preserves the %s auth label when account usage is absent", (driver, label) => {
    const withAccountUsage = snapshot({
      checkedAt: "2026-09-03T11:00:00.000Z",
    }).provider;
    const { accountUsage: _accountUsage, ...provider } = withAccountUsage;

    expect(
      accountUsagePresentation.providerLimitsDetail({
        ...provider,
        driver: ProviderDriverKind.make(driver),
        auth: { status: "authenticated", label },
      }),
    ).toBe(label);
  });

  it("does not fall back to the auth label when account usage is present without a plan", () => {
    const provider = snapshot({
      checkedAt: "2026-09-03T11:00:00.000Z",
      accountLabel: "rony",
    }).provider;

    expect(
      accountUsagePresentation.providerLimitsDetail({
        ...provider,
        auth: { status: "authenticated", label: "rony" },
      }),
    ).toBe("rony");
  });
});

describe("presentComposerUsageAccount", () => {
  it("uses the Command Code product name when the instance matches the driver", () => {
    const account: UsageLimitsReport["accounts"][number] = {
      id: "commandcode",
      driver: ProviderDriverKind.make("commandcode"),
      label: "commandcode",
      instanceId: ProviderInstanceId.make("commandcode"),
      limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
    };
    expect(accountUsagePresentation.presentComposerUsageAccount(account)).toEqual({
      driverLabel: "Command Code",
      instanceLabel: "Command Code",
    });
  });
});
