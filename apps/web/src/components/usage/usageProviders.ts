import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, CommandCodeIcon, type Icon, OpenAI } from "../Icons";

/**
 * Series and table order. The chart layers every provider from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 *
 * Declared `as const` so `usageProviders.test.ts` can prove it covers every
 * provider the contract defines: one missing here is invisible in every chart,
 * legend and table, and the plain `UsageProviderKind[]` annotation this used to
 * carry made that a silent omission.
 */
export const PROVIDER_ORDER = [
  "codex",
  "claude",
  "commandcode",
] as const satisfies readonly UsageProviderKind[];

/**
 * Providers worth rendering for the data on screen, in {@link PROVIDER_ORDER}.
 *
 * A provider a user never runs would otherwise hold a permanently-zero column,
 * legend entry and chart band. With nothing to narrow to, the full order stands
 * so the empty state keeps the loaded page's shape.
 */
export function visibleProviders(
  providers: readonly { readonly provider: UsageProviderKind }[],
): readonly UsageProviderKind[] {
  const present = new Set(providers.map((entry) => entry.provider));
  const visible = PROVIDER_ORDER.filter((provider) => present.has(provider));
  return visible.length === 0 ? PROVIDER_ORDER : visible;
}

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  commandcode: "Command Code",
};

/** Claude's brand orange against a neutral white for Codex. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  commandcode: "#a78bfa",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills (`#d97757` for Claude, white on dark for OpenAI),
 * which are the same colours as the chart bands, so swapping a colour dot for a
 * mark keeps the series association intact rather than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  commandcode: CommandCodeIcon,
};
