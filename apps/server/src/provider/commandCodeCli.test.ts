import { describe, expect, it } from "vite-plus/test";

import {
  buildCommandCodeTurnArgs,
  commandCodeToolEnableEnv,
  parseCommandCodeModels,
  parseCommandCodeNdjsonLine,
  parseCommandCodeStatus,
} from "./commandCodeCli.ts";

describe("parseCommandCodeStatus", () => {
  it("decodes the documented authenticated status payload", () => {
    expect(
      parseCommandCodeStatus(
        JSON.stringify({
          authenticated: true,
          version: "1.15.1",
          user: "rony",
          provider: "command-code",
          model: "deepseek/deepseek-v4-flash",
          context_window: 1_000_000,
        }),
      ),
    ).toEqual({
      authenticated: true,
      version: "1.15.1",
      user: "rony",
      provider: "command-code",
      model: "deepseek/deepseek-v4-flash",
      contextWindow: 1_000_000,
    });
  });

  it("returns undefined for malformed or incomplete status output", () => {
    expect(parseCommandCodeStatus("not json")).toBeUndefined();
    expect(parseCommandCodeStatus('{"authenticated":"yes"}')).toBeUndefined();
  });
});

describe("parseCommandCodeModels", () => {
  it("parses grouped model output and ignores presentation text", () => {
    const output = [
      "Available models  ·  4 models",
      "",
      "Open Source",
      "deepseek/deepseek-v4-flash  DeepSeek V4 Flash (default)",
      "moonshotai/kimi-k2.5         Kimi K2.5",
      "",
      "Anthropic",
      "claude-sonnet-4-6            Claude Sonnet 4.6",
      "",
      "OpenAI",
      "gpt-5.6-sol                   frontier model for complex professional work",
      "",
      "Use --model <model> to select a model.",
    ].join("\n");

    expect(parseCommandCodeModels(output)).toEqual([
      {
        slug: "deepseek/deepseek-v4-flash",
        name: "deepseek/deepseek-v4-flash",
        subProvider: "Open Source",
        isDefault: true,
      },
      {
        slug: "moonshotai/kimi-k2.5",
        name: "moonshotai/kimi-k2.5",
        subProvider: "Open Source",
      },
      {
        slug: "claude-sonnet-4-6",
        name: "claude-sonnet-4-6",
        subProvider: "Anthropic",
      },
      {
        slug: "gpt-5.6-sol",
        name: "gpt-5.6-sol",
        subProvider: "OpenAI",
      },
    ]);
  });

  it("strips ANSI codes and deduplicates model slugs", () => {
    expect(
      parseCommandCodeModels(
        "\u001b[1mOpenAI\u001b[0m\n  openai/gpt-5.4  GPT-5.4\n  openai/gpt-5.4  Duplicate\n",
      ),
    ).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "openai/gpt-5.4",
        subProvider: "OpenAI",
      },
    ]);
  });
});

describe("commandCodeToolEnableEnv", () => {
  it("restores todo writing on every headless turn", () => {
    expect(commandCodeToolEnableEnv("default")).toEqual({ CMD_TOOLS_TODO_WRITE_ENABLE: "1" });
  });

  it("restores the plan-exit tools only for plan turns", () => {
    expect(commandCodeToolEnableEnv("plan")).toEqual({
      CMD_TOOLS_TODO_WRITE_ENABLE: "1",
      CMD_TOOLS_EXIT_PLAN_MODE_ENABLE: "1",
      CMD_TOOLS_PLAN_REVIEW_ENABLE: "1",
    });
  });

  it("leaves ask_user_question withheld, since the adapter cannot answer it", () => {
    expect(Object.keys(commandCodeToolEnableEnv("plan"))).not.toContain(
      "CMD_TOOLS_ASK_USER_QUESTION_ENABLE",
    );
  });
});

