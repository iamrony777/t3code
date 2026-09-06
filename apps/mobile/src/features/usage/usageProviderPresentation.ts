import type { UsageProviderKind } from "@t3tools/contracts";

export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "commandcode",
  "opencode",
  "grok",
];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  commandcode: "Command Code",
  opencode: "OpenCode",
  grok: "Grok Build",
};

export function providerColorsForScheme(
  scheme: "light" | "dark",
): Record<UsageProviderKind, string> {
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    commandcode: scheme === "dark" ? "#a78bfa" : "#7c3aed",
    opencode: scheme === "dark" ? "#34d399" : "#059669",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
  };
}
