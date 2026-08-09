import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  COMMAND_CODE_TRANSCRIPT_MAX_TAIL_BYTES,
  commandCodeProjectSlugCandidate,
  makeCommandCodeTranscriptReader,
  parseCommandCodeTranscriptTail,
} from "./commandCodeTranscript.ts";

const encoder = new TextEncoder();
const usageLine = (input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}) =>
  JSON.stringify({
    type: "message",
    id: "message",
    message: {},
    model: input.model,
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    },
  });

it("uses Command Code's native project slug for ordinary paths", () => {
  expect(commandCodeProjectSlugCandidate("/home/rony/Work/t3code")).toBe("home-rony-work-t3code");
  expect(commandCodeProjectSlugCandidate("C:\\Users\\Rony\\My_Project")).toBe(
    "c-users-rony-my-project",
  );
  expect(commandCodeProjectSlugCandidate("/")).toBe("root");
  expect(commandCodeProjectSlugCandidate("/tmp/café")).toBeUndefined();
});

it("returns the newest complete usage-bearing message", () => {
  const older = usageLine({
    model: "model/older",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  });
  const latest = usageLine({
    model: "model/latest",
    inputTokens: 30,
    outputTokens: 5,
    cacheReadTokens: 7,
    cacheWriteTokens: 11,
  });

  expect(
    parseCommandCodeTranscriptTail(
      encoder.encode(`${older}\n{"type":"message","message":{}}\n${latest}\n`),
      true,
    ),
  ).toEqual({
    model: "model/latest",
    inputTokens: 30,
    outputTokens: 5,
    cacheReadTokens: 7,
    cacheWriteTokens: 11,
  });
});

it("ignores malformed records and a partial final line", () => {
  const complete = usageLine({
    model: "model/complete",
    inputTokens: 20,
    outputTokens: 4,
    cacheReadTokens: 6,
    cacheWriteTokens: 8,
  });
  const malformed = usageLine({
    model: "model/malformed",
    inputTokens: -1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  });

  expect(
    parseCommandCodeTranscriptTail(
      encoder.encode(`${complete}\n${malformed}\n{"type":"message","model":"partial"`),
      true,
    ),
  ).toMatchObject({ model: "model/complete" });
});

it.layer(NodeServices.layer)("makeCommandCodeTranscriptReader", (it) => {
  it.effect("tail-reads at most one MiB and returns undefined for missing files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-home-" });
        const cwd = path.join(home, "workspace");
        const slug = commandCodeProjectSlugCandidate(cwd)!;
        const projectDir = path.join(home, ".commandcode", "projects", slug);
        yield* fs.makeDirectory(projectDir, { recursive: true });
        const transcriptPath = path.join(projectDir, "session-bounded.jsonl");
        const tooOld = usageLine({
          model: "model/too-old",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
        });
        yield* fs.writeFileString(
          transcriptPath,
          `${tooOld}\n${"x".repeat(COMMAND_CODE_TRANSCRIPT_MAX_TAIL_BYTES + 32)}\n`,
        );

        const reader = yield* makeCommandCodeTranscriptReader({ HOME: home });
        expect(
          yield* reader.readLatestUsage({ cwd, sessionId: "session-bounded" }),
        ).toBeUndefined();
        expect(
          yield* reader.readLatestUsage({ cwd, sessionId: "session-missing" }),
        ).toBeUndefined();
      }),
    ),
  );

  it.effect("falls back safely and caches the resolved path per session id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* delegate.makeTempDirectoryScoped({ prefix: "t3-command-code-home-" });
        const fallbackDir = path.join(home, ".commandcode", "projects", "native-fallback");
        yield* delegate.makeDirectory(fallbackDir, { recursive: true });
        yield* delegate.writeFileString(
          path.join(fallbackDir, "session-fallback.jsonl"),
          `${usageLine({
            model: "model/fallback",
            inputTokens: 12,
            outputTokens: 3,
            cacheReadTokens: 5,
            cacheWriteTokens: 7,
          })}\n`,
        );
        let directoryReads = 0;
        const countingFileSystem = FileSystem.FileSystem.of({
          ...delegate,
          readDirectory: (directory, options) => {
            directoryReads += 1;
            return delegate.readDirectory(directory, options);
          },
        });

        const reader = yield* makeCommandCodeTranscriptReader({ USERPROFILE: home }).pipe(
          Effect.provideService(FileSystem.FileSystem, countingFileSystem),
        );
        const input = { cwd: "/different/project", sessionId: "session-fallback" };
        expect(yield* reader.readLatestUsage(input)).toMatchObject({ model: "model/fallback" });
        expect(yield* reader.readLatestUsage(input)).toMatchObject({ model: "model/fallback" });
        expect(directoryReads).toBe(1);
        yield* delegate.remove(path.join(fallbackDir, "session-fallback.jsonl"));
        expect(yield* reader.readLatestUsage(input)).toBeUndefined();
        expect(directoryReads).toBe(1);
      }),
    ),
  );
});
