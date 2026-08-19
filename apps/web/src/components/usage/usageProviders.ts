import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart, table, legend, and skeleton, so
 * adding a provider only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** The chart layers every series from zero, so order only controls how it is read. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

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
