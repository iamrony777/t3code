import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  createCommandCodeGlobalOptionsController,
  parseCommandCodeGlobalSettings,
  resolveCommandCodeSettingsFilePath,
  type CommandCodeGlobalOptionCommandResult,
} from "./commandCodeGlobalOptions.ts";

const successfulCommand: CommandCodeGlobalOptionCommandResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("parseCommandCodeGlobalSettings", () => {
  it("uses Command Code native defaults for missing and malformed settings", () => {
    expect(parseCommandCodeGlobalSettings(undefined)).toEqual({
      compactMode: "default",
      tasteLearning: true,
    });
    expect(parseCommandCodeGlobalSettings("not json")).toEqual({
      compactMode: "default",
      tasteLearning: true,
    });
    expect(
      parseCommandCodeGlobalSettings(
        encodeJson({ compactMode: "normal", tasteLearning: "disabled" }),
      ),
    ).toEqual({ compactMode: "default", tasteLearning: true });
  });

  it("reads valid settings independently when another setting is malformed", () => {
    expect(
      parseCommandCodeGlobalSettings(
        encodeJson({ compactMode: "fast", tasteLearning: "disabled" }),
      ),
    ).toEqual({ compactMode: "fast", tasteLearning: true });
    expect(
      parseCommandCodeGlobalSettings(encodeJson({ compactMode: "normal", tasteLearning: false })),
    ).toEqual({ compactMode: "default", tasteLearning: false });
  });
});

describe("resolveCommandCodeSettingsFilePath", () => {
  it("uses the selected instance environment without falling back to the host home", () => {
    const joinPath = (...parts: ReadonlyArray<string>) => parts.join("/");
    expect(resolveCommandCodeSettingsFilePath({ HOME: "/instance/home" }, joinPath)).toBe(
      "/instance/home/.commandcode/settings.json",
    );
    expect(resolveCommandCodeSettingsFilePath({ USERPROFILE: "C:/Users/Test" }, joinPath)).toBe(
      "C:/Users/Test/.commandcode/settings.json",
    );
    expect(resolveCommandCodeSettingsFilePath({}, joinPath)).toBeUndefined();
  });
});

