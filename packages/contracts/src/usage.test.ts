import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UsageSummary, UsageSummaryInput } from "./usage.ts";

const decodeUsageSummary = Schema.decodeUnknownSync(UsageSummary);
const decodeUsageSummaryInput = Schema.decodeUnknownSync(UsageSummaryInput);
const encodeUsageSummary = Schema.encodeSync(UsageSummary);

const bucket = (provider: string) => ({
  day: "2026-08-09",
  provider,
  model: "some-model",
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 5,
    cacheCreationTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
  },
  costUsd: 1.5,
  cacheSavingsUsd: 0.25,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
});

const source = (provider: string) => ({
  fingerprint: {
    hostId: "host",
    provider,
    resolvedHomePath: `/home/user/.${provider}/projects`,
    volumeId: "1:2",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});

const summary = {
  contractVersion: 3,
  readAt: "2026-08-09T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-08-01",
  untilDay: "2026-08-09",
  buckets: [bucket("claude"), bucket("someFutureProvider"), bucket("codex")],
  sources: [source("claude"), source("someFutureProvider"), source("codex")],
  pricing: {
    status: "fresh",
    source: "https://example.test/rates.json",
    fetchedAt: null,
    knownModels: 1,
  },
  scanDurationMs: 12,
};

describe("UsageSummary forward compatibility", () => {
  // Regression: a mobile build shipped before a provider was added to
  // `UsageProviderKind` failed the whole response over that provider's literal,
  // so every user of that build saw "could not report usage" for claude and
  // codex too — whether or not they had ever run the new provider.
  it("drops buckets whose provider this build does not know", () => {
    const parsed = decodeUsageSummary(summary);

    expect(parsed.buckets.map((entry) => entry.provider)).toEqual(["claude", "codex"]);
    expect(parsed.buckets[0]?.costUsd).toBe(1.5);
  });

  it("drops sources whose provider this build does not know", () => {
    const parsed = decodeUsageSummary(summary);

    expect(parsed.sources.map((entry) => entry.fingerprint.provider)).toEqual(["claude", "codex"]);
  });

  it("still encodes what a server sends", () => {
    // The server encodes this schema on every usage response, so the tolerant
    // decode must not cost the encode direction.
    const encoded = encodeUsageSummary(decodeUsageSummary(summary));

    expect(encoded.buckets).toEqual([bucket("claude"), bucket("codex")]);
    expect(encoded.sources).toEqual([source("claude"), source("codex")]);
  });

  it("keeps the rest of the summary intact", () => {
    const parsed = decodeUsageSummary(summary);

    expect(parsed.contractVersion).toBe(3);
    expect(parsed.sinceDay).toBe("2026-08-01");
    expect(parsed.pricing.knownModels).toBe(1);
  });

  it("decodes commandcode buckets and source profiles", () => {
    const parsed = decodeUsageSummary({
      ...summary,
      buckets: [{ ...bucket("commandcode"), sourceId: "commandcode-work" }],
      sources: [
        {
          ...source("commandcode"),
          sourceId: "commandcode-work",
          profile: {
            instanceId: "commandcode_work",
            displayName: "Work",
            accentColor: "#7c3aed",
          },
        },
      ],
    });

    expect(parsed.buckets[0]?.provider).toBe("commandcode");
    expect(parsed.buckets[0]?.sourceId).toBe("commandcode-work");
    expect(parsed.sources[0]?.profile?.instanceId).toBe("commandcode_work");
    expect(parsed.sources[0]?.profile?.displayName).toBe("Work");
  });

  it("keeps known supported providers while dropping future provider literals", () => {
    const parsed = decodeUsageSummaryInput({
      sinceDay: "2026-08-01",
      untilDay: "2026-08-09",
      timeZone: "UTC",
      supportedProviders: ["claude", "someFutureProvider", "commandcode"],
    });

    expect(parsed.supportedProviders).toEqual(["claude", "commandcode"]);
  });

  it("keeps legacy summaries without source identity or profile metadata", () => {
    const parsed = decodeUsageSummary({
      ...summary,
      contractVersion: 4,
      buckets: [bucket("claude")],
      sources: [source("claude")],
    });

    expect(parsed.buckets[0]?.sourceId).toBeUndefined();
    expect(parsed.sources[0]?.sourceId).toBeUndefined();
    expect(parsed.sources[0]?.profile).toBeUndefined();
  });
});
