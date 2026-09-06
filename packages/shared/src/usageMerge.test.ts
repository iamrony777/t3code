import {
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSourceId,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    distinctSessions?: number;
    status?: "ok" | "missing" | "partial" | "failed";
    message?: string | null;
    sourceId?: UsageSourceId;
    profile?: {
      instanceId: ProviderInstanceId;
      displayName?: string;
      accentColor?: string;
    };
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      ...(source.sourceId === undefined ? {} : { sourceId: source.sourceId }),
      ...(source.profile === undefined ? {} : { profile: source.profile }),
      status: source.status ?? ("ok" as const),
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: source.message ?? null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("uses provider-level ownership for legacy buckets without source identity", () => {
    // Two v5 worktree servers on one machine resolve the same provider home.
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared], 5)),
        environment("env-b", summary([bucket()], [shared], 5)),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's claude bucket is dropped, its codex bucket survives.
    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("excludes an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.staleEnvironments).toEqual([]);
  });

  it.each([4, 5])("keeps v%s summaries compatible", (contractVersion) => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
            contractVersion,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual([]);
  });

  it("deduplicates one physical source without dropping another source for the same provider", () => {
    const shared = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude-work",
      sourceId: "claude-work" as UsageSourceId,
      profile: { instanceId: ProviderInstanceId.make("claude_work"), displayName: "Work" },
    };
    const personal = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude-personal",
      sourceId: "claude-personal" as UsageSourceId,
      profile: { instanceId: ProviderInstanceId.make("claude_personal"), displayName: "Personal" },
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket({ sourceId: shared.sourceId })], [shared])),
        environment(
          "env-b",
          summary(
            [
              bucket({ sourceId: shared.sourceId }),
              bucket({ sourceId: personal.sourceId, costUsd: 4, records: 2 }),
            ],
            [shared, personal],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.records).toBe(7);
    expect(merged.sessions).toBe(2);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a", "env-b"]);
    expect(merged.profiles.map((profile) => profile.displayName)).toEqual(["Work", "Personal"]);
  });

  it("keeps only the exact source that claimed a same-environment fingerprint", () => {
    const fingerprint = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
      volumeId: "16777220:1234",
    };
    const primary = {
      ...fingerprint,
      sourceId: "claude-primary" as UsageSourceId,
      distinctSessions: 1,
      profile: { instanceId: ProviderInstanceId.make("claude_primary"), displayName: "Primary" },
    };
    const duplicate = {
      ...fingerprint,
      sourceId: "claude-duplicate" as UsageSourceId,
      distinctSessions: 2,
      profile: {
        instanceId: ProviderInstanceId.make("claude_duplicate"),
        displayName: "Duplicate",
      },
    };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ sourceId: primary.sourceId }),
              bucket({ sourceId: duplicate.sourceId, costUsd: 4, records: 2 }),
            ],
            [primary, duplicate],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.profiles.map((profile) => profile.sourceId)).toEqual(["claude-primary"]);
  });

  it("derives totals and diagnostics for each owned profile source", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ sourceId: "claude-work" as UsageSourceId, costUsd: 3, records: 2 }),
              bucket({ sourceId: "claude-work" as UsageSourceId, costUsd: 7, records: 4 }),
            ],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude-work",
                sourceId: "claude-work" as UsageSourceId,
                distinctSessions: 3,
                status: "partial",
                message: "2 transcript files could not be read.",
                profile: {
                  instanceId: ProviderInstanceId.make("claude_work"),
                  displayName: "Work",
                  accentColor: "#7c3aed",
                },
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.profiles).toEqual([
      expect.objectContaining({
        environmentId: "env-a",
        sourceId: "claude-work",
        provider: "claude",
        instanceId: "claude_work",
        label: "Work",
        displayName: "Work",
        accentColor: "#7c3aed",
        status: "partial",
        message: "2 transcript files could not be read.",
        resolvedHomePath: "/a/.claude-work",
        costUsd: 10,
        totalTokens: 2320,
        records: 6,
        sessions: 3,
      }),
    ]);
    expect(merged.providers[0]).toEqual(
      expect.objectContaining({ provider: "claude", costUsd: 10, totalTokens: 2320, records: 6 }),
    );
  });

  it("keeps a missing profile visible without counting its buckets or sessions", () => {
    const missingSourceId = "claude-missing" as UsageSourceId;
    const readySourceId = "claude-ready" as UsageSourceId;
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ sourceId: missingSourceId, costUsd: 99, records: 9 }),
              bucket({ sourceId: readySourceId, costUsd: 3, records: 2 }),
            ],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/profiles/missing/.claude",
                sourceId: missingSourceId,
                distinctSessions: 9,
                status: "missing",
                message: "Profile directory does not exist.",
                profile: {
                  instanceId: ProviderInstanceId.make("claude_missing"),
                  displayName: "Missing",
                },
              },
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/profiles/ready/.claude",
                sourceId: readySourceId,
                distinctSessions: 1,
                profile: {
                  instanceId: ProviderInstanceId.make("claude_ready"),
                  displayName: "Ready",
                },
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged).toMatchObject({ costUsd: 3, records: 2, sessions: 1 });
    expect(merged.profiles.find((profile) => profile.sourceId === missingSourceId)).toEqual(
      expect.objectContaining({
        status: "missing",
        message: "Profile directory does not exist.",
        resolvedHomePath: "/profiles/missing/.claude",
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      }),
    );
  });

  it("does not treat matching missing fingerprints as duplicate contributions", () => {
    const missing = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/profiles/missing/.claude",
      volumeId: "missing",
      sourceId: "claude-missing" as UsageSourceId,
      status: "missing" as const,
      message: "Profile directory does not exist.",
      profile: {
        instanceId: ProviderInstanceId.make("claude_missing"),
        displayName: "Missing",
      },
    };
    const merged = mergeUsage(
      [environment("env-a", summary([], [missing])), environment("env-b", summary([], [missing]))],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.duplicateSources).toEqual([]);
    expect(merged.profiles).toHaveLength(2);
    expect(merged.sessions).toBe(0);
  });

  it("derives provider shares and cost quality", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 25, unpricedRecords: 5 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers[0]?.provider).toBe("claude");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.75, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.5, 5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac resolves /Users/theo/.claude, so a hostname clash used to make
    // one machine's usage vanish. Filesystem identity separates them.
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("still collapses two servers reading the same directory", () => {
    const same = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
      volumeId: "16777220:1234",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [same])),
        environment("env-b", summary([bucket()], [same])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    // One session that spans two days appears in two buckets. Summing bucket
    // sessions would say 2; the source's distinct count says 1.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
    expect(merged.hourly).toHaveLength(0);
  });

  it("omits providers with no sessions or usage", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 0,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers).toEqual([]);
  });

  it("derives hourly totals without losing the daily rollup", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ hourStart: "2026-08-07T09:37:00.000Z", costUsd: 3 }),
              bucket({ hourStart: "2026-08-07T10:37:00.000Z", costUsd: 7 }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.hourly.map((hour) => [hour.hourStart, hour.costUsd])).toEqual([
      ["2026-08-07T09:37:00.000Z", 3],
      ["2026-08-07T10:37:00.000Z", 7],
    ]);
    expect(merged.daily).toHaveLength(1);
    expect(merged.daily[0]?.costUsd).toBe(10);
  });
});
