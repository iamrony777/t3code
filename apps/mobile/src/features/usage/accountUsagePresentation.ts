import type { ServerProvider, UsageLimitsReport } from "@t3tools/contracts";
import type { ProviderAccountUsageSnapshot } from "@t3tools/shared/usageLimits";
import {
  accountUsageCreditSummary,
  accountUsageUnavailableMessage,
} from "@t3tools/shared/usageLimits";
import {
  formatCount,
  formatDateTimeShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";

export const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  commandcode: "Command Code",
};

export interface AccountUsagePresentation {
  readonly label: string;
  readonly context: string;
  readonly unavailable: string | null;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

/** Account identity is context; only provider account usage may name the subscription plan. */
export function providerLimitsDetail(provider: ServerProvider): string | undefined {
  if (!provider.accountUsage) return provider.auth.label;
  const details = [provider.accountUsage.accountLabel, provider.accountUsage.plan].filter(
    (detail): detail is string => detail !== undefined,
  );
  return details.length > 0 ? details.join(" · ") : undefined;
}

/** Provider and instance names shown by the compact composer limits card. */
export function presentComposerUsageAccount(account: UsageLimitsReport["accounts"][number]): {
  readonly driverLabel: string;
  readonly instanceLabel: string;
} {
  const driverLabel = DRIVER_LABEL[account.driver] ?? String(account.driver);
  return {
    driverLabel,
    instanceLabel: account.instanceId
      ? account.displayName?.trim() ||
        (String(account.instanceId) !== String(account.driver)
          ? String(account.instanceId)
          : driverLabel)
      : account.label,
  };
}

/** Visible text model consumed by the native account-usage card. */
export function presentAccountUsage(
  snapshot: ProviderAccountUsageSnapshot,
): AccountUsagePresentation {
  const { provider } = snapshot;
  const usage = provider.accountUsage;
  const label =
    provider.displayName?.trim() || DRIVER_LABEL[provider.driver] || String(provider.driver);
  const rows: Array<{ readonly label: string; readonly value: string }> = [];
  if (usage.plan || usage.status) {
    rows.push({
      label: "Plan / status",
      value: [usage.plan, usage.status].filter(Boolean).join(" · "),
    });
  }
  if (usage.periodStart || usage.periodEnd) {
    rows.push({
      label: "Billing period",
      value: `${usage.periodStart ? formatDateTimeShort(usage.periodStart) : "Unknown start"} – ${usage.periodEnd ? formatDateTimeShort(usage.periodEnd) : "present"}`,
    });
  }
  if (usage.requestCount !== undefined) {
    rows.push({ label: "Requests", value: formatCount(usage.requestCount) });
  }
  const tokens = [
    usage.tokens?.input === undefined ? null : `${formatTokens(usage.tokens.input)} input`,
    usage.tokens?.output === undefined ? null : `${formatTokens(usage.tokens.output)} output`,
    usage.tokens?.total === undefined ? null : `${formatTokens(usage.tokens.total)} total`,
  ].filter((part): part is string => part !== null);
  if (tokens.length > 0) rows.push({ label: "Tokens", value: tokens.join(" · ") });
  if (usage.costUsd !== undefined) rows.push({ label: "Cost", value: formatUsd(usage.costUsd) });
  const creditsUsed = accountUsageCreditSummary(usage.creditsUsed, formatCount);
  if (creditsUsed) rows.push({ label: "Credits used", value: creditsUsed });
  const creditsBalance = accountUsageCreditSummary(usage.creditsBalance, formatCount);
  if (creditsBalance) rows.push({ label: "Credits balance", value: creditsBalance });

  return {
    label,
    context: `${usage.accountLabel ? `${usage.accountLabel} · ` : ""}${snapshot.environmentLabel} · cached ${formatDateTimeShort(usage.checkedAt)}`,
    unavailable: accountUsageUnavailableMessage(usage.unavailable),
    rows,
  };
}
