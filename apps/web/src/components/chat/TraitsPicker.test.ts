import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderGlobalOption,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  buildTraitsMenuSections,
  buildTraitsTriggerDisplay,
  runProviderGlobalOptionChange,
  TraitsPicker,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");
const COMMAND_CODE = ProviderDriverKind.make("commandCode");
const COMMAND_CODE_INSTANCE = ProviderInstanceId.make("commandCode");

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

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
    });
  });

  it("shows the bolt instead of a text label when fast mode is on", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
    });
  });

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({
      label: "High",
      showFastModeIcon: false,
    });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({
      label: "High",
      showFastModeIcon: true,
    });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({
      label: "High · Flex",
      showFastModeIcon: false,
    });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({
      label: "Standard",
      showFastModeIcon: false,
    });
    expect(display([serviceTierDescriptor("priority")])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({
      label: "High · Thinking On",
      showFastModeIcon: false,
    });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
    expect(display([fastModeDescriptor(false)])).toEqual({
      label: "Normal",
      showFastModeIcon: false,
    });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "", showFastModeIcon: false });
  });

  it("still renders the prompt-controlled ultrathink label alongside the bolt", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink", showFastModeIcon: true });
  });

  it("keeps provider-global values out of the reasoning trigger", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: COMMAND_CODE,
        descriptors: [EFFORT],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: false,
      }),
    ).toEqual({ label: "High", showFastModeIcon: false });
  });

  it("gives a global-only traits trigger a stable accessible label", () => {
    const markup = renderToStaticMarkup(
      createElement(TraitsPicker, {
        provider: COMMAND_CODE,
        instanceId: COMMAND_CODE_INSTANCE,
        models: [
          {
            slug: "fixed-model",
            name: "Fixed Model",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
        ],
        model: "fixed-model",
        prompt: "",
        onPromptChange: () => {},
        onModelOptionsChange: () => {},
        globalOptions: GLOBAL_OPTIONS,
        onSetGlobalOption: async () => {},
        planModeEnabled: false,
      }),
    );

    expect(markup).toContain('aria-label="Options"');
    expect(markup).toContain(">Options<");
    expect(markup).not.toContain(">Fast<");
    expect(markup).not.toContain("Taste Learning On");
  });
});

describe("Command Code global traits", () => {
  it("renders Reasoning, Compact Mode, then Taste Learning with dividers", () => {
    expect(buildTraitsMenuSections([EFFORT], GLOBAL_OPTIONS, new Set())).toEqual([
      { domain: "model", descriptor: EFFORT, separatorBefore: false, pending: false },
      { domain: "global", descriptor: GLOBAL_OPTIONS[0], separatorBefore: true, pending: false },
      { domain: "global", descriptor: GLOBAL_OPTIONS[1], separatorBefore: true, pending: false },
    ]);
  });

  it("renders global sections when the model has no reasoning descriptor", () => {
    expect(buildTraitsMenuSections([], GLOBAL_OPTIONS, new Set())).toEqual([
      { domain: "global", descriptor: GLOBAL_OPTIONS[0], separatorBefore: false, pending: false },
      { domain: "global", descriptor: GLOBAL_OPTIONS[1], separatorBefore: true, pending: false },
    ]);
  });

  it("disables only the pending global section", () => {
    const sections = buildTraitsMenuSections([EFFORT], GLOBAL_OPTIONS, new Set(["compactMode"]));

    expect(sections.map(({ descriptor, pending }) => [descriptor.id, pending])).toEqual([
      ["reasoningEffort", false],
      ["compactMode", true],
      ["tasteLearning", false],
    ]);
  });

  it("routes a global change without mutating the displayed snapshot on failure", async () => {
    const onSetGlobalOption = vi.fn().mockRejectedValue(new Error("native write failed"));
    const onGlobalOptionError = vi.fn();

    await runProviderGlobalOptionChange({
      instanceId: COMMAND_CODE_INSTANCE,
      option: GLOBAL_OPTIONS[0]!,
      value: "fast",
      onSetGlobalOption,
      onGlobalOptionError,
    });

    expect(onSetGlobalOption).toHaveBeenCalledWith({
      instanceId: COMMAND_CODE_INSTANCE,
      optionId: "compactMode",
      value: "fast",
    });
    expect(onGlobalOptionError).toHaveBeenCalledWith("native write failed");
    expect(GLOBAL_OPTIONS[0]?.currentValue).toBe("normal");
  });
});
