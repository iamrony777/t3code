import type { UsageProviderKind } from "@t3tools/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 *
 * Declared `as const` so `usageChartData.test.ts` can prove it covers every
 * provider the contract defines: one missing here is invisible in the chart and
 * the legend, and the plain `UsageProviderKind[]` annotation this used to carry
 * made that a silent omission.
 */
export const PROVIDER_ORDER = [
  "codex",
  "claude",
  "commandcode",
] as const satisfies readonly UsageProviderKind[];

/**
 * Providers worth rendering for the data on screen, in {@link PROVIDER_ORDER}.
 *
 * A provider a user never runs would otherwise hold a permanently-zero band and
 * legend entry. With nothing to narrow to, the full order stands.
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

/**
 * Claude's brand orange holds in both themes; Codex is neutral and must flip
 * with the theme or its bars vanish against the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    commandcode: "#a78bfa",
  };
}
