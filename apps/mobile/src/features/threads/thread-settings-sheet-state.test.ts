import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderGlobalOption,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  buildProviderGlobalOptionPendingKey,
  buildThreadSettingsOptionSections,
  pendingModelAfterPress,
  runTrackedProviderGlobalOptionMutation,
  selectPendingProviderGlobalOptionIds,
  updateProviderGlobalOptionPendingCounts,
} from "./thread-settings-sheet-state";

const ENVIRONMENT_ID = EnvironmentId.make("env-local");
const COMMAND_CODE_INSTANCE_ID = ProviderInstanceId.make("commandCode-local");
const REASONING: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  currentValue: "high",
  options: [
    { id: "default", label: "Default", isDefault: true },
    { id: "high", label: "High" },
  ],
};
const GLOBAL_OPTIONS: ReadonlyArray<ProviderGlobalOption> = [
  {
    id: "compactMode",
    label: "Compact Mode",
    type: "select",
    currentValue: "normal",
    options: [
      { id: "normal", label: "Normal", isDefault: true },
      { id: "fast", label: "Fast" },
    ],
  },
  {
    id: "tasteLearning",
    label: "Taste Learning",
    type: "boolean",
    currentValue: false,
  },
];

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "Codex",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("orders model settings before Compact Mode and Taste Learning", () => {
    const sections = buildThreadSettingsOptionSections(
      [{ label: "Reasoning", type: "select", descriptor: REASONING }],
      GLOBAL_OPTIONS,
      new Set(),
    );

    expect(sections.map(({ domain, label }) => [domain, label])).toEqual([
      ["model", "Reasoning"],
      ["global", "Compact Mode"],
      ["global", "Taste Learning"],
    ]);
  });

  it("keeps global settings visible without a reasoning descriptor", () => {
    const sections = buildThreadSettingsOptionSections([], GLOBAL_OPTIONS, new Set());

    expect(sections.map(({ label }) => label)).toEqual(["Compact Mode", "Taste Learning"]);
  });

  it("disables only the pending provider-global option", () => {
    const sections = buildThreadSettingsOptionSections(
      [{ label: "Reasoning", type: "select", descriptor: REASONING }],
      GLOBAL_OPTIONS,
      new Set(["compactMode"]),
    );

    expect(sections.map(({ label, pending }) => [label, pending])).toEqual([
      ["Reasoning", false],
      ["Compact Mode", true],
      ["Taste Learning", false],
    ]);
  });

  it("keeps an option pending until overlapping values settle in reverse order", async () => {
    let releaseFast: (() => void) | undefined;
    let releaseNormal: (() => void) | undefined;
    const fastGate = new Promise<void>((resolve) => {
      releaseFast = resolve;
    });
    const normalGate = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    let pending: ReadonlyMap<string, number> = new Map();
    const updatePending = (
      update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>,
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

  it("does not inherit pending state after the target environment or instance changes", () => {
    const pending = updateProviderGlobalOptionPendingCounts(
      new Map(),
      buildProviderGlobalOptionPendingKey(ENVIRONMENT_ID, COMMAND_CODE_INSTANCE_ID, "compactMode"),
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
});
