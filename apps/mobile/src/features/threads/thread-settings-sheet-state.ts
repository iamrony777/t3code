import type { ProviderGlobalOption, ProviderOptionDescriptor } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";

export interface ThreadSettingsModelOptionRow {
  readonly label: string;
  readonly type: "select" | "boolean";
  readonly descriptor: ProviderOptionDescriptor | undefined;
}

export type ThreadSettingsOptionSection =
  | (ThreadSettingsModelOptionRow & {
      readonly domain: "model";
      readonly pending: false;
    })
  | {
      readonly domain: "global";
      readonly label: string;
      readonly type: "select" | "boolean";
      readonly descriptor: ProviderGlobalOption;
      readonly pending: boolean;
    };

export function buildThreadSettingsOptionSections(
  modelRows: ReadonlyArray<ThreadSettingsModelOptionRow>,
  globalOptions: ReadonlyArray<ProviderGlobalOption>,
  pendingGlobalOptionIds: ReadonlySet<string>,
): ReadonlyArray<ThreadSettingsOptionSection> {
  return [
    ...modelRows.map((row) => ({ ...row, domain: "model" as const, pending: false as const })),
    ...globalOptions.map((descriptor) => ({
      domain: "global" as const,
      label: descriptor.label,
      type: descriptor.type,
      descriptor,
      pending: pendingGlobalOptionIds.has(descriptor.id),
    })),
  ];
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}
