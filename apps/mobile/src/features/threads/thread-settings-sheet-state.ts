import type {
  EnvironmentId,
  ProviderGlobalOption,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderGlobalOptionSetInput,
} from "@t3tools/contracts";

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
  readonly environmentId: EnvironmentId;
  readonly mutation: ServerProviderGlobalOptionSetInput;
  readonly updatePending: (
    update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>,
  ) => void;
  readonly run: () => Promise<A>;
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
  return optionIds;
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
