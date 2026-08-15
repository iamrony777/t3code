export const COMMAND_CODE_COMPACT_TOOL_NAME = "compact_conversation";

export const COMMAND_CODE_COMPACT_BOUNDARY = "<!-- T3_COMPACT_BOUNDARY -->";

export const COMMAND_CODE_COMPACT_MOD_SOURCE = `
import type { ModApi } from "@commandcode/harness";

const BOUNDARY = "${COMMAND_CODE_COMPACT_BOUNDARY}";

export default function (cmd: ModApi) {
  let compactRequested = false;

  cmd.hooks({
    // Native compaction only persists a 'compaction' tree entry when the
    // summary path succeeds. When the CLI falls back to tool-call trimming,
    // it still reports tokens saved but writes no durable entry, so the next
    // headless process resumes the full transcript. Append a durable marker
    // on the next round and prune everything before it from every future
    // model request, regardless of whether the native compaction persisted.
    onTurnStart: async ({ state }, ctx) => {
      if (!compactRequested) return state;
      compactRequested = false;
      try {
        await ctx.session.appendCustomMessageEntry({
          customType: "t3-compact-boundary",
          content: [{ type: "text", text: BOUNDARY }],
          display: false,
        });
      } catch {
        // A --no-session or bare unit-test harness has no durable store.
      }
      return state;
    },
    transformContext: async ({ messages }) => {
      let lastBoundary = -1;
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (
          message?.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block?.type === "text" && block.text === BOUNDARY,
          )
        ) {
          lastBoundary = index;
        }
      }
      if (lastBoundary === -1) return messages;
      const next = messages.slice(lastBoundary + 1);
      return next.length === messages.length ? messages : next;
    },
  });

  cmd.addTool({
    schema: {
      name: "${COMMAND_CODE_COMPACT_TOOL_NAME}",
      description: "Compact the current conversation history to free context.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    readOnly: true,
    run: async () => {
      try {
        await cmd.sessions.compact();
        compactRequested = true;
        return { ok: true, content: [{ type: "text", text: "Compaction completed." }] };
      } catch (error) {
        return { ok: false, error: \`Compaction failed: \${String(error)}\` };
      }
    },
  });
}
`;

export const COMMAND_CODE_COMPACT_PROMPT =
  "Use the `compact_conversation` tool to compact the conversation history now, then report the result.";

export function rewriteCommandCodeCompactPrompt(input: string): string {
  const trimmed = input.trim();
  return trimmed.toLowerCase() === "/compact" ? COMMAND_CODE_COMPACT_PROMPT : trimmed;
}