describe("buildCommandCodeTurnArgs", () => {
  const base = {
    model: "deepseek/deepseek-v4-flash",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };

  it("uses fail-closed headless arguments for approval-required turns", () => {
    expect(buildCommandCodeTurnArgs(base)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--no-auto-update",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--permission-mode",
      "dont-ask",
      "--max-turns",
      "250",
    ]);
  });

  it("uses an explicit resume id and never --continue", () => {
    const args = buildCommandCodeTurnArgs({ ...base, resumeSessionId: "session-123" });
    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
    expect(args).not.toContain("--continue");
  });

  it("enables image vision for attachment turns unless launch args decide it", () => {
    expect(buildCommandCodeTurnArgs({ ...base, enableImageVision: true })).toContain(
      "image-vision=enabled",
    );
    expect(buildCommandCodeTurnArgs(base)).not.toContain("image-vision=enabled");
    expect(
      buildCommandCodeTurnArgs({
        ...base,
        enableImageVision: true,
        launchArgs: "--config image-vision=disabled",
      }),
    ).not.toContain("image-vision=enabled");
  });

  it("grants the attachments dir so images can be read by path", () => {
    const args = buildCommandCodeTurnArgs({ ...base, attachmentsDir: "/data/attachments" });
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual([
      "--add-dir",
      "/data/attachments",
    ]);
  });

  it.each([
    {
      name: "legacy plan",
      input: { ...base, interactionMode: "plan" as const },
      modeArgs: ["--plan"],
    },
    {
      name: "full-access",
      input: { ...base, runtimeMode: "full-access" as const },
      modeArgs: ["--yolo"],
    },
    {
      name: "auto",
      input: { ...base, runtimeMode: "auto" as const },
      modeArgs: ["--auto-accept"],
    },
    {
      name: "auto-accept-edits",
      input: { ...base, runtimeMode: "auto-accept-edits" as const },
      modeArgs: ["--auto-accept"],
    },
    {
      name: "approval-required",
      input: base,
      modeArgs: ["--permission-mode", "dont-ask"],
    },
  ])("maps $name to the exact Command Code mode arguments", ({ input, modeArgs }) => {
    expect(buildCommandCodeTurnArgs(input)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--no-auto-update",
      "--model",
      "deepseek/deepseek-v4-flash",
      ...modeArgs,
      "--max-turns",
      "250",
    ]);
  });

  it("omits missing and default reasoning effort", () => {
    expect(buildCommandCodeTurnArgs(base)).not.toContain("--effort");
    expect(buildCommandCodeTurnArgs({ ...base, reasoningEffort: "default" })).not.toContain(
      "--effort",
    );
  });

  it("emits a non-default reasoning effort exactly once", () => {
    const args = buildCommandCodeTurnArgs({ ...base, reasoningEffort: "max" });
    expect(args.filter((arg) => arg === "--effort")).toHaveLength(1);
    expect(args).toContain("max");
  });

  it("defaults to a 250 turn budget", () => {
    const args = buildCommandCodeTurnArgs(base);
    expect(args.filter((arg) => arg === "--max-turns")).toHaveLength(1);
    expect(args.slice(-2)).toEqual(["--max-turns", "250"]);
  });

  it("appends launch arguments after the default turn budget", () => {
    const args = buildCommandCodeTurnArgs({ ...base, launchArgs: "--chrome" });
    expect(args.slice(-3)).toEqual(["--max-turns", "250", "--chrome"]);
  });

  it("defers to a user-supplied --max-turns instead of the default", () => {
    const args = buildCommandCodeTurnArgs({ ...base, launchArgs: "--max-turns 400" });
    expect(args.filter((arg) => arg === "--max-turns")).toHaveLength(1);
    expect(args.slice(-2)).toEqual(["--max-turns", "400"]);
  });
});

describe("parseCommandCodeNdjsonLine", () => {
  it("decodes event and result frames while preserving unknown events", () => {
    expect(
      parseCommandCodeNdjsonLine('{"type":"event","event":{"type":"future_event","value":42}}'),
    ).toEqual({ type: "event", event: { type: "future_event", value: 42 } });

    expect(
      parseCommandCodeNdjsonLine(
        '{"type":"result","subtype":"success","sessionId":"session-123","stopReason":"end_turn","usage":{"inputTokens":10},"durationMs":42,"finalText":"done"}',
      ),
    ).toEqual({
      type: "result",
      subtype: "success",
      sessionId: "session-123",
      stopReason: "end_turn",
      usage: { inputTokens: 10 },
      durationMs: 42,
      finalText: "done",
    });
  });

  it("returns undefined for malformed or unsupported frames", () => {
    expect(parseCommandCodeNdjsonLine("not json")).toBeUndefined();
    expect(parseCommandCodeNdjsonLine('{"type":"other"}')).toBeUndefined();
  });
});
