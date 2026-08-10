import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderGlobalOptionSetInput,
} from "@t3tools/contracts";

/**
 * In-flight provider-global option mutations, grouped by the (environment,
 * provider instance) scope a picker renders so lookups need no parsing. The
 * inner map holds a reference count per option id.
 */
export type ProviderGlobalOptionPendingCounts = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface ProviderGlobalOptionTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly optionId: string;
}

/** Stable empty result so a picker with nothing in flight never re-renders. */
const EMPTY_PENDING_PROVIDER_GLOBAL_OPTION_IDS: ReadonlySet<string> = new Set();

function pendingScopeKey(environmentId: EnvironmentId, instanceId: ProviderInstanceId): string {
  return `${environmentId}\u0000${instanceId}`;
}

export function updateProviderGlobalOptionPendingCounts(
  current: ProviderGlobalOptionPendingCounts,
  target: ProviderGlobalOptionTarget,
  delta: 1 | -1,
): ProviderGlobalOptionPendingCounts {
  const scopeKey = pendingScopeKey(target.environmentId, target.instanceId);
  const scope = current.get(scopeKey);
  const currentCount = scope?.get(target.optionId) ?? 0;
  if (delta === -1 && currentCount === 0) {
    return current;
  }

  const nextScope = new Map<string, number>(scope);
  const nextCount = currentCount + delta;
  if (nextCount > 0) {
    nextScope.set(target.optionId, nextCount);
  } else {
    nextScope.delete(target.optionId);
  }

  const next = new Map(current);
  if (nextScope.size > 0) {
    next.set(scopeKey, nextScope);
  } else {
    next.delete(scopeKey);
  }
  return next;
}

/**
 * Marks one option pending for the life of `run`, so overlapping changes to the
 * same option only clear once the last one settles.
 */
export async function runTrackedProviderGlobalOptionMutation<A>(input: {
  readonly environmentId: EnvironmentId;
  readonly mutation: ServerProviderGlobalOptionSetInput;
  readonly updatePending: (
    update: (current: ProviderGlobalOptionPendingCounts) => ProviderGlobalOptionPendingCounts,
  ) => void;
  readonly run: () => Promise<A>;
}): Promise<A> {
  const target = {
    environmentId: input.environmentId,
    instanceId: input.mutation.instanceId,
    optionId: input.mutation.optionId,
  };
  input.updatePending((current) => updateProviderGlobalOptionPendingCounts(current, target, 1));
  try {
    return await input.run();
  } finally {
    input.updatePending((current) => updateProviderGlobalOptionPendingCounts(current, target, -1));
  }
}

export function selectPendingProviderGlobalOptionIds(
  pendingCounts: ProviderGlobalOptionPendingCounts,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): ReadonlySet<string> {
  const scope = pendingCounts.get(pendingScopeKey(environmentId, instanceId));
  return scope === undefined || scope.size === 0
    ? EMPTY_PENDING_PROVIDER_GLOBAL_OPTION_IDS
    : new Set(scope.keys());
}
