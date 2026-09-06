import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderAccountUsageSnapshot } from "@t3tools/shared/usageLimits";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => <span data-provider-icon="true" />,
}));
vi.mock("../settings/providerDriverMeta", () => ({
  getDriverOption: () => ({ label: "Command Code" }),
}));

import { ProviderAccountUsage, safeStudioUrl } from "./ProviderAccountUsage";

function snapshot(accountUsage: ServerProvider["accountUsage"]): ProviderAccountUsageSnapshot {
  if (!accountUsage) throw new Error("account usage is required");
  return {
    environmentId: EnvironmentId.make("laptop"),
    environmentLabel: "Laptop",
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

describe("safeStudioUrl", () => {
  it.each([
    "javascript:alert(1)",
    "not a url",
    "http://commandcode.ai/team/settings/usage",
    "https://commandcode.ai.evil.example/team/settings/usage",
  ])("rejects an unsafe Studio URL: %s", (url) => {
    expect(safeStudioUrl(url)).toBeNull();
  });

  it.each([
    "https://commandcode.ai/team/settings/usage",
    "https://studio.commandcode.ai/team/settings/usage",
  ])("accepts an intended Command Code HTTPS URL: %s", (url) => {
    expect(safeStudioUrl(url)).toBe(url);
  });
});

describe("ProviderAccountUsage", () => {
  it("renders partial data and an unavailable diagnostic without empty credit groups", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccountUsage
        snapshot={snapshot({
          checkedAt: "2026-09-03T11:00:00.000Z",
          plan: "Pro",
          tokens: { total: 42_000 },
          creditsUsed: {},
          creditsBalance: { purchased: 12 },
          unavailable: { reason: "probeFailed", message: "Authentication expired." },
        })}
      />,
    );

    expect(markup).toContain("Pro");
    expect(markup).toContain("42K total");
    expect(markup).toContain("Authentication expired.");
    expect(markup).not.toContain("Credits used");
    expect(markup).toContain("Credits balance");
    expect(markup).toContain("12 purchased");
    expect(markup).not.toContain("Open Studio");
  });

  it("renders only a safe Studio link", () => {
    const safeMarkup = renderToStaticMarkup(
      <ProviderAccountUsage
        snapshot={snapshot({
          checkedAt: "2026-09-03T11:00:00.000Z",
          studioUsageUrl: "https://commandcode.ai/team/settings/usage",
        })}
      />,
    );
    const unsafeMarkup = renderToStaticMarkup(
      <ProviderAccountUsage
        snapshot={snapshot({
          checkedAt: "2026-09-03T11:00:00.000Z",
          studioUsageUrl: "https://evil.example/team/settings/usage",
        })}
      />,
    );

    expect(safeMarkup).toContain('href="https://commandcode.ai/team/settings/usage"');
    expect(safeMarkup).toContain("Open Studio");
    expect(unsafeMarkup).not.toContain("Open Studio");
  });
});
