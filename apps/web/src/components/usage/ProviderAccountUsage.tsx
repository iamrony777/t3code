import type { ServerProviderAccountUsage } from "@t3tools/contracts";
import {
  accountUsageCreditSummary,
  accountUsageUnavailableMessage,
  type ProviderAccountUsageSnapshot,
} from "@t3tools/shared/usageLimits";
import {
  formatCount,
  formatDateTimeShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";

export function safeStudioUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const expectedHost =
      url.hostname === "commandcode.ai" || url.hostname.endsWith(".commandcode.ai");
    return url.protocol === "https:" && expectedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function Credits({
  label,
  credits,
}: {
  readonly label: string;
  readonly credits: ServerProviderAccountUsage["creditsUsed"];
}) {
  if (!credits) return null;
  const summary = accountUsageCreditSummary(credits, formatCount);
  if (!summary) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground tabular-nums">{summary}</span>
    </div>
  );
}

export function ProviderAccountUsage({
  snapshot,
}: {
  readonly snapshot: ProviderAccountUsageSnapshot;
}) {
  const { provider } = snapshot;
  const usage = provider.accountUsage;
  const label =
    provider.displayName?.trim() ||
    getDriverOption(provider.driver)?.label ||
    String(provider.driver);
  const studioUrl = safeStudioUrl(usage.studioUsageUrl);
  const unavailable = accountUsageUnavailableMessage(usage.unavailable);
  const hasTokens =
    usage.tokens &&
    (usage.tokens.input !== undefined ||
      usage.tokens.output !== undefined ||
      usage.tokens.total !== undefined);

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={label}
          accentColor={provider.accentColor}
          showBadge={Boolean(provider.displayName)}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{label}</h3>
          <p className="text-xs text-muted-foreground">
            {usage.accountLabel ? `${usage.accountLabel} · ` : ""}
            {snapshot.environmentLabel} · cached {formatDateTimeShort(usage.checkedAt)}
          </p>
        </div>
        {studioUrl ? (
          <a
            href={studioUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs font-medium text-foreground underline underline-offset-4"
          >
            Open Studio
          </a>
        ) : null}
      </div>
      {unavailable ? <p className="text-sm text-muted-foreground">{unavailable}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {usage.plan || usage.status ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Plan / status</span>
            <span className="text-sm text-foreground">
              {[usage.plan, usage.status].filter(Boolean).join(" · ")}
            </span>
          </div>
        ) : null}
        {usage.periodStart || usage.periodEnd ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Billing period</span>
            <span className="text-sm text-foreground tabular-nums">
              {usage.periodStart ? formatDateTimeShort(usage.periodStart) : "Unknown start"} –{" "}
              {usage.periodEnd ? formatDateTimeShort(usage.periodEnd) : "present"}
            </span>
          </div>
        ) : null}
        {usage.requestCount !== undefined ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Requests</span>
            <span className="text-sm text-foreground tabular-nums">
              {formatCount(usage.requestCount)}
            </span>
          </div>
        ) : null}
        {hasTokens ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Tokens</span>
            <span className="text-sm text-foreground tabular-nums">
              {[
                usage.tokens?.input === undefined
                  ? null
                  : `${formatTokens(usage.tokens.input)} input`,
                usage.tokens?.output === undefined
                  ? null
                  : `${formatTokens(usage.tokens.output)} output`,
                usage.tokens?.total === undefined
                  ? null
                  : `${formatTokens(usage.tokens.total)} total`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ) : null}
        {usage.costUsd !== undefined ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Cost</span>
            <span className="text-sm text-foreground tabular-nums">{formatUsd(usage.costUsd)}</span>
          </div>
        ) : null}
        <Credits label="Credits used" credits={usage.creditsUsed} />
        <Credits label="Credits balance" credits={usage.creditsBalance} />
      </div>
    </article>
  );
}
