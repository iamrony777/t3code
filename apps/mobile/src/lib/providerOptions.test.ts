import { describe, expect, it, vi } from "vite-plus/test";

import {
  ProviderInstanceId,
  type ModelCapabilities,
  type ProviderGlobalOption,
} from "@t3tools/contracts";

import {
  applyProviderOptionSelection,
  providerOptionValueLabels,
  resolveProviderGlobalOptionMutation,
  resolveProviderOptionDescriptors,
  runProviderGlobalOptionChange,
} from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

const COMMAND_CODE_INSTANCE_ID = ProviderInstanceId.make("commandCode-local");
const COMMAND_CODE_GLOBAL_OPTIONS: ReadonlyArray<ProviderGlobalOption> = [
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

describe("mobile provider options", () => {
  it("summarizes the option values currently in effect", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual(["Medium", "Standard"]);
  });

  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("treats an unspecified boolean capability as off", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual([]);
    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });

  it("builds one provider-global mutation without returning model options", () => {
    const mutation = resolveProviderGlobalOptionMutation({
      instanceId: COMMAND_CODE_INSTANCE_ID,
      descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
      change: { id: "compactMode", value: "fast" },
    });

    expect(mutation).toEqual({
      instanceId: COMMAND_CODE_INSTANCE_ID,
      optionId: "compactMode",
      value: "fast",
    });
    expect(mutation).not.toHaveProperty("options");
    expect(
      resolveProviderGlobalOptionMutation({
        instanceId: COMMAND_CODE_INSTANCE_ID,
        descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
        change: { id: "tasteLearning", value: true },
      }),
    ).toEqual({
      instanceId: COMMAND_CODE_INSTANCE_ID,
      optionId: "tasteLearning",
      value: true,
    });
  });

  it("rejects provider-global ids, primitive types, and choices not advertised", () => {
    expect(
      resolveProviderGlobalOptionMutation({
        instanceId: COMMAND_CODE_INSTANCE_ID,
        descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
        change: { id: "unknown", value: "fast" },
      }),
    ).toBeNull();
    expect(
      resolveProviderGlobalOptionMutation({
        instanceId: COMMAND_CODE_INSTANCE_ID,
        descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
        change: { id: "tasteLearning", value: "true" },
      }),
    ).toBeNull();
    expect(
      resolveProviderGlobalOptionMutation({
        instanceId: COMMAND_CODE_INSTANCE_ID,
        descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
        change: { id: "compactMode", value: true },
      }),
    ).toBeNull();
    expect(
      resolveProviderGlobalOptionMutation({
        instanceId: COMMAND_CODE_INSTANCE_ID,
        descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
        change: { id: "compactMode", value: "turbo" },
      }),
    ).toBeNull();
  });

  it("reports a native mutation failure without changing the server snapshot value", async () => {
    const onSetGlobalOption = vi.fn().mockRejectedValue(new Error("native write failed"));
    const onError = vi.fn();

    await expect(
      runProviderGlobalOptionChange({
        instanceId: COMMAND_CODE_INSTANCE_ID,
        descriptors: COMMAND_CODE_GLOBAL_OPTIONS,
        change: { id: "compactMode", value: "fast" },
        onSetGlobalOption,
        onError,
      }),
    ).resolves.toBe(false);

    expect(onSetGlobalOption).toHaveBeenCalledWith({
      instanceId: COMMAND_CODE_INSTANCE_ID,
      optionId: "compactMode",
      value: "fast",
    });
    expect(onError).toHaveBeenCalledWith("native write failed");
    expect(COMMAND_CODE_GLOBAL_OPTIONS[0]?.currentValue).toBe("normal");
  });
});
