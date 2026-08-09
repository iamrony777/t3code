import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const provider = ProviderDriverKind.make("commandcode");
const instanceId = ProviderInstanceId.make("commandcode");

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
          modelSelection: { instanceId, model: "deepseek/deepseek-v4-flash" },
        });
        const first = yield* adapter.sendTurn({
          threadId,
          input: "first prompt",
          interactionMode: "default",
        });
        expect(first.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "session-123" });

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

        const argumentLines = (yield* fs.readFileString(argsLog)).trim().split("\n");
        expect(argumentLines[0]).toContain("--permission-mode dont-ask");
        expect(argumentLines[1]).toContain("--resume session-123");
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
        const adapter = yield* makeCommandCodeAdapter(decodeSettings({}), { instanceId });
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
});
