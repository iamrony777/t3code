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
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

import {
  buildCommandCodeTurnArgs,
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

const PROVIDER = ProviderDriverKind.make("commandcode");
const RESUME_VERSION = 2 as const;
const START_TIMEOUT_MS = 10_000;

export interface CommandCodeAdapterOptions {
  readonly catalogController: CommandCodeAdapterCatalogController;
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly startupTimeoutMs?: number;
}

export interface CommandCodeAdapterCatalogController extends CommandCodeReasoningEffortValidator {
  readonly getModelContextWindow: (modelSlug: string) => Effect.Effect<number | undefined>;
}

interface TurnState {
  readonly turnId: TurnId;
  readonly assistantItemId: RuntimeItemId;
  readonly reasoningItemId: RuntimeItemId;
  assistantStarted: boolean;
  assistantCompleted: boolean;
  reasoningStarted: boolean;
  reasoningCompleted: boolean;
  reasoningBlockHasDelta: boolean;
  streamedText: string;
  interrupted: boolean;
  readonly tools: Map<
    string,
    {
      readonly itemId: RuntimeItemId;
      readonly itemType: ToolLifecycleItemType;
      readonly title: string;
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
  turnStarting: boolean;
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

function toolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
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

    const completeAssistant = (
      ctx: CommandCodeSessionContext,
      turn: TurnState,
      raw?: Readonly<Record<string, unknown>>,
    ) =>
      Effect.gen(function* () {
        if (!turn.assistantStarted || turn.assistantCompleted) return;
        turn.assistantCompleted = true;
        yield* publish({
          type: "item.completed",
          ...(yield* base(ctx, turn.turnId, raw)),
          itemId: turn.assistantItemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            ...(turn.streamedText ? { detail: turn.streamedText } : {}),
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
      const title = eventString(event, "toolName", "tool_name") ?? "Command Code tool";
      const created = {
        itemId: RuntimeItemId.make(`${turn.turnId}-tool-${toolCallId}`),
        itemType: toolItemType(title),
        title,
      };
      turn.tools.set(toolCallId, created);
      return { toolCallId, ...created };
    };

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
            const delta = eventString(event, "delta", "text");
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
            const text = eventString(event, "text");
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
                data: event,
              },
            });
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
                ...(eventString(event, "partial", "description")
                  ? { detail: eventString(event, "partial", "description") }
                  : {}),
                data: event,
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
                  data: event,
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
                ...(eventString(event, "result", "error", "hookOutput")
                  ? { detail: eventString(event, "result", "error", "hookOutput") }
                  : {}),
                data: event,
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
            if (!turn.assistantStarted) {
              turn.assistantStarted = true;
              yield* publish({
                type: "item.started",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.assistantItemId,
                payload: { itemType: "assistant_message", status: "inProgress" },
              });
            }
            break;
          }
          case "text_delta": {
            const delta = eventString(event, "delta", "text");
            if (!turn.assistantStarted) {
              turn.assistantStarted = true;
              yield* publish({
                type: "item.started",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.assistantItemId,
                payload: { itemType: "assistant_message", status: "inProgress" },
              });
            }
            if (delta !== undefined) {
              turn.streamedText += delta;
              yield* publish({
                type: "content.delta",
                ...(yield* base(ctx, turn.turnId, event)),
                itemId: turn.assistantItemId,
                payload: { streamKind: "assistant_text", delta },
              });
            }
            break;
          }
        }
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
        if (!turn.streamedText && result.finalText) {
          if (!turn.assistantStarted) {
            turn.assistantStarted = true;
            yield* publish({
              type: "item.started",
              ...(yield* base(ctx, turn.turnId)),
              itemId: turn.assistantItemId,
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
          }
          turn.streamedText = result.finalText;
          yield* publish({
            type: "content.delta",
            ...(yield* base(ctx, turn.turnId)),
            itemId: turn.assistantItemId,
            payload: { streamKind: "assistant_text", delta: result.finalText },
          });
        }
        yield* completeReasoning(ctx, turn);
        yield* completeAssistant(ctx, turn);
        const activeUsage =
          resumeSessionId === undefined
            ? undefined
            : yield* transcriptReader.readLatestUsage({
                cwd: ctx.cwd,
                sessionId: resumeSessionId,
              });
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
                    result.durationMs,
                    ctx.totalProcessedTokens,
                    maxTokens,
                  ),
          },
        });
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
      resumeReady: Deferred.Deferred<string, ProviderAdapterProcessError>,
    ) =>
      Effect.gen(function* () {
        const args = buildCommandCodeTurnArgs({
          model,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(ctx.resumeSessionId ? { resumeSessionId: ctx.resumeSessionId } : {}),
        });
        const binaryPath = settings.binaryPath || "command-code";
        const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
        const child = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: ctx.cwd,
            env: environment,
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
            (acc, chunk) => `${acc}${chunk}`.slice(-8_000),
          ),
        );
        const [, stderrText, exitCode] = yield* Effect.all(
          [stdout, stderr, child.exitCode.pipe(Effect.map(Number))],
          { concurrency: "unbounded" },
        );

        if (turn.interrupted || exitCode === 130) {
          yield* settleTurnState(ctx, turn);
          yield* publish({
            type: "turn.aborted",
            ...(yield* base(ctx, turn.turnId)),
            payload: { reason: "Command Code turn interrupted." },
          });
        } else if (resultFrame) {
          yield* handleResult(ctx, turn, resultFrame, resumeReady);
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
          turnStarting: false,
          turns: [],
          stopped: false,
        };
        sessions.set(input.threadId, ctx);
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

    const claimTurn = (
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
        if (input.attachments && input.attachments.length > 0) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Command Code headless mode does not support attachments.",
            }),
          );
        }
        if (!input.input?.trim()) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "input is required and must be non-empty.",
            }),
          );
        }
        if (ctx.activeTurn || ctx.turnStarting) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Command Code headless mode does not support mid-turn steering.",
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
        ctx.turnStarting = true;
        return Effect.succeed({ ctx, prompt: input.input.trim() });
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.acquireUseRelease(
        claimTurn(input),
        ({ ctx, prompt }) =>
          Effect.gen(function* () {
            const turnId = TurnId.make(yield* randomUUID);
            const turn: TurnState = {
              turnId,
              assistantItemId: RuntimeItemId.make(`${turnId}-assistant`),
              reasoningItemId: RuntimeItemId.make(`${turnId}-reasoning`),
              assistantStarted: false,
              assistantCompleted: false,
              reasoningStarted: false,
              reasoningCompleted: false,
              reasoningBlockHasDelta: false,
              streamedText: "",
              interrupted: false,
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
            const resumeReady = yield* Deferred.make<string, ProviderAdapterProcessError>();
            ctx.activeFiber = yield* runTurn(
              ctx,
              turn,
              prompt,
              model,
              reasoningEffort,
              input.interactionMode ?? "default",
              resumeReady,
            ).pipe(Effect.forkIn(ctx.scope));
            const sessionId = yield* Deferred.await(resumeReady).pipe(
              Effect.timeoutOption(startupTimeoutMs),
              Effect.flatMap((option) =>
                option._tag === "Some"
                  ? Effect.succeed(option.value)
                  : Effect.fail(
                      new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        detail:
                          "Command Code did not report a session id before startup timed out.",
                      }),
                    ),
              ),
              Effect.tapError(() =>
                ctx.activeChild
                  ? terminateChild(ctx.activeChild, "SIGTERM").pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: {
                schemaVersion: RESUME_VERSION,
                sessionId,
                totalProcessedTokens: ctx.totalProcessedTokens,
              },
            };
          }),
        ({ ctx }) =>
          Effect.sync(() => {
            ctx.turnStarting = false;
          }),
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
