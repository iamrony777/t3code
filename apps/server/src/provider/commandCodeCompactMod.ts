export const COMMAND_CODE_COMPACT_TOOL_NAME = "compact_conversation";

export const COMMAND_CODE_COMPACT_MOD_SOURCE = `
import type { ModApi } from "@commandcode/harness";

export default function (cmd: ModApi) {
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
