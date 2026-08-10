/**
 * Shapes merged daily totals into the per-day provider stacks both chart
 * implementations (Swift Charts on iOS, plain views elsewhere) render.
 *
 * @module usageChartData
 */
import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

export type UsageChartMetric = "cost" | "tokens";

export interface UsageChartDay {
  readonly day: string;
  /** In the given provider order, i.e. bottom of the stack first. */
  readonly values: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
  readonly total: number;
}

/**
 * One entry per day in the window, zero-filled where nothing happened.
 *
 * `providers` is the set worth drawing (see `visibleProviders`), so a provider
 * the user never runs does not stack a permanently-zero band on every bar.
 */
export function buildChartDays(
  days: readonly string[],
  daily: readonly DailyTotals[],
  metric: UsageChartMetric,
  providers: readonly UsageProviderKind[],
): readonly UsageChartDay[] {
  const byDay = new Map(daily.map((totals) => [totals.day, totals]));
  return days.map((day) => {
    const totals = byDay.get(day);
    const values = providers.map((provider) => {
      const entry = totals?.byProvider.get(provider);
      const value = entry === undefined ? 0 : metric === "cost" ? entry.costUsd : entry.totalTokens;
      return { provider, value };
    });
    return {
      day,
      values,
      total: values.reduce((sum, entry) => sum + entry.value, 0),
    };
  });
}
