import {
  type ApprovalRequestId,
  type CommandCodeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeTaskId,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { titleForToolName } from "@t3tools/shared/toolActivity";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

import {
  buildCommandCodeTurnArgs,
  commandCodeToolEnableEnv,
  type CommandCodeOutputFrame,
  parseCommandCodeNdjsonLine,
} from "../commandCodeCli.ts";
import type { CommandCodeReasoningEffortValidator } from "../commandCodeCatalog.ts";
import {
  makeCommandCodeTranscriptReader,
  type CommandCodeTranscriptUsage,
} from "../commandCodeTranscript.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  commandCodeMcpAddArgs,
  commandCodeMcpRemoveArgs,
  runCommandCodeMcpCommand,
} from "../Drivers/CommandCodeMcp.ts";

const PROVIDER = ProviderDriverKind.make("commandcode");
const RESUME_VERSION = 2 as const;
const START_TIMEOUT_MS = 10_000;

export interface CommandCodeAdapterOptions {
  readonly catalogController: CommandCodeAdapterCatalogController;
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly startupTimeoutMs?: number;
  /** Granted with `--add-dir` so the CLI can read attached images by path. */
  readonly attachmentsDir?: string;
}

export interface CommandCodeAdapterCatalogController extends CommandCodeReasoningEffortValidator {
  readonly getModelContextWindow: (modelSlug: string) => Effect.Effect<number | undefined>;
}

/** One assistant prose block. A turn emits one per CLI `message_*` cycle. */
interface AssistantSegment {
  readonly itemId: RuntimeItemId;
  text: string;
}

interface TurnState {
  readonly turnId: TurnId;
  readonly reasoningItemId: RuntimeItemId;
  // Assistant text is segmented per CLI message so tool rows interleave
  // between paragraphs. `assistantSegment` is the currently open block, if any.
  assistantSegment: AssistantSegment | undefined;
  assistantSegmentCount: number;
  assistantTextEmitted: boolean;
  reasoningStarted: boolean;
  reasoningCompleted: boolean;
  reasoningBlockHasDelta: boolean;
  interrupted: boolean;
  suppressTerminalState: boolean;
  stderrTail: string;
  startedAtMs: number;
  // Rebuilt from the stream so a turn still reports usage when the CLI's final
  // `result` line never arrives. See `addStreamUsage`.
  streamUsage: StreamUsage;
  readonly tools: Map<
    string,
    {
      readonly itemId: RuntimeItemId;
      readonly itemType: ToolLifecycleItemType;
      readonly title: string;
      readonly hint: string | undefined;
      readonly command: string | undefined;
    }
  >;
  readonly tasks: Set<string>;
}

interface CommandCodeSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  resumeSessionId: string | undefined;
  totalProcessedTokens: number;
  reasoningEffort: string | undefined;
  activeChild: ChildProcessHandle | undefined;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  activeTurn: TurnState | undefined;
  // Command Code cannot steer a running turn, so sends queue instead. `sendGate`
  // makes check-and-claim atomic (and gives FIFO ordering) while `turnSettled`
  // is completed by the forked turn fiber on every exit path, releasing the
  // next waiter.
  readonly sendGate: Semaphore.Semaphore;
  turnSettled: Deferred.Deferred<void> | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

interface ParsedResumeCursor {
  readonly sessionId: string;
  readonly totalProcessedTokens: number;
}

function parseResumeCursor(raw: unknown): ParsedResumeCursor | undefined {
  if (!Predicate.isObject(raw) || Array.isArray(raw)) return undefined;
  const cursor: Record<string, unknown> = raw;
  if (typeof cursor.sessionId !== "string" || cursor.sessionId.trim().length === 0) {
    return undefined;
  }
  const sessionId = cursor.sessionId.trim();
  if (cursor.schemaVersion === 1) return { sessionId, totalProcessedTokens: 0 };
  return cursor.schemaVersion === RESUME_VERSION &&
    typeof cursor.totalProcessedTokens === "number" &&
    Number.isInteger(cursor.totalProcessedTokens) &&
    cursor.totalProcessedTokens >= 0
    ? { sessionId, totalProcessedTokens: cursor.totalProcessedTokens }
    : undefined;
}

