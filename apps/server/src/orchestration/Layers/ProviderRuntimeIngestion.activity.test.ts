import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities reasoning", () => {
  it("maps reasoning item lifecycle to thinking activities", () => {
    const started = {
      ...base,
      type: "item.started",
      eventId: EventId.make("evt-reasoning-start"),
      itemId: RuntimeItemId.make("turn-1-reasoning"),
      payload: { itemType: "reasoning", status: "inProgress" },
    } satisfies ProviderRuntimeEvent;
    const completed = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-reasoning-complete"),
      itemId: RuntimeItemId.make("turn-1-reasoning"),
      payload: { itemType: "reasoning", status: "completed" },
    } satisfies ProviderRuntimeEvent;

    const startedActivities = runtimeEventToActivities(started);
    const completedActivities = runtimeEventToActivities(completed);

    expect(startedActivities).toHaveLength(1);
    expect(startedActivities[0]?.kind).toBe("reasoning.started");
    expect(startedActivities[0]?.tone).toBe("info");
    expect((startedActivities[0]?.payload as Record<string, unknown>).itemId).toBe(
      "turn-1-reasoning",
    );

    expect(completedActivities).toHaveLength(1);
    expect(completedActivities[0]?.kind).toBe("reasoning.completed");
  });

  it("keeps tool item lifecycle unchanged", () => {
    const event = {
      ...base,
      type: "item.started",
      eventId: EventId.make("evt-tool-start"),
      itemId: RuntimeItemId.make("tool-1"),
      payload: { itemType: "dynamic_tool_call", status: "inProgress", title: "run_command" },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("tool.started");
  });
});
