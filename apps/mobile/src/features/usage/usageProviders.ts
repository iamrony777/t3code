import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  providerColorsForScheme,
} from "./usageProviderPresentation";

export { PROVIDER_LABEL, PROVIDER_ORDER, providerColorsForScheme };

/**
 * Claude's brand orange holds in both themes; Codex and Grok are neutrals and
 * must flip with the theme or their bars vanish against the matching background.
 */
export function useProviderColors() {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return providerColorsForScheme(scheme);
}