function eventString(event: Readonly<Record<string, unknown>>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * Streamed text, unlike metadata, is meaningful when it is pure whitespace: the
 * CLI emits `"\n"` as its own delta, and dropping it as `eventString` does
 * glues markdown lines together (closing ``` fences land mid-line).
 */
function eventText(event: Readonly<Record<string, unknown>>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

const TOOL_HINT_LIMIT = 200;

function toolInputRecord(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (const key of ["input", "toolInput", "tool_input", "args", "arguments"]) {
    const value = event[key];
    if (Predicate.isObject(value) && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function toolCommand(input: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["command", "cmd"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (Array.isArray(value)) {
      const parts = value.filter(
        (part): part is string => typeof part === "string" && part.trim().length > 0,
      );
      if (parts.length > 0) return parts.join(" ");
    }
  }
  return undefined;
}

/**
 * One-line hint for a tool row, e.g. `run_command: vp test`. Command Code never
 * sends a human summary, so derive one from the tool input — otherwise every
 * row collapses to the bare item label ("Command run", "Tool call").
 */
function toolHint(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  command: string | undefined,
): string | undefined {
  const body =
    command ?? (input && Object.keys(input).length > 0 ? JSON.stringify(input) : undefined);
  const parts = [toolName?.trim(), body].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return undefined;
  const hint = parts.join(": ").replace(/\s+/g, " ").trim();
  return hint.length > TOOL_HINT_LIMIT ? `${hint.slice(0, TOOL_HINT_LIMIT - 1)}…` : hint;
}

interface StreamUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const EMPTY_STREAM_USAGE: StreamUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function isParsableJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function usageCount(record: Record<string, unknown>, ...keys: ReadonlyArray<string>): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Sums `model_request_end` usage across the run, which is exactly how the CLI
 * builds the totals it puts on its final `result` line.
 *
 * That line is lost whenever the CLI's preceding `run_end` — which carries the
 * whole conversation in `result.nextState.messages` — overflows the stdout pipe
 * buffer, because the CLI calls `process.exit` right after writing and Node
 * discards whatever is still queued on a pipe. Rebuilding the same total from
 * the small per-request frames keeps the context meter alive on long threads.
 */
function addStreamUsage(total: StreamUsage, usage: unknown): StreamUsage {
  if (!Predicate.isObject(usage) || Array.isArray(usage)) return total;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: total.inputTokens + usageCount(record, "inputTokens", "input_tokens"),
    outputTokens: total.outputTokens + usageCount(record, "outputTokens", "output_tokens"),
    cacheReadTokens:
      total.cacheReadTokens + usageCount(record, "cacheReadTokens", "cache_read_tokens"),
    cacheWriteTokens:
      total.cacheWriteTokens + usageCount(record, "cacheWriteTokens", "cache_write_tokens"),
  };
}

function aggregateUsageSnapshot(usage: unknown, durationMs: number) {
  const record = Predicate.isObject(usage) && !Array.isArray(usage) ? usage : {};
  const readCount = (...keys: ReadonlyArray<string>) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    }
    return undefined;
  };
  const inputTokens = readCount("inputTokens", "input_tokens") ?? 0;
  const outputTokens = readCount("outputTokens", "output_tokens") ?? 0;
  const cachedInputTokens = readCount("cacheReadTokens", "cache_read_tokens") ?? 0;
  const cacheWriteTokens = readCount("cacheWriteTokens", "cache_write_tokens") ?? 0;
  return {
    usedTokens: inputTokens + outputTokens + cachedInputTokens + cacheWriteTokens,
    // The wire contract has no cache-write component, so keep the native input
    // breakdown intact while including cache writes in the full context total.
    inputTokens,
    cachedInputTokens,
    outputTokens,
    durationMs: Math.max(0, Math.round(durationMs)),
    compactsAutomatically: true,
  };
}

function activeUsageSnapshot(
  usage: CommandCodeTranscriptUsage,
  durationMs: number,
  totalProcessedTokens: number,
  maxTokens: number | undefined,
) {
  return {
    usedTokens:
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    totalProcessedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    // Cache writes contribute to usedTokens but are not folded into native input.
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    durationMs: Math.max(0, Math.round(durationMs)),
    compactsAutomatically: true,
  };
}

/** `{ todos: [{ content, status }] }`, the CLI's `todo_write` input. */
function planStepsFromTodoInput(
  input: Record<string, unknown> | undefined,
): ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((todo): todo is Record<string, unknown> => Predicate.isObject(todo))
    .map((todo) => ({
      step: typeof todo.content === "string" && todo.content.trim() ? todo.content.trim() : "Task",
      status:
        todo.status === "completed"
          ? ("completed" as const)
          : todo.status === "in_progress"
            ? ("inProgress" as const)
            : ("pending" as const),
    }));
}

function toolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  // Checked before the edit/write branch, which "todo_write" would otherwise
  // match and render as a file change.
  if (normalized.includes("todo")) return "dynamic_tool_call";
  if (normalized.includes("command") || normalized.includes("shell") || normalized === "bash") {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("agent") || normalized === "task") return "collab_agent_tool_call";
  if (normalized.includes("web") || normalized.includes("search")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function resultErrorDetail(
  result: Extract<CommandCodeOutputFrame, { readonly type: "result" }>,
): string {
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return result.error.trim();
  }
  if (
    Predicate.isObject(result.error) &&
    typeof result.error.message === "string" &&
    result.error.message.trim().length > 0
  ) {
    return result.error.message.trim();
  }
  return result.subtype === "success"
    ? "Command Code completed without reporting a session id."
    : `Command Code finished with ${result.subtype}.`;
}

export function makeCommandCodeAdapter(
  settings: CommandCodeSettings,
  options: CommandCodeAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
> {
  return Effect.gen(function* () {
    const instanceId = options.instanceId ?? ProviderInstanceId.make("commandcode");
    const environment = options.environment ?? process.env;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const startupTimeoutMs = options.startupTimeoutMs ?? START_TIMEOUT_MS;
    const catalogController = options.catalogController;
    const transcriptReader = yield* makeCommandCodeTranscriptReader(environment);
    const adapterScope = yield* Scope.Scope;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, CommandCodeSessionContext>();

    const selectedReasoningEffort = (
      modelSelection: Parameters<typeof getModelSelectionStringOptionValue>[0],
    ) => {
      const value = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
      return value === "default" ? undefined : value;
    };

    const validateReasoningEffort = Effect.fn("CommandCodeAdapter.validateReasoningEffort")(
      function* (model: string, reasoningEffort: string | undefined) {
        if (reasoningEffort === undefined) return;
        const supported = yield* catalogController.supportsReasoningEffort(model, reasoningEffort);
        if (!supported) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Reasoning effort '${reasoningEffort}' is not supported by Command Code model '${model}'.`,
          });
        }
      },
    );

    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a Command Code runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = Effect.all({
      eventId: randomUUID.pipe(Effect.map(EventId.make)),
      createdAt: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);
    const base = (
      ctx: CommandCodeSessionContext,
      turnId?: TurnId,
      raw?: Readonly<Record<string, unknown>>,
    ) =>
      Effect.gen(function* () {
        return {
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          ...(raw
            ? {
                raw: {
                  source: "commandcode.cli.event" as const,
                  messageType: eventString(raw, "type"),
                  payload: raw,
                },
              }
            : {}),
        };
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CommandCodeSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const signalProcessGroup = (child: ChildProcessHandle, signal: NodeJS.Signals) =>
      Effect.sync(() => {
        try {
          process.kill(-Number(child.pid), signal);
        } catch {
          // The exact child process group may already have exited.
        }
      });
    const terminateChild = (child: ChildProcessHandle, signal: NodeJS.Signals = "SIGINT") => {
      if (platform === "win32") {
        return child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid);
      }
      return signalProcessGroup(child, signal).pipe(
        Effect.andThen(
          Effect.raceFirst(
            child.exitCode.pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
            Effect.sleep("1 second").pipe(Effect.andThen(signalProcessGroup(child, "SIGKILL"))),
          ),
        ),
      );
    };

    /**
     * Opens the assistant block for the current CLI message, keyed by the CLI's
     * own message id when it has one so a block keeps a stable item id.
     */
    const openAssistantSegment = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      raw?: Readonly<Record<string, unknown>>,
    ) =>
      Effect.gen(function* () {
        const existing = turn.assistantSegment;
        if (existing) return existing;
        const messageId = raw ? eventString(raw, "messageId", "message_id") : undefined;
        const key = messageId ?? `${turn.assistantSegmentCount}`;
        turn.assistantSegmentCount += 1;
        const segment: AssistantSegment = {
          itemId: RuntimeItemId.make(`${turn.turnId}-assistant-${key}`),
          text: "",
        };
        turn.assistantSegment = segment;
        yield* publish({
          type: "item.started",
          ...(yield* base(ctx, turn.turnId, raw)),
          itemId: segment.itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        return segment;
      });

    /** Closes the open assistant block, if any. A no-op once it is closed. */
    const completeAssistantSegment = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      raw?: Readonly<Record<string, unknown>>,
    ) =>
      Effect.gen(function* () {
        const segment = turn.assistantSegment;
        if (!segment) return;
        turn.assistantSegment = undefined;
        yield* publish({
          type: "item.completed",
          ...(yield* base(ctx, turn.turnId, raw)),
          itemId: segment.itemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            ...(segment.text ? { detail: segment.text } : {}),
          },
        });
      });

    const completeReasoning = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      raw?: Readonly<Record<string, unknown>>,
    ) =>
      Effect.gen(function* () {
        if (!turn.reasoningStarted || turn.reasoningCompleted) return;
        turn.reasoningCompleted = true;
        yield* publish({
          type: "item.completed",
          ...(yield* base(ctx, turn.turnId, raw)),
          itemId: turn.reasoningItemId,
          payload: { itemType: "reasoning", status: "completed" },
        });
      });

    const settleTurnState = (ctx: CommandCodeSessionContext, turn: TurnState) =>
      Effect.gen(function* () {
        if (ctx.activeTurn?.turnId !== turn.turnId) return;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const { activeTurnId: _activeTurnId, ...ready } = ctx.session;
        ctx.session = { ...ready, status: "ready", updatedAt };
        ctx.activeTurn = undefined;
        ctx.activeChild = undefined;
        ctx.activeFiber = undefined;
      });

    const toolState = (turn: TurnState, event: Readonly<Record<string, unknown>>) => {
      const toolCallId = eventString(event, "toolCallId", "tool_call_id");
      if (!toolCallId) return undefined;
      const existing = turn.tools.get(toolCallId);
      if (existing) return { toolCallId, ...existing };
      const toolName = eventString(event, "toolName", "tool_name");
      const itemType = toolName ? toolItemType(toolName) : "dynamic_tool_call";
      const input = toolInputRecord(event);
      const command = toolCommand(input);
      const created = {
        itemId: RuntimeItemId.make(`${turn.turnId}-tool-${toolCallId}`),
        itemType,
        // Raw tool name stays in `data` (the source event); the title is the label.
        title: toolName ? titleForToolName(toolName, itemType) : "Command Code tool",
        hint: toolHint(toolName, input, command),
        command,
      };
      turn.tools.set(toolCallId, created);
      return { toolCallId, ...created };
    };

    /**
     * Command rows preview from `data.item.command`, so surface the parsed
     * command there while leaving the source event untouched underneath.
     */
    const toolData = (
      tool: { readonly command: string | undefined },
      event: Readonly<Record<string, unknown>>,
    ) =>
      tool.command === undefined || "item" in event
        ? event
        : { ...event, item: { command: tool.command } };

    const handleEvent = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      event: Readonly<Record<string, unknown>> & { readonly type: string },
      resumeReady: Deferred.Deferred<string, ProviderAdapterProcessError>,
    ) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "run_start": {
            const sessionId = eventString(event, "sessionId", "session_id");
            if (sessionId) {
              ctx.resumeSessionId = sessionId;
              ctx.session = {
                ...ctx.session,
                resumeCursor: {
                  schemaVersion: RESUME_VERSION,
                  sessionId,
                  totalProcessedTokens: ctx.totalProcessedTokens,
                },
              };
              yield* Deferred.succeed(resumeReady, sessionId).pipe(Effect.ignore);
            }
            break;
          }
          case "model_request_end": {
            turn.streamUsage = addStreamUsage(turn.streamUsage, event.usage);
            break;
          }
          case "thinking_start": {
            turn.reasoningBlockHasDelta = false;
            if (!turn.reasoningStarted) {
              turn.reasoningStarted = true;
              yield* publish({
                type: "item.started",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.reasoningItemId,
                payload: { itemType: "reasoning", status: "inProgress" },
              });
            }
            break;
          }
          case "thinking_delta": {
            const delta = eventText(event, "delta", "text");
            if (!turn.reasoningStarted) {
              turn.reasoningStarted = true;
              yield* publish({
                type: "item.started",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.reasoningItemId,
                payload: { itemType: "reasoning", status: "inProgress" },
              });
            }
            if (delta !== undefined) {
              turn.reasoningBlockHasDelta = true;
              yield* publish({
                type: "content.delta",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.reasoningItemId,
                payload: { streamKind: "reasoning_text", delta },
              });
            }
            break;
          }
          case "thinking_end": {
            const text = eventText(event, "text");
            if (!turn.reasoningStarted && text !== undefined) {
              turn.reasoningStarted = true;
              yield* publish({
                type: "item.started",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.reasoningItemId,
                payload: { itemType: "reasoning", status: "inProgress" },
              });
            }
            if (text !== undefined && !turn.reasoningBlockHasDelta) {
              yield* publish({
                type: "content.delta",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.reasoningItemId,
                payload: { streamKind: "reasoning_text", delta: text },
              });
            }
            turn.reasoningBlockHasDelta = false;
            break;
          }
          case "tool_queued": {
            const tool = toolState(turn, event);
            if (!tool) break;
            yield* publish({
              type: "item.started",
              ...(yield* base(ctx, turn.turnId, event)),
              itemId: tool.itemId,
              payload: {
                itemType: tool.itemType,
                status: "inProgress",
                title: tool.title,
                ...(tool.hint ? { detail: tool.hint } : {}),
                data: toolData(tool, event),
              },
            });
            // Todos drive the plan panel here as they do for the other
            // providers, instead of reading as a tool row full of raw JSON.
            const toolName = eventString(event, "toolName", "tool_name");
            const normalizedToolName = toolName?.toLowerCase();
            if (normalizedToolName?.includes("todo")) {
              const plan = planStepsFromTodoInput(toolInputRecord(event));
              if (plan.length > 0) {
                yield* publish({
                  type: "turn.plan.updated",
                  ...(yield* base(ctx, turn.turnId, event)),
                  payload: { plan },
                });
              }
            }
            // `exit_plan_mode` is how Command Code presents a finished plan, so
            // it becomes a plan proposal like Claude's `ExitPlanMode`. Headless
            // runs cannot write the plan file the CLI would otherwise prefer,
            // which leaves the inline `plan` argument as the only copy.
            if (normalizedToolName === "exit_plan_mode") {
              const planMarkdown = toolInputRecord(event)?.plan;
              if (typeof planMarkdown === "string" && planMarkdown.trim().length > 0) {
                yield* publish({
                  type: "turn.proposed.completed",
                  ...(yield* base(ctx, turn.turnId, event)),
                  payload: { planMarkdown: planMarkdown.trim() },
                });
              }
            }
            break;
          }
          case "tool_running":
          case "tool_update": {
            const existed = eventString(event, "toolCallId", "tool_call_id");
            const wasStarted = existed ? turn.tools.has(existed) : false;
            const tool = toolState(turn, event);
            if (!tool) break;
            yield* publish({
              type: wasStarted ? "item.updated" : "item.started",
              ...(yield* base(ctx, turn.turnId, event)),
              itemId: tool.itemId,
              payload: {
                itemType: tool.itemType,
                status: "inProgress",
                title: tool.title,
                ...((eventString(event, "partial", "description") ?? tool.hint)
                  ? { detail: eventString(event, "partial", "description") ?? tool.hint }
                  : {}),
                data: toolData(tool, event),
              },
            });
            break;
          }
          case "tool_completed":
          case "tool_errored":
          case "tool_denied":
          case "tool_hook_blocked": {
            const toolCallId = eventString(event, "toolCallId", "tool_call_id");
            const wasStarted = toolCallId ? turn.tools.has(toolCallId) : false;
            const tool = toolState(turn, event);
            if (!tool) break;
            if (!wasStarted) {
              yield* publish({
                type: "item.started",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: tool.itemId,
                payload: {
                  itemType: tool.itemType,
                  status: "inProgress",
                  title: tool.title,
                  ...(tool.hint ? { detail: tool.hint } : {}),
                  data: toolData(tool, event),
                },
              });
            }
            const status =
              event.type === "tool_completed"
                ? "completed"
                : event.type === "tool_denied"
                  ? "declined"
                  : "failed";
            yield* publish({
              type: "item.completed",
              ...(yield* base(ctx, turn.turnId, event)),
              itemId: tool.itemId,
              payload: {
                itemType: tool.itemType,
                status,
                title: tool.title,
                ...((eventString(event, "result", "error", "hookOutput") ?? tool.hint)
                  ? { detail: eventString(event, "result", "error", "hookOutput") ?? tool.hint }
                  : {}),
                data: toolData(tool, event),
              },
            });
            break;
          }
          case "subagent_start": {
            const toolCallId = eventString(event, "toolCallId", "tool_call_id");
            if (!toolCallId || turn.tasks.has(toolCallId)) break;
            turn.tasks.add(toolCallId);
            const title = eventString(event, "subagentType", "subagent_type") ?? "subagent";
            yield* publish({
              type: "task.started",
              ...(yield* base(ctx, turn.turnId, event)),
              payload: {
                taskId: RuntimeTaskId.make(toolCallId),
                description: title,
                title,
                role: title,
                toolUseId: toolCallId,
              },
            });
            break;
          }
          case "subagent_progress": {
            const toolCallId = eventString(event, "toolCallId", "tool_call_id");
            if (!toolCallId) break;
            const title = eventString(event, "subagentType", "subagent_type") ?? "subagent";
            if (!turn.tasks.has(toolCallId)) {
              turn.tasks.add(toolCallId);
              yield* publish({
                type: "task.started",
                ...(yield* base(ctx, turn.turnId, event)),
                payload: {
                  taskId: RuntimeTaskId.make(toolCallId),
                  description: title,
                  title,
                  role: title,
                  toolUseId: toolCallId,
                },
              });
            }
            const tokensUsed = event.tokensUsed;
            const toolName = eventString(event, "toolName", "tool_name");
            yield* publish({
              type: "task.progress",
              ...(yield* base(ctx, turn.turnId, event)),
              payload: {
                taskId: RuntimeTaskId.make(toolCallId),
                description: toolName ? `${title}: ${toolName}` : title,
                title,
                role: title,
                toolUseId: toolCallId,
                ...(toolName ? { lastToolName: toolName } : {}),
                ...(typeof tokensUsed === "number" &&
                Number.isInteger(tokensUsed) &&
                tokensUsed >= 0
                  ? { typedUsage: { totalTokens: tokensUsed } }
                  : {}),
              },
            });
            break;
          }
          case "subagent_stop": {
            const toolCallId = eventString(event, "toolCallId", "tool_call_id");
            if (!toolCallId) break;
            const title = eventString(event, "subagentType", "subagent_type") ?? "subagent";
            const tokensUsed = event.tokensUsed;
            if (!turn.tasks.has(toolCallId)) {
              turn.tasks.add(toolCallId);
              yield* publish({
                type: "task.started",
                ...(yield* base(ctx, turn.turnId, event)),
                payload: {
                  taskId: RuntimeTaskId.make(toolCallId),
                  description: title,
                  title,
                  role: title,
                  toolUseId: toolCallId,
                },
              });
            }
            yield* publish({
              type: "task.completed",
              ...(yield* base(ctx, turn.turnId, event)),
              payload: {
                taskId: RuntimeTaskId.make(toolCallId),
                status: "completed",
                title,
                role: title,
                toolUseId: toolCallId,
                ...(typeof tokensUsed === "number" &&
                Number.isInteger(tokensUsed) &&
                tokensUsed >= 0
                  ? { typedUsage: { totalTokens: tokensUsed } }
                  : {}),
              },
            });
            break;
          }
          case "message_start": {
            yield* openAssistantSegment(ctx, turn, event);
            break;
          }
          case "text_delta": {
            const delta = eventText(event, "delta", "text");
            const segment = yield* openAssistantSegment(ctx, turn, event);
            if (delta !== undefined) {
              segment.text += delta;
              turn.assistantTextEmitted = true;
              yield* publish({
                type: "content.delta",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: segment.itemId,
                payload: { streamKind: "assistant_text", delta },
              });
            }
            break;
          }
          case "message_end": {
            yield* completeAssistantSegment(ctx, turn, event);
            break;
          }
        }
      });

    /**
     * Publishes the context-window snapshot for a settled turn. `aggregateUsage`
     * must already be folded into `ctx.totalProcessedTokens`; the transcript is
     * preferred when it is readable because it reports the live context, not the
     * turn's own token spend.
     */
    const publishTokenUsage = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      aggregateUsage: ReturnType<typeof aggregateUsageSnapshot>,
      sessionId: string | undefined,
    ) =>
      Effect.gen(function* () {
        const activeUsage =
          sessionId === undefined
            ? undefined
            : yield* transcriptReader.readLatestUsage({ cwd: ctx.cwd, sessionId });
        const contextModel = activeUsage?.model ?? ctx.session.model;
        const maxTokens =
          contextModel === undefined
            ? undefined
            : yield* catalogController.getModelContextWindow(contextModel);
        yield* publish({
          type: "thread.token-usage.updated",
          ...(yield* base(ctx, turn.turnId)),
          payload: {
            usage:
              activeUsage === undefined
                ? {
                    ...aggregateUsage,
                    totalProcessedTokens: ctx.totalProcessedTokens,
                    ...(maxTokens !== undefined ? { maxTokens } : {}),
                  }
                : activeUsageSnapshot(
                    activeUsage,
                    aggregateUsage.durationMs,
                    ctx.totalProcessedTokens,
                    maxTokens,
                  ),
          },
        });
      });

    const handleResult = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      result: Extract<CommandCodeOutputFrame, { readonly type: "result" }>,
      resumeReady: Deferred.Deferred<string, ProviderAdapterProcessError>,
    ) =>
      Effect.gen(function* () {
        const aggregateUsage = aggregateUsageSnapshot(result.usage, result.durationMs);
        ctx.totalProcessedTokens += aggregateUsage.usedTokens;
        if (result.sessionId) {
          ctx.resumeSessionId = result.sessionId;
        }
        const resumeSessionId = result.sessionId ?? ctx.resumeSessionId;
        if (resumeSessionId !== undefined) {
          ctx.session = {
            ...ctx.session,
            resumeCursor: {
              schemaVersion: RESUME_VERSION,
              sessionId: resumeSessionId,
              totalProcessedTokens: ctx.totalProcessedTokens,
            },
          };
        }
        const successful = result.subtype === "success" && resumeSessionId !== undefined;
        if (successful) {
          yield* Deferred.succeed(resumeReady, resumeSessionId).pipe(Effect.ignore);
        } else {
          yield* Deferred.fail(
            resumeReady,
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ctx.threadId,
              detail: resultErrorDetail(result),
            }),
          ).pipe(Effect.ignore);
        }
        // `assistantTextEmitted` spans the whole turn, so a multi-segment turn
        // never replays `finalText` as a duplicate trailing paragraph.
        if (!turn.assistantTextEmitted && result.finalText) {
          const segment = yield* openAssistantSegment(ctx, turn);
          segment.text = result.finalText;
          turn.assistantTextEmitted = true;
          yield* publish({
            type: "content.delta",
            ...(yield* base(ctx, turn.turnId)),
            itemId: segment.itemId,
            payload: { streamKind: "assistant_text", delta: result.finalText },
          });
        }
        yield* completeReasoning(ctx, turn);
        yield* completeAssistantSegment(ctx, turn);
        yield* publishTokenUsage(ctx, turn, aggregateUsage, resumeSessionId);
        yield* settleTurnState(ctx, turn);
        yield* publish({
          type: "turn.completed",
          ...(yield* base(ctx, turn.turnId)),
          payload: {
            state: successful ? "completed" : "failed",
            ...(result.stopReason ? { stopReason: result.stopReason } : {}),
            usage: result.usage,
            ...(!successful ? { errorMessage: resultErrorDetail(result) } : {}),
          },
        });
      });

    const runTurn = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      prompt: string,
      model: string,
      reasoningEffort: string | undefined,
      interactionMode: "default" | "plan",
      hasAttachments: boolean,
      resumeReady: Deferred.Deferred<string, ProviderAdapterProcessError>,
    ) =>
      Effect.gen(function* () {
        const args = buildCommandCodeTurnArgs({
          model,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(ctx.resumeSessionId ? { resumeSessionId: ctx.resumeSessionId } : {}),
          ...(options.attachmentsDir ? { attachmentsDir: options.attachmentsDir } : {}),
          ...(hasAttachments ? { enableImageVision: true } : {}),
          ...(settings.launchArgs ? { launchArgs: settings.launchArgs } : {}),
        });
        const binaryPath = settings.binaryPath || "command-code";
        const turnEnvironment = {
          ...environment,
          ...commandCodeToolEnableEnv(interactionMode),
        };
        const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
        const child = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: ctx.cwd,
            env: turnEnvironment,
            shell: spawnCommand.shell,
            detached: platform !== "win32",
            stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
          }),
        );
        ctx.activeChild = child;

        let resultFrame: Extract<CommandCodeOutputFrame, { readonly type: "result" }> | undefined;
        const consumeLine = (line: string) => {
          const frame = parseCommandCodeNdjsonLine(line);
          if (!frame) {
            // Half a JSON object is the CLI cutting its own stdout off at exit,
            // not a protocol change. It is expected on long threads (see
            // `addStreamUsage`) and nothing the user can act on, so it stays in
            // the server log instead of the thread.
            if (!isParsableJson(line)) {
              return Effect.logDebug("Command Code stdout line was cut short.", {
                threadId: ctx.threadId,
                bytes: line.length,
              });
            }
            return base(ctx, turn.turnId).pipe(
              Effect.flatMap((eventBase) =>
                publish({
                  type: "runtime.warning",
                  ...eventBase,
                  payload: {
                    message: "Command Code emitted an unrecognized NDJSON line.",
                    detail: line.slice(0, 2_000),
                  },
                }),
              ),
            );
          }
          if (frame.type === "event") return handleEvent(ctx, turn, frame.event, resumeReady);
          resultFrame = frame;
          return Effect.void;
        };
        const stdout = child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach(consumeLine),
        );
        const stderr = child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => {
              const stderrTail = `${acc}${chunk}`.slice(-8_000);
              turn.stderrTail = stderrTail;
              return stderrTail;
            },
          ),
        );
        const [, stderrText, exitCode] = yield* Effect.all(
          [stdout, stderr, child.exitCode.pipe(Effect.map(Number))],
          { concurrency: "unbounded" },
        );

        if (turn.suppressTerminalState) {
          return;
        }
        if (turn.interrupted || exitCode === 130) {
          yield* settleTurnState(ctx, turn);
          yield* publish({
            type: "turn.aborted",
            ...(yield* base(ctx, turn.turnId)),
            payload: { reason: "Command Code turn interrupted." },
          });
        } else if (resultFrame) {
          yield* handleResult(ctx, turn, resultFrame, resumeReady);
        } else if (exitCode === 0) {
          // The CLI ran to completion (exit 0) without emitting a result frame
          // — e.g. a print-mode prompt that needed no model turn, or a turn
          // whose stream closed before the final frame flushed. Exit 0 is the
          // CLI's success signal, so this is a completed turn, not a failure.
          yield* completeReasoning(ctx, turn);
          yield* completeAssistantSegment(ctx, turn);
          const sessionId = ctx.resumeSessionId;
          if (sessionId === undefined) {
            // No session id was ever reported (no run_start), so there is no
            // resume cursor to hand back. Fail the turn rather than showing a
            // completed turn next to a "turn start failed" activity.
            const detail = "Command Code exited without reporting a session id.";
            yield* Deferred.fail(
              resumeReady,
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: ctx.threadId,
                detail,
              }),
            ).pipe(Effect.ignore);
            yield* settleTurnState(ctx, turn);
            yield* publish({
              type: "turn.completed",
              ...(yield* base(ctx, turn.turnId)),
              payload: { state: "failed", errorMessage: detail },
            });
          } else {
            yield* Deferred.succeed(resumeReady, sessionId).pipe(Effect.ignore);
            // The result frame is the usual carrier for usage, and it is the
            // frame most likely to be lost to the CLI's exit-time stdout
            // truncation. Fall back to the totals rebuilt from the stream so the
            // context meter keeps a reading instead of disappearing.
            const elapsedMs = Math.max(
              0,
              DateTime.toEpochMillis(yield* DateTime.now) - turn.startedAtMs,
            );
            const aggregateUsage = aggregateUsageSnapshot(turn.streamUsage, elapsedMs);
            ctx.totalProcessedTokens += aggregateUsage.usedTokens;
            ctx.session = {
              ...ctx.session,
              resumeCursor: {
                schemaVersion: RESUME_VERSION,
                sessionId,
                totalProcessedTokens: ctx.totalProcessedTokens,
              },
            };
            yield* publishTokenUsage(ctx, turn, aggregateUsage, sessionId);
            yield* settleTurnState(ctx, turn);
            yield* publish({
              type: "turn.completed",
              ...(yield* base(ctx, turn.turnId)),
              payload: { state: "completed" },
            });
          }
        } else {
          const detail = stderrText.trim() || `Command Code exited with code ${exitCode}.`;
          yield* Deferred.fail(
            resumeReady,
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ctx.threadId,
              detail,
            }),
          ).pipe(Effect.ignore);
          yield* settleTurnState(ctx, turn);
          yield* publish({
            type: "turn.completed",
            ...(yield* base(ctx, turn.turnId)),
            payload: { state: "failed", errorMessage: detail },
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (turn.interrupted) {
              yield* settleTurnState(ctx, turn);
              yield* publish({
                type: "turn.aborted",
                ...(yield* base(ctx, turn.turnId)),
                payload: { reason: "Command Code turn interrupted." },
              });
              return;
            }
            const error = new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ctx.threadId,
              detail: "Command Code process failed.",
              cause,
            });
            yield* Deferred.fail(resumeReady, error).pipe(Effect.ignore);
            yield* settleTurnState(ctx, turn);
            yield* publish({
              type: "turn.completed",
              ...(yield* base(ctx, turn.turnId)),
              payload: { state: "failed", errorMessage: error.message },
            });
          }),
        ),
        Effect.ensuring(settleTurnState(ctx, turn)),
        Effect.catchCause((cause) =>
          Effect.logError("Command Code turn cleanup failed.", {
            cause,
            threadId: ctx.threadId,
          }),
        ),
      );

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore);
          sessions.delete(input.threadId);
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const resumeCursor = parseResumeCursor(input.resumeCursor);
        const resumeSessionId = resumeCursor?.sessionId;
        const sessionScope = yield* Scope.make("sequential");
        const modelSelection =
          input.modelSelection?.instanceId === instanceId ? input.modelSelection : undefined;
        const model = modelSelection?.model ?? "deepseek/deepseek-v4-flash";
        const cwd = path.resolve(input.cwd.trim());
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          cwd,
          runtimeMode: input.runtimeMode,
          model,
          status: "ready",
          ...(resumeSessionId
            ? {
                resumeCursor: {
                  schemaVersion: RESUME_VERSION,
                  sessionId: resumeSessionId,
                  totalProcessedTokens: resumeCursor.totalProcessedTokens,
                },
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        const ctx: CommandCodeSessionContext = {
          threadId: input.threadId,
          cwd,
          scope: sessionScope,
          session,
          resumeSessionId,
          totalProcessedTokens: resumeCursor?.totalProcessedTokens ?? 0,
          reasoningEffort: selectedReasoningEffort(modelSelection),
          activeChild: undefined,
          activeFiber: undefined,
          activeTurn: undefined,
          sendGate: yield* Semaphore.make(1),
          turnSettled: undefined,
          turns: [],
          stopped: false,
        };
        sessions.set(input.threadId, ctx);

        // The CLI reads MCP servers from config at process start, so the entry
        // has to exist before the first turn spawns. Sweeping first clears a
        // stale token left behind by a crashed run.
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        if (mcpSession) {
          const binaryPath = settings.binaryPath || "command-code";
          const runMcpCommand = (args: ReadonlyArray<string>) =>
            runCommandCodeMcpCommand({ binaryPath, args, cwd, environment, spawner });
          yield* runMcpCommand(commandCodeMcpRemoveArgs());
          yield* runMcpCommand(
            commandCodeMcpAddArgs({
              endpoint: mcpSession.endpoint,
              authorizationHeader: mcpSession.authorizationHeader,
            }),
          );
          yield* Scope.addFinalizer(
            sessionScope,
            runMcpCommand(commandCodeMcpRemoveArgs()).pipe(Effect.ignore),
          );
        }

        yield* publish({
          type: "session.started",
          ...(yield* base(ctx)),
          payload: {
            message: "Command Code session started",
            ...(session.resumeCursor ? { resume: session.resumeCursor } : {}),
          },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* base(ctx)),
          payload: resumeSessionId ? { providerThreadId: resumeSessionId } : {},
        });
        return session;
      });

    /** Validates the request and resolves its session. It does not claim the turn. */
    const resolveTurnRequest = (
      input: Parameters<ProviderAdapterShape<ProviderAdapterError>["sendTurn"]>[0],
    ): Effect.Effect<
      { readonly ctx: CommandCodeSessionContext; readonly prompt: string },
      ProviderAdapterSessionNotFoundError | ProviderAdapterValidationError
    > =>
      Effect.suspend<
        { readonly ctx: CommandCodeSessionContext; readonly prompt: string },
        ProviderAdapterSessionNotFoundError | ProviderAdapterValidationError,
        never
      >(() => {
        const ctx = sessions.get(input.threadId);
        if (!ctx || ctx.stopped) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          );
        }
        // Attachments need no special handling: ProviderService already appends
        // each file's on-disk path to the prompt, and Command Code reads images
        // by path (`--add-dir` grants the attachments dir).
        if (!input.input?.trim()) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "input is required and must be non-empty.",
            }),
          );
        }
        if (input.modelSelection && input.modelSelection.instanceId !== instanceId) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Model selection belongs to '${input.modelSelection.instanceId}', not '${instanceId}'.`,
            }),
          );
        }
        return Effect.succeed({ ctx, prompt: input.input.trim() });
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      resolveTurnRequest(input).pipe(
        Effect.flatMap(({ ctx, prompt }) =>
          Effect.gen(function* () {
            // Command Code headless cannot steer a running turn, so a send that
            // arrives mid-turn waits here and then runs as its own turn. The
            // wait is interruptible and the gate is released on every turn exit
            // path, so stopping the session never strands a waiter.
            const previous = ctx.turnSettled;
            if (previous !== undefined) yield* Deferred.await(previous);
            if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            const turnId = TurnId.make(yield* randomUUID);
            const turn: TurnState = {
              turnId,
              reasoningItemId: RuntimeItemId.make(`${turnId}-reasoning`),
              assistantSegment: undefined,
              assistantSegmentCount: 0,
              assistantTextEmitted: false,
              reasoningStarted: false,
              reasoningCompleted: false,
              reasoningBlockHasDelta: false,
              interrupted: false,
              suppressTerminalState: false,
              stderrTail: "",
              startedAtMs: DateTime.toEpochMillis(yield* DateTime.now),
              streamUsage: EMPTY_STREAM_USAGE,
              tools: new Map(),
              tasks: new Set(),
            };
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            const model =
              input.modelSelection?.model ?? ctx.session.model ?? "deepseek/deepseek-v4-flash";
            const reasoningEffort = input.modelSelection
              ? selectedReasoningEffort(input.modelSelection)
              : ctx.reasoningEffort;
            yield* validateReasoningEffort(model, reasoningEffort);
            ctx.reasoningEffort = reasoningEffort;
            ctx.activeTurn = turn;
            ctx.session = {
              ...ctx.session,
              status: "running",
              model,
              activeTurnId: turnId,
              updatedAt,
            };
            ctx.turns.push({ id: turnId, items: [] });
            yield* publish({
              type: "turn.started",
              ...(yield* base(ctx, turnId)),
              payload: { model },
            });
            const startAttempt = Effect.fn("CommandCodeAdapter.startAttempt")(function* () {
              const resumeReady = yield* Deferred.make<string, ProviderAdapterProcessError>();
              const settled = yield* Deferred.make<void>();
              turn.suppressTerminalState = false;
              turn.stderrTail = "";
              // A retry re-runs the whole turn, so usage restarts with it.
              turn.startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
              turn.streamUsage = EMPTY_STREAM_USAGE;
              ctx.activeFiber = yield* runTurn(
                ctx,
                turn,
                prompt,
                model,
                reasoningEffort,
                input.interactionMode ?? "default",
                (input.attachments?.length ?? 0) > 0,
                resumeReady,
              ).pipe(
                Effect.ensuring(Deferred.succeed(settled, undefined).pipe(Effect.asVoid)),
                Effect.forkIn(ctx.scope),
              );
              ctx.turnSettled = settled;
              return { resumeReady, settled };
            });
            const awaitStartup = (
              resumeReady: Deferred.Deferred<string, ProviderAdapterProcessError>,
            ) => Deferred.await(resumeReady).pipe(Effect.timeoutOption(startupTimeoutMs));
            const first = yield* startAttempt();
            const firstStartup = yield* awaitStartup(first.resumeReady);
            const sessionId =
              firstStartup._tag === "Some"
                ? firstStartup.value
                : yield* Effect.gen(function* () {
                    turn.suppressTerminalState = true;
                    if (ctx.activeChild) {
                      yield* terminateChild(ctx.activeChild, "SIGTERM").pipe(Effect.ignore);
                    }
                    yield* Deferred.await(first.settled);
                    if (turn.interrupted || ctx.stopped) {
                      return yield* new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        detail: "Command Code startup was interrupted.",
                      });
                    }
                    yield* publish({
                      type: "runtime.warning",
                      ...(yield* base(ctx, turn.turnId)),
                      payload: {
                        message: "Command Code startup timed out; retrying once.",
                        detail:
                          "The first headless Command Code process did not report a session before the startup deadline.",
                      },
                    });
                    const retry = yield* startAttempt();
                    const retryStartup = yield* awaitStartup(retry.resumeReady);
                    if (retryStartup._tag === "Some") return retryStartup.value;
                    turn.suppressTerminalState = true;
                    if (ctx.activeChild) {
                      yield* terminateChild(ctx.activeChild, "SIGTERM").pipe(Effect.ignore);
                    }
                    yield* Deferred.await(retry.settled);
                    const stderrTail = turn.stderrTail.trim();
                    const error = new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      detail: [
                        "Command Code did not report a session id before startup timed out after two attempts.",
                        ...(stderrTail ? [`Last stderr: ${stderrTail}`] : []),
                      ].join(" "),
                    });
                    yield* settleTurnState(ctx, turn);
                    yield* publish({
                      type: "turn.completed",
                      ...(yield* base(ctx, turn.turnId)),
                      payload: { state: "failed", errorMessage: error.message },
                    });
                    return yield* error;
                  });
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: {
                schemaVersion: RESUME_VERSION,
                sessionId,
                totalProcessedTokens: ctx.totalProcessedTokens,
              },
            };
          }).pipe(ctx.sendGate.withPermit),
        ),
      );

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!ctx.activeTurn || (turnId && ctx.activeTurn.turnId !== turnId)) return;
        ctx.activeTurn.interrupted = true;
        if (ctx.activeChild) yield* terminateChild(ctx.activeChild).pipe(Effect.ignore);
      });

    const unsupported = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "Command Code headless mode does not support this operation.",
        }),
      );

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.activeChild) yield* terminateChild(ctx.activeChild, "SIGTERM").pipe(Effect.ignore);
        if (ctx.activeFiber) yield* Fiber.interrupt(ctx.activeFiber);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* base(ctx)),
          payload: { exitKind: "graceful" },
        });
      });

    const stopAll = () =>
      Effect.forEach(Array.from(sessions.keys()), stopSession, { discard: true }).pipe(
        Effect.asVoid,
      );

    yield* Scope.addFinalizer(adapterScope, PubSub.shutdown(events));
    yield* Scope.addFinalizer(adapterScope, stopAll().pipe(Effect.ignore));

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
      ) => unsupported("respondToRequest"),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
      ) => unsupported("respondToUserInput"),
      stopSession,
      listSessions: () => Effect.succeed(Array.from(sessions.values(), (ctx) => ctx.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((ctx) => ({ threadId, turns: ctx.turns.map((turn) => ({ ...turn })) })),
        ),
      rollbackThread: () => unsupported("rollbackThread"),
      stopAll,
      streamEvents: Stream.fromPubSub(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
