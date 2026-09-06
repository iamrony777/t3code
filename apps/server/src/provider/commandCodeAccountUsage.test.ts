import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { TestClock } from "effect/testing";

import {
  COMMAND_CODE_USAGE_MAX_BODY_BYTES,
  CommandCodeAccountUsageProbeError,
  fetchCommandCodeAccountUsage,
  probeCommandCodeAccountUsage,
} from "./commandCodeAccountUsage.ts";

const CHECKED_AT = "2026-09-03T12:00:00.000Z";
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeProbe = (input?: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly authFile?: string;
  readonly fetchJson?: (input: {
    readonly url: string;
    readonly apiKey: string;
    readonly maxBodyBytes: number;
    readonly timeoutMs: number;
  }) => Effect.Effect<unknown, CommandCodeAccountUsageProbeError>;
}) =>
  probeCommandCodeAccountUsage({
    environment: input?.environment ?? { HOME: "/instance/home" },
    checkedAt: CHECKED_AT,
    joinPath: (...parts) => parts.join("/"),
    readFile: () => Effect.succeed(input?.authFile ?? ""),
    fetchJson: input?.fetchJson ?? (() => Effect.succeed({})),
  });

describe("probeCommandCodeAccountUsage", () => {
  it.effect("uses the CLI environment's matching auth file and API origin", () =>
    Effect.gen(function* () {
      const cases = [
        {
          environment: { HOME: "/instance/home", COMMANDCODE_API_ENV: "local", PORT_OFFSET: "7" },
          authFile: "auth.local.json",
          apiOrigin: "http://localhost:9097",
        },
        {
          environment: { HOME: "/instance/home", COMMANDCODE_API_ENV: "staging" },
          authFile: "auth.staging.json",
          apiOrigin: "https://staging-api.commandcode.ai",
        },
        {
          environment: { HOME: "/instance/home", COMMANDCODE_API_ENV: "not-an-environment" },
          authFile: "auth.json",
          apiOrigin: "https://api.commandcode.ai",
        },
        {
          environment: {
            HOME: "/instance/home",
            COMMANDCODE_API_ENV: "staging",
            COMMANDCODE_SANDBOX: "true",
            COMMANDCODE_API_URL: "https://sandbox.example.test",
          },
          authFile: "auth.staging.json",
          apiOrigin: "https://sandbox.example.test",
        },
      ] as const;

      for (const testCase of cases) {
        const requests: Array<{ readonly url: string; readonly apiKey: string }> = [];
        const readPaths: Array<string> = [];
        yield* probeCommandCodeAccountUsage({
          environment: testCase.environment,
          checkedAt: CHECKED_AT,
          joinPath: (...parts) => parts.join("/"),
          readFile: (path) => {
            readPaths.push(path);
            return Effect.succeed(encodeUnknownJson({ apiKey: `key-for-${testCase.authFile}` }));
          },
          fetchJson: ({ url, apiKey }) => {
            requests.push({ url, apiKey });
            return Effect.succeed(url.includes("/whoami") ? { user: { userName: "rony" } } : {});
          },
        });

        expect(readPaths).toEqual([`/instance/home/.commandcode/${testCase.authFile}`]);
        expect(requests).toHaveLength(4);
        expect(requests.every(({ url }) => url.startsWith(testCase.apiOrigin))).toBe(true);
        expect(requests.every(({ apiKey }) => apiKey === `key-for-${testCase.authFile}`)).toBe(
          true,
        );
      }
    }),
  );

  it.effect("rejects invalid local port offsets before constructing or fetching a URL", () =>
    Effect.gen(function* () {
      for (const portOffset of ["0.5", "-1", "56446", "not-a-number"]) {
        let fetchCalled = false;
        const result = yield* makeProbe({
          environment: {
            COMMAND_CODE_API_KEY: "local-key",
            COMMANDCODE_API_ENV: "local",
            PORT_OFFSET: portOffset,
          },
          fetchJson: () => {
            fetchCalled = true;
            return Effect.succeed({});
          },
        });

        expect(fetchCalled).toBe(false);
        expect(result.accountUsage.unavailable?.reason).toBe("probeFailed");
        expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
      }
    }),
  );

  it.effect("ignores a custom API URL unless sandbox mode explicitly enables it", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      yield* makeProbe({
        environment: {
          COMMAND_CODE_API_KEY: "production-key",
          COMMANDCODE_API_URL: "https://wrong-origin.example.test",
        },
        fetchJson: ({ url }) => {
          urls.push(url);
          return Effect.succeed(url.includes("/whoami") ? { user: { userName: "rony" } } : {});
        },
      });

      expect(urls).toHaveLength(4);
      expect(urls.every((url) => url.startsWith("https://api.commandcode.ai"))).toBe(true);
      expect(urls.every((url) => !url.includes("wrong-origin.example.test"))).toBe(true);
    }),
  );

  it.effect("returns unavailable for an invalid sandbox API URL without sending the key", () =>
    Effect.gen(function* () {
      const credential = "invalid-url-secret";
      let fetchCalled = false;
      const result = yield* makeProbe({
        environment: {
          COMMAND_CODE_API_KEY: credential,
          COMMANDCODE_SANDBOX: "true",
          COMMANDCODE_API_URL: "not a valid URL",
        },
        fetchJson: () => {
          fetchCalled = true;
          return Effect.succeed({});
        },
      });

      expect(fetchCalled).toBe(false);
      expect(result.accountUsage.unavailable?.reason).toBe("probeFailed");
      expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(encodeUnknownJson(result)).not.toContain(credential);
      expect(encodeUnknownJson(result)).not.toContain("not a valid URL");
    }),
  );

  it.effect("prefers the instance API key over the sibling auth file", () =>
    Effect.gen(function* () {
      const seenKeys: Array<string> = [];
      yield* makeProbe({
        environment: { HOME: "/instance/home", COMMAND_CODE_API_KEY: " env-secret " },
        authFile: encodeUnknownJson({ apiKey: "file-secret" }),
        fetchJson: ({ apiKey }) => {
          seenKeys.push(apiKey);
          return Effect.succeed({});
        },
      });

      expect(seenKeys).toEqual(["env-secret", "env-secret", "env-secret", "env-secret"]);
    }),
  );

  it.effect("falls back to auth.json beside config.json and reports missing auth safely", () =>
    Effect.gen(function* () {
      const readPaths: Array<string> = [];
      const fromFile = yield* probeCommandCodeAccountUsage({
        environment: { HOME: "/instance/home" },
        checkedAt: CHECKED_AT,
        joinPath: (...parts) => parts.join("/"),
        readFile: (path) => {
          readPaths.push(path);
          return Effect.succeed(encodeUnknownJson({ apiKey: "file-secret" }));
        },
        fetchJson: () => Effect.succeed({}),
      });
      const missing = yield* makeProbe({ authFile: "{}" });

      expect(readPaths).toEqual(["/instance/home/.commandcode/auth.json"]);
      expect(fromFile.accountUsage.unavailable?.reason).toBe("probeFailed");
      expect(missing.accountUsage.unavailable).toEqual({
        reason: "probeFailed",
        message: "Command Code usage authentication is unavailable.",
      });
      expect(missing.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(encodeUnknownJson(missing)).not.toContain("file-secret");
    }),
  );

  it.effect("maps tolerant endpoint data, encoded org queries, windows, and zero caps", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const result = yield* makeProbe({
        environment: { COMMAND_CODE_API_KEY: "secret" },
        fetchJson: ({ url, maxBodyBytes, timeoutMs }) => {
          urls.push(url);
          expect(maxBodyBytes).toBeGreaterThan(0);
          expect(timeoutMs).toBeGreaterThan(0);
          if (url.includes("/whoami")) {
            return Effect.succeed({
              user: { id: "user-123", userName: "rony", ignored: true },
              org: { id: "org one", login: "command-org" },
            });
          }
          if (url.includes("/credits")) {
            return Effect.succeed({
              credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 1, junk: -2 },
              windowLimits: {
                fiveHour: { used: 2, cap: 8, exceeded: false, resetAt: 1_788_454_800_000 },
                weekly: { used: 100, cap: 0, exceeded: true, resetAt: 1_788_998_400_000 },
              },
            });
          }
          if (url.includes("/subscriptions")) {
            return Effect.succeed({
              data: {
                planId: "individual-pro-v1",
                status: "active",
                currentPeriodStart: "2026-09-01T00:00:00Z",
                currentPeriodEnd: "2026-10-01T00:00:00Z",
              },
            });
          }
          return Effect.succeed({
            totalCount: 7,
            totalCost: 4.5,
            totalCredits: 9,
            totalFreeCredits: 1,
            totalMonthlyCredits: 6,
            totalPurchasedCredits: 2,
            totalTokens: 120,
            totalTokensIn: 80,
            totalTokensOut: 40,
          });
        },
      });

      expect(urls).toEqual([
        "https://api.commandcode.ai/alpha/whoami?limits=1",
        "https://api.commandcode.ai/alpha/billing/credits?orgId=org+one",
        "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org+one",
        "https://api.commandcode.ai/alpha/usage/summary?orgId=org+one&since=2026-09-01T00%3A00%3A00Z",
      ]);
      expect(result.accountUsage).toEqual({
        checkedAt: CHECKED_AT,
        accountId: "https://api.commandcode.ai:org:org one",
        accountLabel: "command-org",
        plan: "Pro",
        status: "active",
        periodStart: "2026-09-01T00:00:00Z",
        periodEnd: "2026-10-01T00:00:00Z",
        requestCount: 7,
        tokens: { input: 80, output: 40, total: 120 },
        costUsd: 4.5,
        creditsUsed: { total: 9, free: 1, monthly: 6, purchased: 2 },
        creditsBalance: { monthly: 10, purchased: 5, free: 1, total: 16 },
        studioUsageUrl: "https://commandcode.ai/command-org/settings/usage",
      });
      expect(result.usageLimits).toEqual({
        checkedAt: CHECKED_AT,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5-hour",
            usedPercent: 25,
            resetsAt: "2026-09-03T17:00:00.000Z",
          },
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 0,
            resetsAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      });
      expect(result.accountLabel).toBe("command-org");
    }),
  );

  it.effect("scopes user account identity by API realm and prefers a selected organization", () =>
    Effect.gen(function* () {
      const cases = [
        {
          environment: { COMMAND_CODE_API_KEY: "secret" },
          expected: "https://api.commandcode.ai:user:user-123",
        },
        {
          environment: {
            COMMAND_CODE_API_KEY: "secret",
            COMMANDCODE_API_ENV: "staging",
          },
          expected: "https://staging-api.commandcode.ai:user:user-123",
        },
        {
          environment: {
            COMMAND_CODE_API_KEY: "secret",
            COMMANDCODE_API_ENV: "local",
            PORT_OFFSET: "7",
          },
          expected: "http://localhost:9097:user:user-123",
        },
        {
          environment: {
            COMMAND_CODE_API_KEY: "secret",
            COMMANDCODE_SANDBOX: "true",
            COMMANDCODE_API_URL: "https://custom.example.test/api",
          },
          expected: "https://custom.example.test:user:user-123",
        },
      ] as const;

      for (const testCase of cases) {
        const result = yield* makeProbe({
          environment: testCase.environment,
          fetchJson: ({ url }) =>
            Effect.succeed(url.includes("/whoami") ? { user: { id: "user-123" } } : {}),
        });
        expect(result.accountUsage.accountId).toBe(testCase.expected);
      }

      const organization = yield* makeProbe({
        environment: { COMMAND_CODE_API_KEY: "secret" },
        fetchJson: ({ url }) =>
          Effect.succeed(
            url.includes("/whoami")
              ? { user: { id: "shared-id" }, org: { id: "shared-id", login: "team" } }
              : {},
          ),
      });
      expect(organization.accountUsage.accountId).toBe("https://api.commandcode.ai:org:shared-id");
    }),
  );

  it.effect("retains partial valid account data when independent endpoints fail", () =>
    Effect.gen(function* () {
      const result = yield* makeProbe({
        environment: { COMMAND_CODE_API_KEY: "secret" },
        fetchJson: ({ url }) => {
          if (url.includes("/whoami")) {
            return Effect.succeed({ user: { name: "Rony" } });
          }
          if (url.includes("/credits")) {
            return Effect.fail(new CommandCodeAccountUsageProbeError({ reason: "fetchFailed" }));
          }
          if (url.includes("/subscriptions")) {
            return Effect.succeed({ data: { planId: "unknown_plan", status: "trialing" } });
          }
          return Effect.succeed({ totalCount: 3, totalTokens: 20 });
        },
      });

      expect(result.accountUsage).toMatchObject({
        checkedAt: CHECKED_AT,
        accountLabel: "Rony",
        plan: "unknown_plan",
        status: "trialing",
        requestCount: 3,
        tokens: { total: 20 },
        unavailable: {
          reason: "probeFailed",
          message: "Some Command Code usage data could not be loaded.",
        },
      });
      expect(result.usageLimits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Command Code usage limits could not be loaded.",
      });
      expect(encodeUnknownJson(result)).not.toContain("secret upstream failure");
      expect(encodeUnknownJson(result)).not.toContain("secret");
    }),
  );

  it.effect("fetches credits and subscriptions concurrently after resolving identity", () =>
    Effect.gen(function* () {
      const subscriptionStarted = yield* Deferred.make<void>();
      const probeFiber = yield* makeProbe({
        environment: { COMMAND_CODE_API_KEY: "secret" },
        fetchJson: ({ url }) => {
          if (url.includes("/whoami")) {
            return Effect.succeed({ org: { id: "org-id", login: "command-org" } });
          }
          if (url.includes("/credits")) {
            return Deferred.await(subscriptionStarted).pipe(
              Effect.as({ credits: { monthlyCredits: 10 } }),
            );
          }
          if (url.includes("/subscriptions")) {
            return Deferred.succeed(subscriptionStarted, undefined).pipe(
              Effect.as({ data: { planId: "individual-pro", status: "active" } }),
            );
          }
          return Effect.succeed({ totalCount: 1 });
        },
      }).pipe(Effect.timeoutOption("100 millis"), Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const outcome = yield* Fiber.join(probeFiber);

      expect(outcome._tag).toBe("Some");
      if (outcome._tag === "Some") {
        expect(outcome.value.accountUsage.creditsBalance?.monthly).toBe(10);
        expect(outcome.value.accountUsage.plan).toBe("Pro");
      }
    }),
  );

  it.effect("bounds the whole multi-stage probe with one deadline", () =>
    Effect.gen(function* () {
      const probeFiber = yield* makeProbe({
        environment: { COMMAND_CODE_API_KEY: "secret" },
        fetchJson: ({ url }) => {
          if (url.includes("/whoami")) {
            return Effect.succeed({ user: { userName: "rony" } });
          }
          if (url.includes("/credits")) {
            return Effect.succeed({ credits: { monthlyCredits: 4 } });
          }
          return Effect.sleep("20 seconds").pipe(Effect.as({}));
        },
      }).pipe(Effect.timeoutOption("10 seconds"), Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const outcome = yield* Fiber.join(probeFiber);

      expect(outcome._tag).toBe("Some");
      if (outcome._tag === "Some") {
        expect(outcome.value.accountUsage.unavailable?.reason).toBe("probeFailed");
        expect(outcome.value.accountUsage.accountLabel).toBe("rony");
        expect(outcome.value.accountUsage.creditsBalance?.monthly).toBe(4);
      }
    }),
  );

  it.effect("includes auth file lookup in the overall probe deadline", () =>
    Effect.gen(function* () {
      const probeFiber = yield* probeCommandCodeAccountUsage({
        environment: { HOME: "/instance/home" },
        checkedAt: CHECKED_AT,
        joinPath: (...parts) => parts.join("/"),
        readFile: () => Effect.never,
        fetchJson: () => Effect.die("fetch must not run without auth"),
      }).pipe(Effect.timeoutOption("10 seconds"), Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const outcome = yield* Fiber.join(probeFiber);

      expect(outcome._tag).toBe("Some");
      if (outcome._tag === "Some") {
        expect(outcome.value.accountUsage.unavailable?.reason).toBe("probeFailed");
      }
    }),
  );

  it.effect("marks all-data malformed responses unavailable without exposing credentials", () =>
    Effect.gen(function* () {
      const credential = "credential-that-must-not-leak";
      const result = yield* makeProbe({
        environment: { COMMAND_CODE_API_KEY: credential },
        fetchJson: () => Effect.succeed({ unexpected: { apiKey: credential } }),
      });

      expect(result.accountUsage.unavailable).toEqual({
        reason: "probeFailed",
        message: "Command Code usage data could not be loaded.",
      });
      expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(encodeUnknownJson(result)).not.toContain(credential);
    }),
  );

  it.effect("cancels rejected HTTP response bodies", () => {
    let cancelled = 0;
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel() {
                  cancelled += 1;
                },
              }),
              { status: 500 },
            ),
          ),
        ),
      ),
    );

    return fetchCommandCodeAccountUsage({
      environment: { COMMAND_CODE_API_KEY: "rejected-body-secret" },
      checkedAt: CHECKED_AT,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.accountUsage.unavailable?.reason).toBe("probeFailed");
          expect(cancelled).toBe(4);
        }),
      ),
      Effect.provide(Layer.provideMerge(clientLayer, NodeServices.layer)),
    );
  });

  it.effect("rejects oversized HTTP bodies before parsing them and cancels the body", () => {
    const credential = "oversized-body-secret";
    let cancelled = 0;
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel() {
                  cancelled += 1;
                },
              }),
              {
                headers: { "content-length": String(COMMAND_CODE_USAGE_MAX_BODY_BYTES + 1) },
              },
            ),
          ),
        ),
      ),
    );

    return fetchCommandCodeAccountUsage({
      environment: { COMMAND_CODE_API_KEY: credential },
      checkedAt: CHECKED_AT,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.accountUsage.unavailable?.reason).toBe("probeFailed");
          expect(encodeUnknownJson(result)).not.toContain(credential);
          expect(cancelled).toBe(4);
        }),
      ),
      Effect.provide(Layer.provideMerge(clientLayer, NodeServices.layer)),
    );
  });

  it.effect("stops and cancels a chunked response as soon as it exceeds the body cap", () => {
    let cancelled = 0;
    let pulls = 0;
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/summary")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    pulls += 1;
                    controller.enqueue(
                      pulls === 1
                        ? new Uint8Array(COMMAND_CODE_USAGE_MAX_BODY_BYTES)
                        : new Uint8Array([1]),
                    );
                  },
                  cancel() {
                    cancelled += 1;
                  },
                }),
              ),
            ),
          );
        }
        const body = url.pathname.endsWith("/whoami")
          ? { user: { userName: "rony" } }
          : url.pathname.endsWith("/credits")
            ? { credits: { monthlyCredits: 1 } }
            : { data: { planId: "individual-pro", status: "active" } };
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      }),
    );

    return fetchCommandCodeAccountUsage({
      environment: { COMMAND_CODE_API_KEY: "chunked-body-secret" },
      checkedAt: CHECKED_AT,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.accountUsage.creditsBalance?.monthly).toBe(1);
          expect(result.accountUsage.unavailable?.reason).toBe("probeFailed");
          expect(cancelled).toBe(1);
          expect(pulls).toBeLessThanOrEqual(2);
        }),
      ),
      Effect.provide(Layer.provideMerge(clientLayer, NodeServices.layer)),
    );
  });
});