describe("Command Code global options controller", () => {
  it.effect("publishes Compact Mode before Taste Learning with native current values", () =>
    Effect.gen(function* () {
      const controller = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () =>
          Effect.succeed(encodeJson({ compactMode: "fast", tasteLearning: false })),
        runCommand: () => Effect.succeed(successfulCommand),
      });

      expect(yield* controller.readOptions).toEqual([
        {
          id: "compactMode",
          label: "Compact Mode",
          type: "select",
          currentValue: "fast",
          options: [
            { id: "default", label: "Normal", isDefault: true },
            { id: "fast", label: "Fast" },
          ],
        },
        {
          id: "tasteLearning",
          label: "Taste Learning",
          type: "boolean",
          currentValue: false,
        },
      ]);
    }),
  );

  it.effect("re-reads settings changed outside T3", () =>
    Effect.gen(function* () {
      const document = yield* Ref.make(encodeJson({ compactMode: "default", tasteLearning: true }));
      const controller = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Ref.get(document),
        runCommand: () => Effect.succeed(successfulCommand),
      });

      expect((yield* controller.readOptions).map((option) => option.currentValue)).toEqual([
        "default",
        true,
      ]);
      yield* Ref.set(document, encodeJson({ compactMode: "fast", tasteLearning: false }));
      expect((yield* controller.readOptions).map((option) => option.currentValue)).toEqual([
        "fast",
        false,
      ]);
    }),
  );

  it.effect("routes exact native compact and taste commands and verifies each write", () =>
    Effect.gen(function* () {
      const document = yield* Ref.make(encodeJson({}));
      const commands = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const controller = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Ref.get(document),
        runCommand: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(commands, (entries) => [...entries, input.args]);
            const current = parseCommandCodeGlobalSettings(yield* Ref.get(document));
            if (input.args[0] === "--config") {
              yield* Ref.set(
                document,
                encodeJson({ ...current, compactMode: input.args[1]?.split("=")[1] }),
              );
            } else {
              yield* Ref.set(
                document,
                encodeJson({ ...current, tasteLearning: input.args[1] === "enable" }),
              );
            }
            return successfulCommand;
          }),
      });

      yield* controller.setGlobalOption({ optionId: "compactMode", value: "fast" });
      yield* controller.setGlobalOption({ optionId: "compactMode", value: "default" });
      yield* controller.setGlobalOption({ optionId: "tasteLearning", value: false });
      yield* controller.setGlobalOption({ optionId: "tasteLearning", value: true });

      expect(yield* Ref.get(commands)).toEqual([
        ["--config", "compact-mode=fast"],
        ["--config", "compact-mode=default"],
        ["taste", "disable", "--user"],
        ["taste", "enable", "--user"],
      ]);
    }),
  );

  it.effect("rejects unknown ids and wrong primitive or select values before spawning", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const controller = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Effect.succeed(encodeJson({})),
        runCommand: () =>
          Ref.update(calls, (value) => value + 1).pipe(Effect.as(successfulCommand)),
      });

      const failures = yield* Effect.all([
        controller.setGlobalOption({ optionId: "unknown", value: true }).pipe(Effect.flip),
        controller.setGlobalOption({ optionId: "compactMode", value: true }).pipe(Effect.flip),
        controller.setGlobalOption({ optionId: "compactMode", value: "normal" }).pipe(Effect.flip),
        controller.setGlobalOption({ optionId: "tasteLearning", value: "true" }).pipe(Effect.flip),
      ]);

      expect(
        failures.every((failure) => failure._tag === "ProviderGlobalOptionMutationError"),
      ).toBe(true);
      expect(yield* Ref.get(calls)).toBe(0);
    }),
  );

  it.effect("fails on native command errors and read-after-write mismatches", () =>
    Effect.gen(function* () {
      const nonzero = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Effect.succeed(encodeJson({ compactMode: "fast" })),
        runCommand: () =>
          Effect.succeed({ ...successfulCommand, exitCode: 1, stderr: "native failure" }),
      });
      const mismatched = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Effect.succeed(encodeJson({ compactMode: "default" })),
        runCommand: () => Effect.succeed(successfulCommand),
      });

      const commandFailure = yield* nonzero
        .setGlobalOption({ optionId: "compactMode", value: "fast" })
        .pipe(Effect.flip);
      const mismatchFailure = yield* mismatched
        .setGlobalOption({ optionId: "compactMode", value: "fast" })
        .pipe(Effect.flip);

      expect(commandFailure.message).toContain("native failure");
      expect(mismatchFailure.message).toContain("did not persist");
    }),
  );

  it.effect("treats bounded-output truncation as a mutation failure", () =>
    Effect.gen(function* () {
      const controller = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Effect.succeed(encodeJson({ tasteLearning: true })),
        runCommand: () =>
          Effect.succeed({ ...successfulCommand, stdout: "partial", stdoutTruncated: true }),
      });

      const failure = yield* controller
        .setGlobalOption({ optionId: "tasteLearning", value: false })
        .pipe(Effect.flip);
      expect(failure.message).toContain("too much output");
    }),
  );

  it.effect("reports read failures after a successful native command", () =>
    Effect.gen(function* () {
      const controller = yield* createCommandCodeGlobalOptionsController({
        settingsFilePath: "/home/test/.commandcode/settings.json",
        readSettingsFile: () => Effect.fail("permission denied"),
        runCommand: () => Effect.succeed(successfulCommand),
      });

      const failure = yield* controller
        .setGlobalOption({ optionId: "tasteLearning", value: false })
        .pipe(Effect.flip);
      expect(failure.message).toContain("Could not read");
    }),
  );

  it.effect("times out a hung native command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const controller = yield* createCommandCodeGlobalOptionsController({
          settingsFilePath: "/home/test/.commandcode/settings.json",
          readSettingsFile: () => Effect.succeed(encodeJson({ tasteLearning: true })),
          runCommand: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });

        const mutation = yield* controller
          .setGlobalOption({ optionId: "tasteLearning", value: false })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("10 seconds");
        const failure = yield* Fiber.join(mutation).pipe(Effect.flip);
        expect(failure.message).toContain("timed out");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("serializes concurrent mutations for one controller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const document = yield* Ref.make(encodeJson({ tasteLearning: true }));
        const callCount = yield* Ref.make(0);
        const controller = yield* createCommandCodeGlobalOptionsController({
          settingsFilePath: "/home/test/.commandcode/settings.json",
          readSettingsFile: () => Ref.get(document),
          runCommand: (input) =>
            Effect.gen(function* () {
              const call = yield* Ref.getAndUpdate(callCount, (value) => value + 1);
              if (call === 0) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              } else {
                yield* Deferred.succeed(secondStarted, undefined);
              }
              yield* Ref.set(document, encodeJson({ tasteLearning: input.args[1] === "enable" }));
              return successfulCommand;
            }),
        });

        const first = yield* controller
          .setGlobalOption({ optionId: "tasteLearning", value: false })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstStarted);
        const second = yield* controller
          .setGlobalOption({ optionId: "tasteLearning", value: true })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(secondStarted)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Deferred.isDone(secondStarted)).toBe(true);
      }),
    ),
  );
});
