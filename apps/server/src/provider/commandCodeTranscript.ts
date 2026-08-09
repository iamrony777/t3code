import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const COMMAND_CODE_TRANSCRIPT_MAX_TAIL_BYTES = 1024 * 1024;
const COMMAND_CODE_TRANSCRIPT_MAX_PROJECT_DIRECTORIES = 512;
const NativeSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));
const NativeModel = Schema.Trim.check(Schema.isNonEmpty());
const NativeTokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CommandCodeUsageMessageWire = Schema.Struct({
  type: Schema.Literal("message"),
  model: NativeModel,
  usage: Schema.Struct({
    inputTokens: NativeTokenCount,
    outputTokens: NativeTokenCount,
    cacheReadTokens: NativeTokenCount,
    cacheWriteTokens: NativeTokenCount,
  }),
});
const decodeUsageMessage = Schema.decodeUnknownExit(
  Schema.fromJsonString(CommandCodeUsageMessageWire),
);
const decodeSessionId = Schema.decodeUnknownExit(NativeSessionId);

export interface CommandCodeTranscriptUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface CommandCodeTranscriptReader {
  readonly readLatestUsage: (input: {
    readonly cwd: string;
    readonly sessionId: string;
  }) => Effect.Effect<CommandCodeTranscriptUsage | undefined>;
}

/**
 * Command Code uses `@sindresorhus/slugify(cwd) || "root"` for this directory.
 * This reproduces that package's default behavior for ordinary ASCII filesystem
 * paths; other paths use the bounded native-directory fallback.
 */
export function commandCodeProjectSlugCandidate(cwd: string): string | undefined {
  if (!/^[A-Za-z0-9/\\ ._:-]*$/.test(cwd)) return undefined;
  const decamelized = cwd
    .replace(/([A-Z]{2,})(\d+)/g, "$1 $2")
    .replace(/([a-z\d]+)([A-Z]{2,})/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-rt-z\d]+)/g, "$1 $2");
  const slug = decamelized
    .toLowerCase()
    .replace(/[^a-z\d]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "root";
}

export function parseCommandCodeTranscriptTail(
  bytes: Uint8Array,
  startsAtFileBeginning: boolean,
): CommandCodeTranscriptUsage | undefined {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  // A trailing empty segment or a non-newline-terminated partial record is not JSONL.
  lines.pop();
  if (!startsAtFileBeginning) {
    // A bounded tail usually begins in the middle of a JSONL record.
    lines.shift();
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const decoded = decodeUsageMessage(line);
    if (Exit.isFailure(decoded)) continue;
    return {
      model: decoded.value.model,
      inputTokens: decoded.value.usage.inputTokens,
      outputTokens: decoded.value.usage.outputTokens,
      cacheReadTokens: decoded.value.usage.cacheReadTokens,
      cacheWriteTokens: decoded.value.usage.cacheWriteTokens,
    };
  }
  return undefined;
}

export const makeCommandCodeTranscriptReader = Effect.fn("makeCommandCodeTranscriptReader")(
  function* (
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<CommandCodeTranscriptReader, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = environment.HOME?.trim() || environment.USERPROFILE?.trim();
    const projectsRoot = home ? path.join(home, ".commandcode", "projects") : undefined;
    const resolvedPaths = new Map<string, string>();

    const existingFile = (filePath: string) =>
      fs.stat(filePath).pipe(
        Effect.map((info) => (info.type === "File" ? filePath : undefined)),
        Effect.orElseSucceed(() => undefined),
      );

    const resolveTranscriptPath = Effect.fn("CommandCodeTranscript.resolveTranscriptPath")(
      function* (cwd: string, sessionId: string) {
        const cached = resolvedPaths.get(sessionId);
        if (cached !== undefined) return cached;
        if (projectsRoot === undefined || Exit.isFailure(decodeSessionId(sessionId))) {
          return undefined;
        }

        const slug = commandCodeProjectSlugCandidate(cwd);
        if (slug !== undefined) {
          const deterministic = yield* existingFile(
            path.join(projectsRoot, slug, `${sessionId}.jsonl`),
          );
          if (deterministic !== undefined) {
            resolvedPaths.set(sessionId, deterministic);
            return deterministic;
          }
        }

        const projectDirectories = yield* fs
          .readDirectory(projectsRoot)
          .pipe(Effect.orElseSucceed(() => [] as Array<string>));
        for (const directory of projectDirectories
          .filter((entry) => entry !== "." && entry !== ".." && path.basename(entry) === entry)
          .sort()
          .slice(0, COMMAND_CODE_TRANSCRIPT_MAX_PROJECT_DIRECTORIES)) {
          const fallback = yield* existingFile(
            path.join(projectsRoot, directory, `${sessionId}.jsonl`),
          );
          if (fallback !== undefined) {
            resolvedPaths.set(sessionId, fallback);
            return fallback;
          }
        }
        return undefined;
      },
    );

    const readTail = (filePath: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filePath, { flag: "r" });
          const info = yield* file.stat;
          if (info.type !== "File") return undefined;
          const maxBytes = BigInt(COMMAND_CODE_TRANSCRIPT_MAX_TAIL_BYTES);
          const bytesToRead = info.size > maxBytes ? maxBytes : info.size;
          const offset = info.size - bytesToRead;
          yield* file.seek(offset, "start");
          const bytes = Option.getOrUndefined(yield* file.readAlloc(bytesToRead));
          return bytes === undefined
            ? undefined
            : parseCommandCodeTranscriptTail(bytes, offset === 0n);
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));

    return {
      readLatestUsage: Effect.fn("CommandCodeTranscript.readLatestUsage")(function* (input) {
        const transcriptPath = yield* resolveTranscriptPath(input.cwd, input.sessionId);
        if (transcriptPath === undefined) return undefined;
        return yield* readTail(transcriptPath);
      }),
    };
  },
);
