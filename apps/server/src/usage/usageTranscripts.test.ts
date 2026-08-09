import { describe, expect, it } from "@effect/vitest";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseCommandCodeLine,
  totalTokens,
} from "./usageTranscripts.ts";

/** Shaped after a real Claude Code assistant record. */
function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // T3 Code writes one record per content block, each repeating the parent
    // message's full usage. Summing them would overcount ~2.4x on real data.
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
  });
});

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fbbc1-b12c-7360-a685-28c181f0025f");
    // Codex reports input_tokens inclusive of the cached portion.
    expect(record?.totals.uncachedInputTokens).toBe(19239 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(116);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("drops usage that arrives before any model is known", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
  });

  it("does not let a pre-model event poison the duplicate signature", () => {
    // A token_count before its turn_context is dropped; the identical event
    // re-emitted once the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
  });
});

describe("totalTokens", () => {
  it("does not add reasoning on top of output", () => {
    expect(
      totalTokens({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 25,
      }),
    ).toBe(100);
  });
});

describe("parseCommandCodeLine", () => {
  /** Shaped after a real Command Code assistant record. */
  function commandCodeLine(overrides: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    model?: string;
  }): string {
    return JSON.stringify({
      type: "message",
      id: "18aec1cf",
      timestamp: "2026-08-09T18:13:04.506Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      usage: {
        inputTokens: overrides.inputTokens ?? 47068,
        outputTokens: overrides.outputTokens ?? 164,
        cacheReadTokens: overrides.cacheReadTokens ?? 8832,
        cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
        costUsd: overrides.costUsd ?? 0.0066601696,
      },
      model: overrides.model ?? "deepseek/deepseek-v4-flash",
    });
  }

  it("extracts tokens and reports the per-message cost", () => {
    const record = parseCommandCodeLine(commandCodeLine({}), "session-1");

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("commandcode");
    expect(record?.model).toBe("deepseek/deepseek-v4-flash");
    expect(record?.sessionId).toBe("session-1");
    expect(record?.reportedCostUsd).toBeCloseTo(0.0066601696, 10);
    expect(record?.dedupeKey).toBeNull();
    // inputTokens is cumulative and includes the cached portion.
    expect(record?.totals).toEqual({
      uncachedInputTokens: 47068 - 8832,
      cachedInputTokens: 8832,
      cacheCreationTokens: 0,
      outputTokens: 164,
      reasoningTokens: 0,
    });
  });

  it("clamps uncached input at zero when cache read exceeds input", () => {
    const record = parseCommandCodeLine(
      commandCodeLine({ inputTokens: 100, cacheReadTokens: 250 }),
      "s",
    );
    expect(record?.totals.uncachedInputTokens).toBe(0);
  });

  it("ignores records without usage or a model", () => {
    expect(
      parseCommandCodeLine(
        JSON.stringify({ type: "message", timestamp: "2026-08-09T00:00:00Z" }),
        "s",
      ),
    ).toBeNull();
    expect(
      parseCommandCodeLine(
        JSON.stringify({ type: "session", timestamp: "2026-08-09T00:00:00Z" }),
        "s",
      ),
    ).toBeNull();
    expect(parseCommandCodeLine("not json", "s")).toBeNull();
  });

  it("is gated by mightCarryUsage", () => {
    expect(mightCarryUsage(commandCodeLine({}), "commandcode")).toBe(true);
    expect(mightCarryUsage('{"type":"message","model":"x"}', "commandcode")).toBe(false);
    // Claude and Command Code both carry a "usage" key; the model gate keeps
    // them from cross-parsing each other's transcripts.
    expect(mightCarryUsage(commandCodeLine({}), "claude")).toBe(true);
  });
});
