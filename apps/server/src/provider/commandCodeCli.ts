import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { parseCliArgs, tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const DEFAULT_MAX_TURNS = "250";

const CommandCodeStatusWire = Schema.Struct({
  authenticated: Schema.Boolean,
  version: Schema.String,
  user: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Number),
});

export interface CommandCodeStatus {
  readonly authenticated: boolean;
  readonly version: string;
  readonly user?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly contextWindow?: number | undefined;
}

export interface CommandCodeModel {
  readonly slug: string;
  readonly name: string;
  readonly subProvider: string;
  readonly isDefault?: boolean | undefined;
}

export type CommandCodeOutputFrame =
  | {
      readonly type: "event";
      readonly event: Readonly<Record<string, unknown>> & { readonly type: string };
    }
  | {
      readonly type: "result";
      readonly subtype: "success" | "error" | "max_turns";
      readonly usage: unknown;
      readonly durationMs: number;
      readonly finalText: string;
      readonly sessionId?: string | undefined;
      readonly stopReason?: string | undefined;
      readonly error?: unknown;
    };

const decodeStatus = Schema.decodeUnknownExit(Schema.fromJsonString(CommandCodeStatusWire));
const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export function parseCommandCodeStatus(output: string): CommandCodeStatus | undefined {
  const decoded = decodeStatus(output.trim());
  if (Exit.isFailure(decoded)) return undefined;
  return {
    authenticated: decoded.value.authenticated,
    version: decoded.value.version,
    ...(decoded.value.user ? { user: decoded.value.user } : {}),
    ...(decoded.value.provider ? { provider: decoded.value.provider } : {}),
    ...(decoded.value.model ? { model: decoded.value.model } : {}),
    ...(decoded.value.context_window !== undefined
      ? { contextWindow: decoded.value.context_window }
      : {}),
  };
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const MODEL_LINE = /^\s*(\S+)\s{2,}(.+?)\s*$/;

export function parseCommandCodeModels(output: string): ReadonlyArray<CommandCodeModel> {
  const models: CommandCodeModel[] = [];
  const seen = new Set<string>();
  let group: string | undefined;

  for (const rawLine of output.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^(?:Available models|Use\s|Pass\s|Docs:|cmd\s)/i.test(line.trimStart())) continue;
    const match = line.match(MODEL_LINE);
    if (match && group) {
      const slug = match[1]!;
      if (seen.has(slug)) continue;
      seen.add(slug);
      const defaultModel = /\s*\(default\)\s*$/.test(match[2]!);
      models.push({
        slug,
        name: slug,
        subProvider: group,
        ...(defaultModel ? { isDefault: true } : {}),
      });
      continue;
    }
    if (!/^\s/.test(line)) {
      group = line.trim().replace(/:$/, "");
    }
  }

  return models;
}

/**
 * Tools Command Code withholds from every headless run (`HEADLESS_EXCLUDED_TOOLS`,
 * CLI 1.19.1) that a t3 session still needs, keyed by the CLI's opt-in env var.
 *
 * The `--tools-enable` flag would be the documented route, but the root command
 * takes a positional prompt, so an unknown flag plus its value becomes excess
 * arguments on CLIs that predate it. Env vars are simply ignored there.
 *
 * `ask_user_question` stays withheld on purpose: the adapter has no user-input
 * channel, so a question would strand the turn.
 */
export function commandCodeToolEnableEnv(
  interactionMode: ProviderInteractionMode,
): Readonly<Record<string, string>> {
  return {
    // Todo rows are a first-class part of the thread view.
    CMD_TOOLS_TODO_WRITE_ENABLE: "1",
    // Plan mode is pointless without the tools that end a plan.
    ...(interactionMode === "plan"
      ? { CMD_TOOLS_EXIT_PLAN_MODE_ENABLE: "1", CMD_TOOLS_PLAN_REVIEW_ENABLE: "1" }
      : {}),
  };
}

export function buildCommandCodeTurnArgs(input: {
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly resumeSessionId?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly attachmentsDir?: string | undefined;
  readonly enableImageVision?: boolean | undefined;
  readonly launchArgs?: string | undefined;
}): ReadonlyArray<string> {
  const launchArgv = tokenizeCliArgs(input.launchArgs);
  // Vision is opt-in and headless has no consent prompt, so an undecided
  // setting reads as "off" and the model silently cannot see the image. Only
  // turns that actually carry an attachment flip it, and an explicit
  // `--config image-vision=…` in launch args always wins.
  const imageVisionArgs =
    input.enableImageVision && !launchArgv.some((arg) => arg.startsWith("image-vision"))
      ? ["--config", "image-vision=enabled"]
      : [];

  const args = [
    "-p",
    "--output-format",
    "json",
    "--skip-onboarding",
    "--no-auto-update",
    "--model",
    input.model,
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(input.reasoningEffort && input.reasoningEffort !== "default"
      ? ["--effort", input.reasoningEffort]
      : []),
    // Attached images live outside the workspace; without this the CLI cannot
    // read the paths ProviderService appends to the prompt.
    ...(input.attachmentsDir ? ["--add-dir", input.attachmentsDir] : []),
  ];

  const modeArgs =
    input.interactionMode === "plan"
      ? ["--plan"]
      : input.runtimeMode === "full-access"
        ? ["--yolo"]
        : input.runtimeMode === "auto" || input.runtimeMode === "auto-accept-edits"
          ? ["--auto-accept"]
          : ["--permission-mode", "dont-ask"];

  const hasMaxTurns = "max-turns" in parseCliArgs(launchArgv).flags;

  return [
    ...args,
    ...imageVisionArgs,
    ...modeArgs,
    ...(hasMaxTurns ? [] : ["--max-turns", DEFAULT_MAX_TURNS]),
    ...launchArgv,
  ];
}

export function parseCommandCodeNdjsonLine(line: string): CommandCodeOutputFrame | undefined {
  const decoded = decodeJson(line.trim());
  if (Exit.isFailure(decoded) || !Predicate.isObject(decoded.value)) return undefined;
  const frame = decoded.value;

  if (frame.type === "event" && Predicate.isObject(frame.event)) {
    if (typeof frame.event.type !== "string" || frame.event.type.trim().length === 0) {
      return undefined;
    }
    return {
      type: "event",
      event: frame.event as Readonly<Record<string, unknown>> & { readonly type: string },
    };
  }

  if (
    frame.type === "result" &&
    (frame.subtype === "success" || frame.subtype === "error" || frame.subtype === "max_turns") &&
    typeof frame.durationMs === "number" &&
    typeof frame.finalText === "string" &&
    "usage" in frame
  ) {
    return {
      type: "result",
      subtype: frame.subtype,
      usage: frame.usage,
      durationMs: frame.durationMs,
      finalText: frame.finalText,
      ...(typeof frame.sessionId === "string" ? { sessionId: frame.sessionId } : {}),
      ...(typeof frame.stopReason === "string" ? { stopReason: frame.stopReason } : {}),
      ...(frame.error !== undefined ? { error: frame.error } : {}),
    };
  }

  return undefined;
}
