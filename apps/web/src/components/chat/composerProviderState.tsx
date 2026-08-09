import {
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderGlobalOption,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
  type ServerProviderGlobalOptionSetInput,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

const EMPTY_PROVIDER_GLOBAL_OPTIONS: ReadonlyArray<ProviderGlobalOption> = [];
const EMPTY_PENDING_PROVIDER_GLOBAL_OPTION_IDS: ReadonlySet<string> = new Set();

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  globalOptions?: ReadonlyArray<ProviderGlobalOption>;
  pendingGlobalOptionIds?: ReadonlySet<string>;
  onSetGlobalOption?: (input: ServerProviderGlobalOptionSetInput) => Promise<void>;
  onGlobalOptionError?: (message: string) => void;
};

export function buildProviderGlobalOptionMutationTarget(
  environmentId: EnvironmentId,
  input: ServerProviderGlobalOptionSetInput,
) {
  return { environmentId, input };
}

export function buildProviderGlobalOptionPendingKey(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  optionId: string,
): string {
  return JSON.stringify([environmentId, instanceId, optionId]);
}

export function updateProviderGlobalOptionPendingCounts(
  current: ReadonlyMap<string, number>,
  key: string,
  delta: 1 | -1,
): ReadonlyMap<string, number> {
  const currentCount = current.get(key) ?? 0;
  if (delta === -1 && currentCount === 0) {
    return current;
  }
  const next = new Map(current);
  const nextCount = currentCount + delta;
  if (nextCount > 0) {
    next.set(key, nextCount);
  } else {
    next.delete(key);
  }
  return next;
}

export async function runTrackedProviderGlobalOptionMutation<A>(input: {
  environmentId: EnvironmentId;
  mutation: ServerProviderGlobalOptionSetInput;
  updatePending: (
    update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>,
  ) => void;
  run: () => Promise<A>;
}): Promise<A> {
  const key = buildProviderGlobalOptionPendingKey(
    input.environmentId,
    input.mutation.instanceId,
    input.mutation.optionId,
  );
  input.updatePending((current) => updateProviderGlobalOptionPendingCounts(current, key, 1));
  try {
    return await input.run();
  } finally {
    input.updatePending((current) => updateProviderGlobalOptionPendingCounts(current, key, -1));
  }
}

export function selectPendingProviderGlobalOptionIds(
  pendingCounts: ReadonlyMap<string, number>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): ReadonlySet<string> {
  const optionIds = new Set<string>();
  for (const key of pendingCounts.keys()) {
    try {
      const tuple: unknown = JSON.parse(key);
      if (
        Array.isArray(tuple) &&
        tuple.length === 3 &&
        tuple[0] === environmentId &&
        tuple[1] === instanceId &&
        typeof tuple[2] === "string"
      ) {
        optionIds.add(tuple[2]);
      }
    } catch {
      continue;
    }
  }
  return optionIds.size === 0 ? EMPTY_PENDING_PROVIDER_GLOBAL_OPTION_IDS : optionIds;
}

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions, promptInjectionState = "none" } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
    globalOptions = EMPTY_PROVIDER_GLOBAL_OPTIONS,
    pendingGlobalOptionIds,
    onSetGlobalOption,
    onGlobalOptionError,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({ provider, models, model, modelOptions, prompt, globalOptions })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      prompt={prompt}
      onPromptChange={onPromptChange}
      globalOptions={globalOptions}
      {...(pendingGlobalOptionIds !== undefined ? { pendingGlobalOptionIds } : {})}
      {...(onSetGlobalOption ? { onSetGlobalOption } : {})}
      {...(onGlobalOptionError ? { onGlobalOptionError } : {})}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}
