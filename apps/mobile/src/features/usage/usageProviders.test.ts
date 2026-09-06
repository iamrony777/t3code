import { UsageProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  providerColorsForScheme,
} from "./usageProviderPresentation";

describe("mobile usage provider presentation", () => {
  it("covers every usage provider and names Command Code", () => {
    expect([...PROVIDER_ORDER].sort()).toEqual([...UsageProviderKind.literals].sort());
    expect(PROVIDER_LABEL.commandcode).toBe("Command Code");
  });

  it("keeps Command Code distinct from the neutral providers in both themes", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = providerColorsForScheme(scheme);
      expect(colors.commandcode).not.toBe(colors.codex);
      expect(colors.commandcode).not.toBe(colors.grok);
    }
  });
});
