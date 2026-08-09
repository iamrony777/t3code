import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CommandCodeEffortCapability } from "../commandCodeCatalog.ts";
import { commandCodeProjectSlugCandidate } from "../commandCodeTranscript.ts";
import {
  type CommandCodeAdapterCatalogController,
  makeCommandCodeAdapter,
} from "./CommandCodeAdapter.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const provider = ProviderDriverKind.make("commandcode");
const instanceId = ProviderInstanceId.make("commandcode");
const effortValidator = (
  capabilities: Readonly<Record<string, CommandCodeEffortCapability>> = {},
  contextWindows: Readonly<Record<string, number | undefined>> = {},
): CommandCodeAdapterCatalogController => ({
  supportsReasoningEffort: (model, reasoningEffort) => {
    const capability = capabilities[model];
    return Effect.succeed(
      capability?.kind === "adjustable" && capability.values.includes(reasoningEffort),
    );
  },
  getModelContextWindow: (model) => Effect.succeed(contextWindows[model]),
});

const eventUsage = (event: ProviderRuntimeEvent) => {
  if (event.type !== "thread.token-usage.updated") {
    throw new Error(`Expected token usage event, received ${event.type}`);
  }
  return event.payload.usage;
};

const nativeUsageLine = (input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}) =>
  JSON.stringify({
    type: "message",
    id: "message",
    message: { role: "assistant", content: [] },
    model: input.model,
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    },
  });

const resultFrame = (
  sessionId: string,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  },
) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    sessionId,
    usage,
    durationMs: 25,
    finalText: "done",
  });

const writeResultBinary = (
  fs: FileSystem.FileSystem,
  binaryPath: string,
  sessionId: string,
  results: ReadonlyArray<string>,
) =>
  fs
    .writeFileString(
      binaryPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        'count_file="$COMMAND_CODE_COUNT_FILE"',
        "count=0",
        'if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi',
        "count=$((count + 1))",
        'printf \'%s\\n\' "$count" > "$count_file"',
        `printf '%s\\n' '${JSON.stringify({ type: "event", event: { type: "run_start", sessionId } })}'`,
        'case "$count" in',
        ...results.flatMap((result, index) => [`  ${index + 1}) printf '%s\\n' '${result}' ;;`]),
        `  *) printf '%s\\n' '${results.at(-1)}' ;;`,
        "esac",
      ].join("\n"),
    )
    .pipe(Effect.andThen(fs.chmod(binaryPath, 0o755)));

const writeNativeTranscript = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  cwd: string,
  sessionId: string,
  line: string,
) => {
  const projectDirectory = path.join(
    home,
    ".commandcode",
    "projects",
    commandCodeProjectSlugCandidate(cwd)!,
  );
  return fs
    .makeDirectory(projectDirectory, { recursive: true })
    .pipe(
      Effect.andThen(
        fs.writeFileString(path.join(projectDirectory, `${sessionId}.jsonl`), `${line}\n`),
      ),
    );
};

