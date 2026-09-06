import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderGlobalOption,
  resolveEnvironmentMachineKind,
  ServerConfig,
  ServerProvider,
  ServerProviderGlobalOptionSetError,
  ServerProviderGlobalOptionSetInput,
  ServerProviders,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeProviderGlobalOption = Schema.decodeUnknownSync(ProviderGlobalOption);
const decodeServerProviderGlobalOptionSetInput = (input: unknown) =>
  Schema.decodeUnknownSync(ServerProviderGlobalOptionSetInput)(input);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.globalOptions).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("decodes select and boolean provider-global options", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      globalOptions: [
        {
          id: "account",
          type: "select",
          label: "Account",
          options: [
            { id: "personal", label: "Personal", isDefault: true },
            { id: "work", label: "Work", description: "Company account" },
          ],
          currentValue: "personal",
        },
        {
          id: "fastMode",
          type: "boolean",
          label: "Fast mode",
          description: "Prefer faster responses",
          currentValue: true,
        },
      ],
    });

    expect(parsed.globalOptions).toEqual([
      {
        id: "account",
        type: "select",
        label: "Account",
        options: [
          { id: "personal", label: "Personal", isDefault: true },
          { id: "work", label: "Work", description: "Company account" },
        ],
        currentValue: "personal",
      },
      {
        id: "fastMode",
        type: "boolean",
        label: "Fast mode",
        description: "Prefer faster responses",
        currentValue: true,
      },
    ]);
  });

  it("rejects descriptors with empty ids or labels and select choices with empty fields", () => {
    const invalidDescriptors = [
      { id: "   ", type: "boolean", label: "Fast mode" },
      { id: "fastMode", type: "boolean", label: "   " },
      { id: "account", type: "select", label: "Account" },
      {
        id: "account",
        type: "select",
        label: "Account",
        options: [{ id: "   ", label: "Work" }],
      },
      {
        id: "account",
        type: "select",
        label: "Account",
        options: [{ id: "work", label: "   " }],
      },
    ];

    for (const descriptor of invalidDescriptors) {
      expect(() => decodeProviderGlobalOption(descriptor)).toThrow();
    }
  });

  it("allows select descriptors with no choices under the generic descriptor schema", () => {
    expect(
      decodeProviderGlobalOption({
        id: "account",
        type: "select",
        label: "Account",
        options: [],
      }),
    ).toEqual({ id: "account", type: "select", label: "Account", options: [] });
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional legacy model metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.isLegacy).toBe(true);
  });

  it("decodes an optional structured provider account usage snapshot", () => {
    const accountUsage = {
      checkedAt: "2026-04-10T00:00:00.000Z",
      accountId: "https://api.commandcode.ai:org:org-123",
      accountLabel: "Command Org",
      plan: "Teams Pro",
      status: "active",
      periodStart: "2026-04-01T00:00:00.000Z",
      periodEnd: "2026-05-01T00:00:00.000Z",
      requestCount: 42,
      tokens: { input: 100, output: 25, total: 125 },
      costUsd: 3.5,
      creditsUsed: { total: 3.5, free: 0.5, monthly: 2, purchased: 1 },
      creditsBalance: { total: 12, free: 1, monthly: 8, purchased: 3 },
      studioUsageUrl: "https://commandcode.ai/command-org/settings/usage",
      unavailable: { reason: "probeFailed", message: "Some usage data could not be loaded." },
    } as const;

    const parsed = decodeServerProvider({ ...baseProviderSnapshot, accountUsage });

    expect(parsed.accountUsage).toEqual(accountUsage);
    expect(decodeServerProvider(baseProviderSnapshot).accountUsage).toBeUndefined();
  });

  it("rejects negative, non-finite, and fractional account usage counters", () => {
    const invalidSnapshots = [
      { requestCount: -1 },
      { requestCount: 1.5 },
      { costUsd: Number.POSITIVE_INFINITY },
      { tokens: { total: -1 } },
      { creditsUsed: { free: Number.NaN } },
      { creditsBalance: { purchased: -0.01 } },
    ];

    for (const accountUsage of invalidSnapshots) {
      expect(() =>
        decodeServerProvider({
          ...baseProviderSnapshot,
          accountUsage: { checkedAt: "2026-04-10T00:00:00.000Z", ...accountUsage },
        }),
      ).toThrow();
    }
  });

  it("rejects an empty stable account identifier", () => {
    expect(() =>
      decodeServerProvider({
        ...baseProviderSnapshot,
        accountUsage: {
          checkedAt: "2026-04-10T00:00:00.000Z",
          accountId: "  ",
        },
      }),
    ).toThrow();
  });
});

describe("ServerProviderGlobalOptionSetInput", () => {
  it("accepts string and boolean provider option selections", () => {
    expect(
      decodeServerProviderGlobalOptionSetInput({
        instanceId: "commandcode",
        optionId: "account",
        value: "work",
      }),
    ).toEqual({ instanceId: "commandcode", optionId: "account", value: "work" });
    expect(
      decodeServerProviderGlobalOptionSetInput({
        instanceId: "commandcode",
        optionId: "fastMode",
        value: false,
      }),
    ).toEqual({ instanceId: "commandcode", optionId: "fastMode", value: false });
  });

  it("rejects empty option ids and invalid selection values", () => {
    expect(() =>
      decodeServerProviderGlobalOptionSetInput({
        instanceId: "commandcode",
        optionId: "   ",
        value: true,
      }),
    ).toThrow();
    expect(() =>
      decodeServerProviderGlobalOptionSetInput({
        instanceId: "commandcode",
        optionId: "account",
        value: "   ",
      }),
    ).toThrow();
    expect(() =>
      decodeServerProviderGlobalOptionSetInput({
        instanceId: "commandcode",
        optionId: "account",
        value: 1,
      }),
    ).toThrow();
  });

  it("carries provider and option context in typed errors", () => {
    const error = new ServerProviderGlobalOptionSetError({
      instanceId: ProviderInstanceId.make("commandcode"),
      optionId: "account",
      message: "Failed to update account.",
    });

    expect(error.instanceId).toBe("commandcode");
    expect(error.optionId).toBe("account");
    expect(error.message).toBe("Failed to update account.");
  });
});

describe("server config forward compatibility", () => {
  it("drops config issues with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  // A provider status this build has never seen (a new ServerProviderState,
  // ServerProviderAuthStatus, etc. member) previously failed the whole
  // `providers` array, taking every other provider down with it and, since
  // `providers` sits inside `ServerConfig`, failing the whole config decode —
  // an older client would drop its connection over one provider it can't
  // render. Dropping just that element keeps every other provider working.
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });
});

describe("resolveEnvironmentMachineKind", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toBe("laptop");
  });

  it("uses detection when nothing is picked", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({}),
      }),
    ).toBe("mac-mini");
  });

  it("falls back to a server for older servers and before connect", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({}),
        settings: decodeSettings({}),
      }),
    ).toBe("server");
    expect(resolveEnvironmentMachineKind(null)).toBe("server");
  });

  it("drops a machine kind this build does not know instead of failing the descriptor", () => {
    const parsed = descriptor({ machine: "toaster" });

    expect(parsed.platform.machine).toBeUndefined();
    expect(
      resolveEnvironmentMachineKind({ environment: parsed, settings: decodeSettings({}) }),
    ).toBe("server");
  });
});
