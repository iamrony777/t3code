import {
  type CommandCodeSettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { parseCommandCodeNdjsonLine } from "../provider/commandCodeCli.ts";
import type { CommandCodeReasoningEffortValidator } from "../provider/commandCodeCatalog.ts";
import { collectStreamAsString } from "../provider/providerSnapshot.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 180_000;
const FORCE_KILL_AFTER = "1 second";
const isTextGenerationError = Schema.is(TextGenerationError);

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  settings: CommandCodeSettings,
  catalogController: CommandCodeReasoningEffortValidator,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const selectedReasoningEffort = getModelSelectionStringOptionValue(
        input.modelSelection,
        "reasoningEffort",
      );
      const reasoningEffort =
        selectedReasoningEffort === "default" ? undefined : selectedReasoningEffort;
      if (
        reasoningEffort !== undefined &&
        !(yield* catalogController.supportsReasoningEffort(
          input.modelSelection.model,
          reasoningEffort,
        ))
      ) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `Reasoning effort '${reasoningEffort}' is not supported by Command Code model '${input.modelSelection.model}'.`,
        });
      }
      const binaryPath = settings.binaryPath || "command-code";
      const args = [
        "-p",
        "--output-format",
        "json",
        "--no-session",
        "--skip-onboarding",
        "--no-auto-update",
        "--max-turns",
        "1",
        "--permission-mode",
        "dont-ask",
        "--model",
        input.modelSelection.model,
        ...(reasoningEffort ? ["--effort", reasoningEffort] : []),
      ];
      const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.cwd,
          env: environment,
          shell: spawnCommand.shell,
          forceKillAfter: FORCE_KILL_AFTER,
          stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      const result = stdout
        .split(/\r?\n/)
        .map(parseCommandCodeNdjsonLine)
        .findLast((frame) => frame?.type === "result");
      if (exitCode !== 0 || result?.type !== "result" || result.subtype !== "success") {
        const detail = stderr.trim() || "Command Code returned no successful result frame.";
        return yield* new TextGenerationError({
          operation: input.operation,
          detail,
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
      return yield* decodeOutput(extractJsonObject(result.finalText)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Command Code returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Command Code text generation timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Command Code text generation failed.",
              cause,
            }),
      ),
    );

  const rejectAttachments = (
    operation: Operation,
    attachments: ReadonlyArray<unknown> | undefined,
  ) =>
    attachments && attachments.length > 0
      ? Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Command Code headless mode does not support attachments.",
          }),
        )
      : Effect.void;

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CommandCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CommandCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CommandCodeTextGeneration.generateBranchName")(function* (input) {
      yield* rejectAttachments("generateBranchName", input.attachments);
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: undefined,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CommandCodeTextGeneration.generateThreadTitle")(function* (input) {
      yield* rejectAttachments("generateThreadTitle", input.attachments);
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: undefined,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
