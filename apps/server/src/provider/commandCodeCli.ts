import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

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

export function buildCommandCodeTurnArgs(input: {
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly resumeSessionId?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): ReadonlyArray<string> {
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
  ];

  if (input.interactionMode === "plan") return [...args, "--plan"];
  if (input.runtimeMode === "full-access") return [...args, "--yolo"];
  if (input.runtimeMode === "auto" || input.runtimeMode === "auto-accept-edits") {
    return [...args, "--auto-accept"];
  }
  return [...args, "--permission-mode", "dont-ask"];
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
