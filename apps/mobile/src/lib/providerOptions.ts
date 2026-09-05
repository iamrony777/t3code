import type {
  ModelCapabilities,
  ProviderGlobalOption,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
  ServerProviderGlobalOptionSetInput,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}

/**
 * Validates a provider-global change against the selected instance's current
 * snapshot and returns the single native-setting mutation to send immediately.
 */
export function resolveProviderGlobalOptionMutation(input: {
  readonly instanceId: ProviderInstanceId;
  readonly descriptors: ReadonlyArray<ProviderGlobalOption>;
  readonly change: {
    readonly id: string;
    readonly value: ProviderOptionSelectionValue;
  };
}): ServerProviderGlobalOptionSetInput | null {
  const descriptor = input.descriptors.find((candidate) => candidate.id === input.change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof input.change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof input.change.value !== "string" ||
        !descriptor.options.some((option) => option.id === input.change.value)))
  ) {
    return null;
  }

  return {
    instanceId: input.instanceId,
    optionId: descriptor.id,
    value: input.change.value,
  };
}

export async function runProviderGlobalOptionChange(input: {
  readonly instanceId: ProviderInstanceId;
  readonly descriptors: ReadonlyArray<ProviderGlobalOption>;
  readonly change: {
    readonly id: string;
    readonly value: ProviderOptionSelectionValue;
  };
  readonly onSetGlobalOption: (mutation: ServerProviderGlobalOptionSetInput) => Promise<void>;
  readonly onError: (message: string) => void;
}): Promise<boolean> {
  const mutation = resolveProviderGlobalOptionMutation(input);
  if (!mutation) {
    return false;
  }
  try {
    await input.onSetGlobalOption(mutation);
    return true;
  } catch (error) {
    input.onError(
      error instanceof Error ? error.message : "Could not update the provider setting.",
    );
    return false;
  }
}
