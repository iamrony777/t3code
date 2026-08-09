import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandCodeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import type {
  CommandCodeEffortCapability,
  CommandCodeReasoningEffortValidator,
} from "../provider/commandCodeCatalog.ts";
import { makeCommandCodeTextGeneration } from "./CommandCodeTextGeneration.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const modelSelection = {
  instanceId: ProviderInstanceId.make("commandcode"),
  model: "deepseek/deepseek-v4-flash",
};
const effortValidator = (
  capabilities: Readonly<Record<string, CommandCodeEffortCapability>> = {},
): CommandCodeReasoningEffortValidator => ({
  supportsReasoningEffort: (model, reasoningEffort) => {
    const capability = capabilities[model];
    return Effect.succeed(
      capability?.kind === "adjustable" && capability.values.includes(reasoningEffort),
    );
  },
});

it.layer(NodeServices.layer)("makeCommandCodeTextGeneration", (it) => {
  it.effect("generates each supported text artifact through a no-session fail-closed run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-text-" });
        const binaryPath = path.join(dir, "command-code");
        const argsLog = path.join(dir, "args.log");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' "$*" >> "$COMMAND_CODE_ARGS_LOG"',
            "cat >/dev/null",
            'printf \'%s\\n\' \'{"type":"result","subtype":"success","sessionId":"ignored","stopReason":"end_turn","usage":{},"durationMs":5,"finalText":"{\\"subject\\":\\"feat: command code\\",\\"body\\":\\"Body\\",\\"branch\\":\\"feat/command-code\\",\\"title\\":\\"Command Code provider\\"}"}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const service = yield* makeCommandCodeTextGeneration(
          decodeSettings({ binaryPath }),
          effortValidator(),
          {
            ...process.env,
            COMMAND_CODE_ARGS_LOG: argsLog,
          },
        );

        expect(
          yield* service.generateCommitMessage({
            cwd: dir,
            branch: "main",
            stagedSummary: "one file",
            stagedPatch: "+change",
            includeBranch: true,
            modelSelection,
          }),
        ).toEqual({
          subject: "feat: command code",
          body: "Body",
          branch: "feature/feat/command-code",
        });
        expect(
          yield* service.generatePrContent({
            cwd: dir,
            baseBranch: "main",
            headBranch: "feat/command-code",
            commitSummary: "summary",
            diffSummary: "diff",
            diffPatch: "+change",
            modelSelection,
          }),
        ).toEqual({ title: "Command Code provider", body: "Body" });
        expect(
          yield* service.generateBranchName({ cwd: dir, message: "add provider", modelSelection }),
        ).toEqual({ branch: "feat/command-code" });
        expect(
          yield* service.generateThreadTitle({
            cwd: dir,
            message: "add provider",
            modelSelection: {
              ...modelSelection,
              options: [{ id: "reasoningEffort", value: "default" }],
            },
          }),
        ).toEqual({ title: "Command Code provider" });

        const lines = (yield* fs.readFileString(argsLog)).trim().split("\n");
        expect(lines).toHaveLength(4);
        for (const line of lines) {
          expect(line).toContain("--no-session");
          expect(line).toContain("--no-auto-update");
          expect(line).toContain("--max-turns 1");
          expect(line).toContain("--permission-mode dont-ask");
          expect(line).not.toContain("--effort");
        }
      }),
    ),
  );

  it.effect("rejects attachment-dependent generation instead of dropping the attachment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeCommandCodeTextGeneration(decodeSettings({}), effortValidator());
        const result = yield* service
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "describe image",
            attachments: [
              {
                type: "image",
                id: "image-1",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
            modelSelection,
          })
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("passes a supported reasoning effort exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-effort-" });
        const binaryPath = path.join(dir, "command-code");
        const argsLog = path.join(dir, "args.log");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' "$*" > "$COMMAND_CODE_ARGS_LOG"',
            "cat >/dev/null",
            'printf \'%s\\n\' \'{"type":"result","subtype":"success","sessionId":"ignored","usage":{},"durationMs":5,"finalText":"{\\"title\\":\\"Effort title\\"}"}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);
        const service = yield* makeCommandCodeTextGeneration(
          decodeSettings({ binaryPath }),
          effortValidator({
            "deepseek/deepseek-v4-flash": { kind: "adjustable", values: ["high", "max"] },
          }),
          { ...process.env, COMMAND_CODE_ARGS_LOG: argsLog },
        );

        yield* service.generateThreadTitle({
          cwd: dir,
          message: "name this",
          modelSelection: {
            ...modelSelection,
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        });

        const args = yield* fs.readFileString(argsLog);
        expect(args.match(/--effort max/g)).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects invalid reasoning effort selections before spawning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        let spawnCalls = 0;
        const countingSpawner = ChildProcessSpawner.make((command) => {
          spawnCalls += 1;
          return delegate.spawn(command);
        });
        const cases = [
          {
            model: "stale-model",
            capability: { kind: "adjustable", values: ["high"] } as const,
          },
          { model: "fixed-model", capability: { kind: "fixed" } as const },
          { model: "unknown-model", capability: { kind: "unknown" } as const },
          { model: "missing-model", capability: undefined },
        ];

        for (const testCase of cases) {
          const capabilities = testCase.capability ? { [testCase.model]: testCase.capability } : {};
          const service = yield* makeCommandCodeTextGeneration(
            decodeSettings({}),
            effortValidator(capabilities),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner));
          const error = yield* service
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "name this",
              modelSelection: {
                instanceId: ProviderInstanceId.make("commandcode"),
                model: testCase.model,
                options: [{ id: "reasoningEffort", value: "max" }],
              },
            })
            .pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "TextGenerationError",
            detail: `Reasoning effort 'max' is not supported by Command Code model '${testCase.model}'.`,
          });
        }

        expect(spawnCalls).toBe(0);
      }),
    ),
  );
});
