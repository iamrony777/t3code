import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  getClaudeCapabilitiesForRefresh,
  makeClaudeActiveUsageCooldownKey,
} from "./ClaudeDriver.ts";

it.effect("an explicit limits refresh bypasses the passive Claude capability cache", () =>
  Effect.gen(function* () {
    let current: {
      email: string;
      usage: {
        rate_limits_available: boolean;
        rate_limits: null | {
          five_hour: { used_percentage: number; resets_at: number };
          seven_day: { used_percentage: number; resets_at: number };
        };
      };
    } = {
      email: "first@example.test",
      usage: { rate_limits_available: true, rate_limits: null },
    };
    let probes = 0;
    const cache = yield* Cache.make({
      capacity: 1,
      timeToLive: "5 minutes",
      lookup: () =>
        Effect.sync(() => {
          probes += 1;
          return current;
        }),
    });

    expect(yield* getClaudeCapabilitiesForRefresh(cache, "profile", false)).toEqual(current);
    current = {
      email: "second@example.test",
      usage: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { used_percentage: 20, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 30, resets_at: 1_800_086_400 },
        },
      },
    };

    expect((yield* getClaudeCapabilitiesForRefresh(cache, "profile", false)).email).toBe(
      "first@example.test",
    );
    expect((yield* getClaudeCapabilitiesForRefresh(cache, "profile", true)).email).toBe(
      "second@example.test",
    );
    expect(probes).toBe(2);
  }),
);

it.effect("scopes the active usage cooldown to instance auth and credential contents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-cooldown-key-" });
    const credentials = path.join(profile, ".credentials.json");
    yield* fs.writeFileString(credentials, '{"oauth":"account-a"}');
    const key = (instanceId: string, token: string) =>
      makeClaudeActiveUsageCooldownKey({
        instanceId,
        profilePath: profile,
        environment: { CLAUDE_CODE_OAUTH_TOKEN: token },
      });

    const first = yield* key("claude_work", "token-a");
    expect(yield* key("claude_work", "token-a")).toBe(first);
    expect(yield* key("claude_personal", "token-a")).not.toBe(first);
    expect(yield* key("claude_work", "token-b")).not.toBe(first);
    expect(first).not.toContain("token-a");
    expect(first).not.toContain("account-a");

    yield* fs.writeFileString(credentials, '{"oauth":"account-b"}');
    expect(yield* key("claude_work", "token-a")).not.toBe(first);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
