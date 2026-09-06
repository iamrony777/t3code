"use strict";

const fs = require("node:fs");

const argsPath = process.env.CLAUDE_PROBE_TEST_ARGS_PATH;
const writesPath = process.env.CLAUDE_PROBE_TEST_WRITES_PATH;
if (argsPath) fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split(/[\r\n]/);
  input = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    if (writesPath) fs.appendFileSync(writesPath, `${line}\n`, { mode: 0o600 });
    if (line === "ping (reply with pong)") {
      process.stdout.write("pong\r\n> ");
    } else if (line === "/usage") {
      process.stdout.write("Plan usage limits\r\nCurrent session\r\n23% used\r\n");
      setImmediate(() => {
        process.stdout.write("Resets in 1 hour\r\nCurrent week (all models)\r\n47% used\r\n");
        setImmediate(() => process.stdout.write("Resets in 6 days\r\n> "));
      });
    }
  }
});

process.stdout.write("Claude Code test harness\r\n> ");
