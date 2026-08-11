import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/**
 * Name of the MCP server entry t3code manages inside Command Code's config.
 * Stable so a stale entry from a crashed run can always be swept.
 */
export const T3_MCP_SERVER_NAME = "t3-code";

const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Command Code has no per-run MCP flag: the CLI only reads servers from its
 * config files, so a session is wired up by writing the entry to `local`
 * scope (`~/.commandcode/projects/<slug>/mcp.json`, keyed by cwd) before the
 * first turn spawns, and removing it when the session ends.
 *
 * `add-json` rather than `add` because it takes headers inline and skips the
 * reachability probe `add` fires at the URL.
 */
export function commandCodeMcpAddArgs(input: {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}): ReadonlyArray<string> {
  return [
    "mcp",
    "add-json",
    "--scope",
    "local",
    T3_MCP_SERVER_NAME,
    JSON.stringify({
      type: "http",
      url: input.endpoint,
      // Written literally: Command Code does not expand `${VAR}` placeholders
      // in header values, despite what its MCP docs claim.
      headers: { Authorization: input.authorizationHeader },
    }),
  ];
}

export function commandCodeMcpRemoveArgs(): ReadonlyArray<string> {
  return ["mcp", "remove", "--scope", "local", T3_MCP_SERVER_NAME];
}

/**
 * `mcp add-json` and `mcp remove` are read-modify-write over one file per
 * project directory, so concurrent sessions in the same project would race and
 * could truncate each other's entries.
 */
const projectLocks = new Map<string, Semaphore.Semaphore>();

const projectLock = (cwd: string) =>
  Effect.gen(function* () {
    const existing = projectLocks.get(cwd);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    projectLocks.set(cwd, created);
    return created;
  });

/**
 * Runs one `cmd mcp …` invocation. MCP is an enhancement, never a
 * precondition for a turn, so a failure is logged and swallowed.
 */
export const runCommandCodeMcpCommand = Effect.fn("runCommandCodeMcpCommand")(
  function* (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  }) {
    const lock = yield* projectLock(input.cwd);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, input.args, {
          env: input.environment,
        });
        const child = yield* input.spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: input.cwd,
            env: input.environment,
            shell: spawnCommand.shell,
            stdin: "ignore",
          }),
        );
        const exitCode = yield* child.exitCode;
        if (Number(exitCode) !== 0) {
          yield* Effect.logWarning("Command Code MCP command failed.", {
            args: input.args,
            exitCode,
          });
        }
      }).pipe(Effect.scoped, Effect.timeoutOption(COMMAND_TIMEOUT_MS)),
    );
  },
  Effect.catchCause((cause) => Effect.logWarning("Command Code MCP command errored.", { cause })),
);
