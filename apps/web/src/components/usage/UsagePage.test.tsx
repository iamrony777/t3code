import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  metric: "cost" as "cost" | "tokens" | "limits",
  breakdown: "time" as "model" | "time",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      initial === readUsagePagePreferences
        ? { metric: testState.metric, windowDays: 30 }
        : typeof initial === "function"
          ? {
              days: 1,
              window: {
                sinceDay: "2026-08-10",
                untilDay: "2026-08-11",
                timeZone: "UTC",
                resolution: "hour",
                sinceTime: "2026-08-10T12:37:00.000Z",
                untilTime: "2026-08-11T12:37:00.000Z",
              },
            }
          : initial === "cost"
            ? testState.metric
            : initial === "model"
              ? testState.breakdown
              : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
      commandcode: { color: "purple", label: "Command Code", mark: "span" },
      grok: { color: "gray", label: "Grok Build", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";
import { readUsagePagePreferences } from "./usagePagePreferences";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

const modelTotals = Object.freeze([
  {
    model: "expensive-model",
    provider: "claude" as const,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    costShare: 1 / 16,
  },
]);

const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.metric = "cost";
  testState.breakdown = "time";
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
        },
      ],
    },
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage hourly breakdown", () => {
  it("keeps recent activity visible first without empty hourly rows", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body).toContain("$11.00");
    expect(body).toContain("$13.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });

  it("keeps chronological ordering when the token metric is selected", () => {
    testState.metric = "tokens";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/\$11\.00.*\$13\.00/);
  });
});

describe("UsagePage model breakdown", () => {
  it("sorts models by cost when the cost metric is selected", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("sorts models by token usage when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
    expect(modelTotals.map((model) => model.model)).toEqual([
      "expensive-model",
      "token-heavy-model",
      "token-heavy-cheaper-model",
    ]);
  });
});

describe("UsagePage profile breakdown", () => {
  it("shows profile identity, totals, source diagnostics, and unpriced context", () => {
    testState.useUsage.mockReturnValue({
      ...testState.useUsage(),
      merged: {
        ...testState.useUsage().merged,
        costQuality: {
          ...testState.useUsage().merged.costQuality,
          unpricedShare: 0.25,
        },
        profiles: [
          {
            environmentId: EnvironmentId.make("test-environment"),
            sourceId: "claude-work",
            provider: "claude",
            instanceId: "claude-work",
            label: "Work",
            displayName: "Work",
            accentColor: "#d97757",
            status: "partial",
            message: "2 transcript files could not be read.",
            resolvedHomePath: "/profiles/work/.claude",
            costUsd: 12.5,
            totalTokens: 125_000,
            records: 20,
            sessions: 3,
          },
        ],
      },
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("Profiles");
    expect(markup).toContain("Work");
    expect(markup).toContain("125K tokens");
    expect(markup).toContain("$12.50 API equivalent");
    expect(markup).toContain("3 sessions");
    expect(markup).toContain("Partial scan");
    expect(markup).toContain("2 transcript files could not be read.");
    expect(markup).toContain("/profiles/work/.claude");
    expect(markup).toContain("unpriced and excluded from cost");
  });

  it("renders a missing profile's source diagnostic with zero usage", () => {
    testState.useUsage.mockReturnValue({
      ...testState.useUsage(),
      merged: {
        ...testState.useUsage().merged,
        profiles: [
          {
            environmentId: EnvironmentId.make("test-environment"),
            sourceId: "claude-missing",
            provider: "claude",
            instanceId: "claude-missing",
            label: "Missing profile",
            displayName: "Missing profile",
            accentColor: undefined,
            status: "missing",
            message: "Profile directory does not exist.",
            resolvedHomePath: "/profiles/missing/.claude",
            costUsd: 0,
            totalTokens: 0,
            records: 0,
            sessions: 0,
          },
        ],
      },
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("Missing profile");
    expect(markup).toContain("Source missing");
    expect(markup).toContain("Profile directory does not exist.");
    expect(markup).toContain("/profiles/missing/.claude");
    expect(markup).toContain("0 tokens");
    expect(markup).toContain("0 sessions");
  });
});
