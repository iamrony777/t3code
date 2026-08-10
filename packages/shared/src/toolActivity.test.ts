import { describe, expect, it } from "vite-plus/test";

import {
  deriveToolActivityPresentation,
  titleForToolItemType,
  titleForToolName,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("labels raw CLI tool names instead of surfacing them verbatim", () => {
    expect(titleForToolName("shell_command", "command_execution")).toBe("Command run");
    expect(titleForToolName("write_file", "file_change")).toBe("File change");
    expect(titleForToolName("read_file", "dynamic_tool_call")).toBe("Tool call");
  });

  it("expands mcp__server__tool names into a readable label", () => {
    expect(titleForToolName("mcp__parallel__web_search", "mcp_tool_call")).toBe(
      "parallel · web search",
    );
    expect(titleForToolName("mcp__code_review_graph__query_graph", "mcp_tool_call")).toBe(
      "code_review_graph · query graph",
    );
    expect(titleForToolName("mcp_something", "mcp_tool_call")).toBe(
      titleForToolItemType("mcp_tool_call"),
    );
  });
});
