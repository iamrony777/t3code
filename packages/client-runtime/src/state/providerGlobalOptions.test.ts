import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  runTrackedProviderGlobalOptionMutation,
  selectPendingProviderGlobalOptionIds,
  updateProviderGlobalOptionPendingCounts,
  type ProviderGlobalOptionPendingCounts,
} from "./providerGlobalOptions.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-local");
const COMMAND_CODE_INSTANCE_ID = ProviderInstanceId.make("commandCode-local");

describe("provider global option pending counts", () => {
  it("keeps an option pending until overlapping values settle in reverse order", async () => {
    let releaseFast: (() => void) | undefined;
    let releaseNormal: (() => void) | undefined;
    const fastGate = new Promise<void>((resolve) => {
      releaseFast = resolve;
    });
    const normalGate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    let pending: ProviderGlobalOptionPendingCounts = new Map();
    const updatePending = (
      update: (current: ProviderGlobalOptionPendingCounts) => ProviderGlobalOptionPendingCounts,
    ) => {
      pending = update(pending);
    };
    const fast = runTrackedProviderGlobalOptionMutation({
      environmentId: ENVIRONMENT_ID,
      mutation: {
        instanceId: COMMAND_CODE_INSTANCE_ID,
        optionId: "compactMode",
        value: "fast",
      },
      updatePending,
      run: () => fastGate,
    });
    const normal = runTrackedProviderGlobalOptionMutation({
      environmentId: ENVIRONMENT_ID,
      mutation: {
        instanceId: COMMAND_CODE_INSTANCE_ID,
        optionId: "compactMode",
        value: "normal",
      },
      updatePending,
      run: () => normalGate,
    });

    releaseNormal?.();
    await normal;
    expect(
      selectPendingProviderGlobalOptionIds(pending, ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID),
    ).toEqual(new Set(["compactMode"]));

    releaseFast?.();
    await fast;
    expect(pending.size).toBe(0);
  });

  it("keeps concurrent options pending independently", async () => {
    let releaseCompact: (() => void) | undefined;
    let releaseTaste: (() => void) | undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const tasteGate = new Promise<void>((resolve) => {
      releaseTaste = resolve;
    });
    let pending: ProviderGlobalOptionPendingCounts = new Map();
    const updatePending = (
      update: (current: ProviderGlobalOptionPendingCounts) => ProviderGlobalOptionPendingCounts,
    ) => {
      pending = update(pending);
    };
    const compact = runTrackedProviderGlobalOptionMutation({
      environmentId: ENVIRONMENT_ID,
      mutation: { instanceId: COMMAND_CODE_INSTANCE_ID, optionId: "compactMode", value: "fast" },
      updatePending,
      run: () => compactGate,
    });
    const taste = runTrackedProviderGlobalOptionMutation({
      environmentId: ENVIRONMENT_ID,
      mutation: { instanceId: COMMAND_CODE_INSTANCE_ID, optionId: "tasteLearning", value: true },
      updatePending,
      run: () => tasteGate,
    });

    expect([
      ...selectPendingProviderGlobalOptionIds(pending, ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID),
    ]).toEqual(["compactMode", "tasteLearning"]);

    releaseCompact?.();
    await compact;
    expect([
      ...selectPendingProviderGlobalOptionIds(pending, ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID),
    ]).toEqual(["tasteLearning"]);

    releaseTaste?.();
    await taste;
    expect(pending.size).toBe(0);
  });

  it("does not inherit pending state after the target environment or instance changes", () => {
    const pending = updateProviderGlobalOptionPendingCounts(
      new Map(),
      {
        environmentId: ENVIRONMENT_ID,
        instanceId: COMMAND_CODE_INSTANCE_ID,
        optionId: "compactMode",
      },
      1,
    );

    expect(
      selectPendingProviderGlobalOptionIds(
        pending,
        EnvironmentId.make("env-other"),
        COMMAND_CODE_INSTANCE_ID,
      ).size,
    ).toBe(0);
    expect(
      selectPendingProviderGlobalOptionIds(
        pending,
        ENVIRONMENT_ID,
        ProviderInstanceId.make("commandCode-other"),
      ).size,
    ).toBe(0);
  });

  it("ignores decrements below zero and forgets the scope once every option settles", () => {
    const compactMode = {
      environmentId: ENVIRONMENT_ID,
      instanceId: COMMAND_CODE_INSTANCE_ID,
      optionId: "compactMode",
    };
    const tasteLearning = { ...compactMode, optionId: "tasteLearning" };
    const empty: ProviderGlobalOptionPendingCounts = new Map();

    expect(updateProviderGlobalOptionPendingCounts(empty, compactMode, -1)).toBe(empty);

    const pending = updateProviderGlobalOptionPendingCounts(
      updateProviderGlobalOptionPendingCounts(empty, compactMode, 1),
      tasteLearning,
      1,
    );
    expect(
      selectPendingProviderGlobalOptionIds(pending, ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID),
    ).toEqual(new Set(["compactMode", "tasteLearning"]));

    const settled = updateProviderGlobalOptionPendingCounts(
      updateProviderGlobalOptionPendingCounts(pending, compactMode, -1),
      tasteLearning,
      -1,
    );
    expect(settled.size).toBe(0);
  });

  it("returns one shared empty set so idle pickers keep a stable reference", () => {
    const empty: ProviderGlobalOptionPendingCounts = new Map();
    const other = updateProviderGlobalOptionPendingCounts(
      empty,
      {
        environmentId: EnvironmentId.make("env-other"),
        instanceId: COMMAND_CODE_INSTANCE_ID,
        optionId: "compactMode",
      },
      1,
    );

    expect(
      selectPendingProviderGlobalOptionIds(empty, ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID),
    ).toBe(selectPendingProviderGlobalOptionIds(other, ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID));
  });

  it("separates scopes whose environment and instance ids would otherwise concatenate alike", () => {
    const pending = updateProviderGlobalOptionPendingCounts(
      new Map(),
      {
        environmentId: EnvironmentId.make("env"),
        instanceId: ProviderInstanceId.make("local-commandCode"),
        optionId: "compactMode",
      },
      1,
    );

    expect(
      selectPendingProviderGlobalOptionIds(
        pending,
        EnvironmentId.make("env-local"),
        ProviderInstanceId.make("commandCode"),
      ).size,
    ).toBe(0);
  });
});
