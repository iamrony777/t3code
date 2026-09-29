import { describe, expect, it } from "vitest";
import withAndroidFbjniVersion from "./withAndroidFbjniVersion.cjs";

const buildGradle = `buildscript {
  repositories {
    google()
    mavenCentral()
  }
}
`;

async function transform(contents, language = "groovy") {
  const config = withAndroidFbjniVersion({ name: "Test", slug: "test" });
  const result = await config.mods.android.projectBuildGradle({
    ...config,
    modRequest: { platform: "android", modName: "projectBuildGradle", introspect: false },
    modResults: { language, contents },
  });
  return result.modResults.contents;
}

describe("Android fbjni version generation", () => {
  it("forces React Native's fbjni version across clean prebuilds", async () => {
    const generated = await transform(buildGradle);
    expect(generated).toContain("resolutionStrategy.force 'com.facebook.fbjni:fbjni:0.7.0'");
    expect(await transform(generated)).toBe(generated);
  });

  it("fails when the project build file is no longer Groovy", async () => {
    await expect(transform(buildGradle, "kotlin")).rejects.toThrow(
      "project build.gradle must use Groovy",
    );
  });
});
