export type ProviderIconKind =
  | "antigravity"
  | "claudeAgent"
  | "commandcode"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "unknown";

export function providerIconKind(provider: string | null | undefined): ProviderIconKind {
  const normalized = provider?.trim();
  if (normalized?.toLowerCase() === "antigravity") return "antigravity";
  if (
    normalized === "claudeAgent" ||
    normalized === "commandcode" ||
    normalized === "codex" ||
    normalized === "cursor" ||
    normalized === "grok" ||
    normalized === "opencode"
  ) {
    return normalized;
  }
  return "unknown";
}