it.layer(NodeServices.layer)("makeCommandCodeAdapter", (it) => {
  it.effect("streams a turn and resumes the next turn by explicit session id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-adapter-" });
        const binaryPath = path.join(dir, "command-code");
        const argsLog = path.join(dir, "args.log");
        const stdinLog = path.join(dir, "stdin.log");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' "$*" >> "$COMMAND_CODE_ARGS_LOG"',
            "prompt=$(cat)",
            'printf \'%s\\n\' "$prompt" >> "$COMMAND_CODE_STDIN_LOG"',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"run_start","sessionId":"session-123"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"thinking_start","id":"reasoning-1"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"thinking_delta","id":"reasoning-1","delta":"checking"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"thinking_end","id":"reasoning-1"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"tool_queued","toolCallId":"tool-1","toolName":"run_command","input":{"command":"vp test"}}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"tool_running","toolCallId":"tool-1","toolName":"run_command","description":"Run focused tests"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"tool_update","toolCallId":"tool-1","toolName":"run_command","partial":"tests running"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"tool_completed","toolCallId":"tool-1","toolName":"run_command","result":"all passed"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"thinking_start","id":"reasoning-2"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"thinking_end","id":"reasoning-2","text":"more checking"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"subagent_start","toolCallId":"agent-1","subagentType":"explore"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"subagent_progress","toolCallId":"agent-1","subagentType":"explore","toolName":"read_file","toolInput":{"path":"README.md"},"tokensUsed":12}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"subagent_stop","toolCallId":"agent-1","subagentType":"explore","tokensUsed":24}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"text_delta","messageId":"message-1","delta":"hello"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"message_end","messageId":"message-1"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"message_start","messageId":"message-2"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"text_delta","messageId":"message-2","delta":" world"}}\'',
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"message_end","messageId":"message-2"}}\'',
            'printf \'%s\\n\' \'{"type":"result","subtype":"success","sessionId":"session-123","stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":2},"durationMs":42,"finalText":"hello world"}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController: effortValidator({
            "deepseek/deepseek-v4-flash": { kind: "adjustable", values: ["high", "max"] },
          }),
          environment: {
            ...process.env,
            COMMAND_CODE_ARGS_LOG: argsLog,
            COMMAND_CODE_STDIN_LOG: stdinLog,
          },
        });
        const threadId = ThreadId.make("thread-command-code");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd: dir,
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId,
            model: "deepseek/deepseek-v4-flash",
            options: [{ id: "reasoningEffort", value: "max" }],
          },
        });
        const first = yield* adapter.sendTurn({
          threadId,
          input: "first prompt",
          interactionMode: "default",
        });
        expect(first.resumeCursor).toEqual({
          schemaVersion: 2,
          sessionId: "session-123",
          totalProcessedTokens: 0,
        });

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        expect(events.map((event) => event.type)).toEqual([
          "session.started",
          "thread.started",
          "turn.started",
          "item.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "content.delta",
          "task.started",
          "task.progress",
          "task.completed",
          "item.started",
          "content.delta",
          "content.delta",
          "item.completed",
          "item.completed",
          "thread.token-usage.updated",
          "turn.completed",
        ]);
        expect(
          events.find((event) => event.type === "content.delta" && event.payload.delta === "hello"),
        ).toBeDefined();
        expect(
          events.find(
            (event) => event.type === "item.completed" && event.payload.detail === "hello world",
          ),
        ).toBeDefined();
        expect(events.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({
          payload: {
            usage: {
              usedTokens: 12,
              totalProcessedTokens: 12,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 2,
              durationMs: 42,
              compactsAutomatically: true,
            },
          },
        });
        expect(
          events.find((event) => event.type === "thread.token-usage.updated")?.payload.usage,
        ).not.toHaveProperty("maxTokens");
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual({
          schemaVersion: 2,
          sessionId: "session-123",
          totalProcessedTokens: 12,
        });
        expect(
          events.find(
            (event) =>
              event.type === "item.completed" &&
              event.payload.itemType === "command_execution" &&
              event.payload.detail === "all passed",
          ),
        ).toBeDefined();
        expect(
          events.find(
            (event) =>
              event.type === "task.completed" &&
              event.payload.title === "explore" &&
              event.payload.typedUsage?.totalTokens === 24,
          ),
        ).toBeDefined();

        const secondEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({ threadId, input: "second prompt" });
        yield* Fiber.join(secondEventsFiber).pipe(Effect.timeout("2 seconds"));
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual({
          schemaVersion: 2,
          sessionId: "session-123",
          totalProcessedTokens: 24,
        });

        const argumentLines = (yield* fs.readFileString(argsLog)).trim().split("\n");
        expect(argumentLines[0]).toContain("--permission-mode dont-ask");
        expect(argumentLines[0]?.match(/--effort max/g)).toHaveLength(1);
        expect(argumentLines[1]).toContain("--resume session-123");
        expect(argumentLines[1]?.match(/--effort max/g)).toHaveLength(1);
        expect(argumentLines[1]).not.toContain("--continue");
        expect((yield* fs.readFileString(stdinLog)).trim().split("\n")).toEqual([
          "first prompt",
          "second prompt",
        ]);
      }),
    ),
  );

  it.effect("interrupts the exact active process and emits turn.aborted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-interrupt-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            "cat >/dev/null",
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"run_start","sessionId":"session-interrupt"}}\'',
            "trap 'exit 130' INT",
            "sleep 3600",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController: effortValidator(),
        });
        const threadId = ThreadId.make("thread-command-code-interrupt");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.aborted"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd: dir,
          runtimeMode: "approval-required",
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "wait" });
        const steeringExit = yield* adapter
          .sendTurn({ threadId, input: "steer" })
          .pipe(Effect.exit);
        expect(steeringExit._tag).toBe("Failure");
        yield* adapter.interruptTurn(threadId, turn.turnId);

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        expect(events.at(-1)?.type).toBe("turn.aborted");
      }),
    ),
  );

  it.effect("terminates a turn that never reports a session id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-startup-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            "cat >/dev/null",
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"text_delta","delta":"starting"}}\'',
            "trap 'exit 143' TERM",
            "sleep 3600",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController: effortValidator(),
          startupTimeoutMs: 100,
        });
        const threadId = ThreadId.make("thread-command-code-startup-timeout");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const startedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              event.type === "content.delta" &&
              event.payload.delta === "starting",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd: dir,
          runtimeMode: "approval-required",
        });
        const turnExitFiber = yield* adapter
          .sendTurn({ threadId, input: "start" })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Fiber.join(startedFiber);
        yield* TestClock.adjust("101 millis");

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        expect((yield* Fiber.join(turnExitFiber))._tag).toBe("Failure");
        expect(events.at(-1)).toMatchObject({
          type: "turn.completed",
          payload: { state: "failed" },
        });
      }),
    ),
  );

  it.effect("fails immediately with the CLI error when startup returns no session id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-error-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            "cat >/dev/null",
            'printf \'%s\\n\' \'{"type":"result","subtype":"error","usage":{},"durationMs":5,"finalText":"","error":"Authentication required."}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController: effortValidator(),
        });
        const threadId = ThreadId.make("thread-command-code-startup-error");
        const terminalFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd: dir,
          runtimeMode: "approval-required",
        });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "start" })
          .pipe(Effect.exit, Effect.forkChild);

        const terminal = yield* Fiber.join(terminalFiber);
        yield* Effect.yieldNow;
        expect(turnFiber.pollUnsafe()).toBeDefined();
        expect(Option.getOrUndefined(terminal)).toMatchObject({
          payload: { state: "failed", errorMessage: "Authentication required." },
        });
      }),
    ),
  );

  it.effect("rejects attachments, steering, approvals, and rollback explicitly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeCommandCodeAdapter(decodeSettings({}), {
          instanceId,
          catalogController: effortValidator(),
        });
        const threadId = ThreadId.make("thread-command-code-validation");
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        const attachmentExit = yield* adapter
          .sendTurn({
            threadId,
            input: "look",
            attachments: [
              {
                type: "image",
                id: "image-1",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.exit);
        expect(attachmentExit._tag).toBe("Failure");

        const approvalExit = yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.make("request-1"), "accept")
          .pipe(Effect.exit);
        expect(approvalExit._tag).toBe("Failure");

        const userInputExit = yield* adapter
          .respondToUserInput(threadId, ApprovalRequestId.make("request-2"), {})
          .pipe(Effect.exit);
        expect(userInputExit._tag).toBe("Failure");

        const rollbackExit = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
        expect(rollbackExit._tag).toBe("Failure");
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
          const adapter = yield* makeCommandCodeAdapter(decodeSettings({}), {
            instanceId,
            catalogController: effortValidator(capabilities),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner));
          const threadId = ThreadId.make(`thread-command-code-${testCase.model}`);
          yield* adapter.startSession({
            provider,
            providerInstanceId: instanceId,
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: {
              instanceId,
              model: testCase.model,
              options: [{ id: "reasoningEffort", value: "max" }],
            },
          });

          const error = yield* adapter.sendTurn({ threadId, input: "do work" }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ProviderAdapterValidationError",
            issue: `Reasoning effort 'max' is not supported by Command Code model '${testCase.model}'.`,
          });
        }

        expect(spawnCalls).toBe(0);
      }),
    ),
  );

  it.effect("admits only one concurrent turn and releases a failed validation claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-admission-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            "cat >/dev/null",
            'printf \'%s\\n\' \'{"type":"event","event":{"type":"run_start","sessionId":"session-admitted"}}\'',
            'printf \'%s\\n\' \'{"type":"result","subtype":"success","sessionId":"session-admitted","usage":{},"durationMs":5,"finalText":"done"}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        let spawnCalls = 0;
        const countingSpawner = ChildProcessSpawner.make((command) => {
          spawnCalls += 1;
          return delegate.spawn(command);
        });
        const validationStarted = yield* Deferred.make<void>();
        const releaseValidation = yield* Deferred.make<void>();
        let validationCalls = 0;
        const catalogController: CommandCodeAdapterCatalogController = {
          getModelContextWindow: effortValidator().getModelContextWindow,
          supportsReasoningEffort: () =>
            Effect.gen(function* () {
              validationCalls += 1;
              if (validationCalls === 1) {
                yield* Deferred.succeed(validationStarted, undefined);
                yield* Deferred.await(releaseValidation);
                return false;
              }
              return true;
            }),
        };
        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner));
        const threadId = ThreadId.make("thread-command-code-admission");
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd: dir,
          runtimeMode: "approval-required",
        });
        const turnInput = {
          threadId,
          input: "do work",
          modelSelection: {
            instanceId,
            model: "adjustable-model",
            options: [{ id: "reasoningEffort", value: "max" }] as const,
          },
        };

        const first = yield* adapter.sendTurn(turnInput).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(validationStarted);
        const concurrent = yield* adapter.sendTurn(turnInput).pipe(Effect.flip);
        expect(concurrent).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          issue: "Command Code headless mode does not support mid-turn steering.",
        });
        expect(validationCalls).toBe(1);
        expect(spawnCalls).toBe(0);

        yield* Deferred.succeed(releaseValidation, undefined);
        expect((yield* Fiber.join(first))._tag).toBe("Failure");
        yield* adapter.sendTurn(turnInput);

        expect(validationCalls).toBe(2);
        expect(spawnCalls).toBe(1);
      }),
    ),
  );

  it.effect(
    "reports native active context while cumulative aggregate grows across compaction",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-usage-" });
          const home = path.join(dir, "home");
          const cwd = path.join(dir, "workspace");
          const binaryPath = path.join(dir, "command-code");
          const countFile = path.join(dir, "count");
          const sessionId = "session-active";
          yield* fs.makeDirectory(cwd, { recursive: true });
          yield* writeResultBinary(fs, binaryPath, sessionId, [
            resultFrame(sessionId, {
              inputTokens: 70_000,
              outputTokens: 5_000,
              cacheReadTokens: 30_000,
              cacheWriteTokens: 10_000,
            }),
            resultFrame(sessionId, {
              inputTokens: 12_000,
              outputTokens: 2_000,
              cacheReadTokens: 4_000,
              cacheWriteTokens: 2_000,
            }),
          ]);
          yield* writeNativeTranscript(
            fs,
            path,
            home,
            cwd,
            sessionId,
            nativeUsageLine({
              model: "model/active",
              inputTokens: 20_000,
              outputTokens: 4_000,
              cacheReadTokens: 10_000,
              cacheWriteTokens: 5_000,
            }),
          );
          const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
            instanceId,
            catalogController: effortValidator({}, { "model/active": 200_000 }),
            environment: { HOME: home, PATH: process.env.PATH, COMMAND_CODE_COUNT_FILE: countFile },
          });
          const threadId = ThreadId.make("thread-command-code-active");
          yield* adapter.startSession({
            provider,
            providerInstanceId: instanceId,
            threadId,
            cwd,
            runtimeMode: "approval-required",
            modelSelection: { instanceId, model: "model/active", options: [] },
          });

          const firstUsageFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* adapter.sendTurn({ threadId, input: "first" });
          const firstUsage = Option.getOrThrow(yield* Fiber.join(firstUsageFiber));
          const firstSnapshot = eventUsage(firstUsage);
          expect(firstSnapshot).toEqual({
            usedTokens: 39_000,
            totalProcessedTokens: 115_000,
            maxTokens: 200_000,
            inputTokens: 20_000,
            cachedInputTokens: 10_000,
            outputTokens: 4_000,
            durationMs: 25,
            compactsAutomatically: true,
          });

          yield* writeNativeTranscript(
            fs,
            path,
            home,
            cwd,
            sessionId,
            nativeUsageLine({
              model: "model/active",
              inputTokens: 10_000,
              outputTokens: 3_000,
              cacheReadTokens: 8_000,
              cacheWriteTokens: 4_000,
            }),
          );
          const secondUsageFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* adapter.sendTurn({ threadId, input: "second" });
          const secondUsage = Option.getOrThrow(yield* Fiber.join(secondUsageFiber));
          const secondSnapshot = eventUsage(secondUsage);
          expect(secondSnapshot).toMatchObject({
            usedTokens: 25_000,
            totalProcessedTokens: 135_000,
            maxTokens: 200_000,
          });
          expect(secondSnapshot.usedTokens).toBeLessThan(firstSnapshot.usedTokens);
        }),
      ),
  );

  it.effect("uses equal active and aggregate usage for a single call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-single-" });
        const home = path.join(dir, "home");
        const cwd = path.join(dir, "workspace");
        const binaryPath = path.join(dir, "command-code");
        const sessionId = "session-single";
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* writeResultBinary(fs, binaryPath, sessionId, [
          resultFrame(sessionId, {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          }),
        ]);
        yield* writeNativeTranscript(
          fs,
          path,
          home,
          cwd,
          sessionId,
          nativeUsageLine({
            model: "model/single",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          }),
        );
        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController: effortValidator({}, { "model/single": 100_000 }),
          environment: {
            HOME: home,
            PATH: process.env.PATH,
            COMMAND_CODE_COUNT_FILE: path.join(dir, "count"),
          },
        });
        const threadId = ThreadId.make("thread-command-code-single");
        const usageFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd,
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "one" });
        expect(eventUsage(Option.getOrThrow(yield* Fiber.join(usageFiber)))).toMatchObject({
          usedTokens: 19,
          totalProcessedTokens: 19,
          maxTokens: 100_000,
        });
      }),
    ),
  );

  it.effect(
    "uses exact catalog max tokens with aggregate usage when the transcript is missing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-command-code-no-transcript-",
          });
          const binaryPath = path.join(dir, "command-code");
          const sessionId = "session-no-transcript";
          yield* writeResultBinary(fs, binaryPath, sessionId, [
            resultFrame(sessionId, {
              inputTokens: 10,
              outputTokens: 2,
              cacheReadTokens: 3,
              cacheWriteTokens: 4,
            }),
          ]);
          const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
            instanceId,
            catalogController: effortValidator({}, { "model/known": 100_000 }),
            environment: {
              HOME: path.join(dir, "home"),
              PATH: process.env.PATH,
              COMMAND_CODE_COUNT_FILE: path.join(dir, "count"),
            },
          });
          const threadId = ThreadId.make("thread-command-code-no-transcript");
          const usageFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* adapter.startSession({
            provider,
            providerInstanceId: instanceId,
            threadId,
            cwd: dir,
            runtimeMode: "approval-required",
            modelSelection: { instanceId, model: "model/known", options: [] },
          });
          yield* adapter.sendTurn({ threadId, input: "missing" });
          const usage = eventUsage(Option.getOrThrow(yield* Fiber.join(usageFiber)));
          expect(usage).toMatchObject({
            usedTokens: 19,
            totalProcessedTokens: 19,
            maxTokens: 100_000,
            inputTokens: 10,
            cachedInputTokens: 3,
            outputTokens: 2,
          });
        }),
      ),
  );

  it.effect("keeps active usage but omits max tokens when exact API metadata is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-no-api-" });
        const home = path.join(dir, "home");
        const cwd = path.join(dir, "workspace");
        const binaryPath = path.join(dir, "command-code");
        const sessionId = "session-no-api";
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* writeResultBinary(fs, binaryPath, sessionId, [
          resultFrame(sessionId, { inputTokens: 10, outputTokens: 2 }),
        ]);
        yield* writeNativeTranscript(
          fs,
          path,
          home,
          cwd,
          sessionId,
          nativeUsageLine({
            model: "model/no-api",
            inputTokens: 30,
            outputTokens: 5,
            cacheReadTokens: 7,
            cacheWriteTokens: 11,
          }),
        );
        const adapter = yield* makeCommandCodeAdapter(decodeSettings({ binaryPath }), {
          instanceId,
          catalogController: effortValidator(),
          environment: {
            HOME: home,
            PATH: process.env.PATH,
            COMMAND_CODE_COUNT_FILE: path.join(dir, "count"),
          },
        });
        const threadId = ThreadId.make("thread-command-code-no-api");
        const usageFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) => event.threadId === threadId && event.type === "thread.token-usage.updated",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId,
          cwd,
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "active" });
        const usage = eventUsage(Option.getOrThrow(yield* Fiber.join(usageFiber)));
        expect(usage).toMatchObject({
          usedTokens: 53,
          inputTokens: 30,
          cachedInputTokens: 7,
          outputTokens: 5,
        });
        expect(usage).not.toHaveProperty("maxTokens");
      }),
    ),
  );

  it.effect("accepts v1 cursors and carries v2 cumulative totals into a new adapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstAdapter = yield* makeCommandCodeAdapter(decodeSettings({}), {
          instanceId,
          catalogController: effortValidator(),
        });
        const v1Thread = ThreadId.make("thread-command-code-v1");
        const v1Session = yield* firstAdapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId: v1Thread,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: { schemaVersion: 1, sessionId: "session-v1" },
        });
        expect(v1Session.resumeCursor).toEqual({
          schemaVersion: 2,
          sessionId: "session-v1",
          totalProcessedTokens: 0,
        });

        const resumedAdapter = yield* makeCommandCodeAdapter(decodeSettings({}), {
          instanceId,
          catalogController: effortValidator(),
        });
        const resumed = yield* resumedAdapter.startSession({
          provider,
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread-command-code-v2"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: {
            schemaVersion: 2,
            sessionId: "session-v2",
            totalProcessedTokens: 135_000,
          },
        });
        expect(resumed.resumeCursor).toEqual({
          schemaVersion: 2,
          sessionId: "session-v2",
          totalProcessedTokens: 135_000,
        });
      }),
    ),
  );
});
