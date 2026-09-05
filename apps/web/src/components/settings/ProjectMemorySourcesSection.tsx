/**
 * Memory settings for one project checkout on the Project settings page.
 *
 * Memory is per-project and machine-local, so the whole section is scoped to
 * the selected checkout's environment and absolute workspace root. Two blocks:
 *
 * - Auto-detection: a master toggle plus one Include/Exclude switch per folder
 *   the environment's server currently detects under Claude's config dirs for
 *   this project root. The detected list is a read-only preview read through
 *   the `serverEnvironment.detectedMemoryFolders` query family (WS tag
 *   `serverGetDetectedMemoryFolders`), so it is best-effort: an unavailable or
 *   slow answer renders as "no folders", never an error. The preview is a
 *   point-in-time disk stat; the panel remounts this section per checkout
 *   root, so each root gets its own query.
 * - Manual sources: the `memorySources` entries anchored at this workspace
 *   root, edited through the whole-list replacement helpers.
 */
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import type {
  EnvironmentId,
  MemoryAutoDetectProjectEntry,
  MemorySourceEntry,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

import {
  applyMemorySourceListEdit,
  isDetectedFolderExcluded,
  memoryAutoDetectEntryFor,
  toggleDetectedFolder,
  toggleMemorySourceEnabled,
  upsertManualMemorySource,
} from "./memorySources.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProjectMemorySourcesSection({
  environmentId,
  workspaceRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const detectedPreview = useEnvironmentQuery(
    serverEnvironment.detectedMemoryFolders({
      environmentId,
      input: { projectRoot: workspaceRoot },
    }),
  );

  // Writes replace whole server lists/maps, so two overlapping edits computed
  // from the same snapshot would drop each other's changes. One at a time.
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const runWrite = (patch: {
    readonly memorySources?: ReadonlyArray<MemorySourceEntry>;
    readonly memoryAutoDetect?: Readonly<Record<string, MemoryAutoDetectProjectEntry>>;
  }) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    void updateSettings(patch).finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
  };

  const saveAutoDetectEntry = (next: MemoryAutoDetectProjectEntry) => {
    // Always the fully merged per-key object: decode fills `excluded: []` into
    // a present key and `deepMerge` replaces arrays wholesale, so a partial
    // entry would silently wipe this project's exclusions.
    runWrite({
      memoryAutoDetect: { ...settings.memoryAutoDetect, [workspaceRoot]: next },
    });
  };
  // Edits run over the whole list (not the project-scoped view below) because
  // the patch replaces the list: a filtered list would delete other projects'
  // entries. The (projectRoot, path) keys keep edits on the right rows.
  const saveManualList = (next: ReadonlyArray<MemorySourceEntry>) => {
    runWrite({ memorySources: [...next] });
  };

  const autoDetect = memoryAutoDetectEntryFor(settings.memoryAutoDetect, workspaceRoot);
  const manualSources = settings.memorySources.filter(
    (source) => source.projectRoot === workspaceRoot,
  );
  // The preview must never block the page: empty or unanswered means "none".
  const detectedFolders = detectedPreview.data ?? [];

  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const addManualSource = () => {
    const trimmedLabel = label.trim();
    const trimmedPath = path.trim();
    if (!trimmedLabel || !trimmedPath) return;
    saveManualList(
      upsertManualMemorySource(settings.memorySources, {
        label: trimmedLabel,
        path: trimmedPath,
        projectRoot: workspaceRoot,
      }),
    );
    setLabel("");
    setPath("");
  };

  return (
    <SettingsSection title="Memory">
      <SettingsRow
        title="Share Claude memory folders automatically"
        description="Claude memory folders under ~/.claude and its configured profiles are detected for this project and shared with its agents automatically when they exist. Turn this off to stop sharing them here."
        control={
          <Switch
            checked={autoDetect.enabled}
            disabled={pending}
            onCheckedChange={(checked) =>
              saveAutoDetectEntry({ ...autoDetect, enabled: Boolean(checked) })
            }
            aria-label="Share Claude memory folders for this project automatically"
          />
        }
      />
      {autoDetect.enabled ? (
        detectedFolders.length > 0 ? (
          detectedFolders.map((folder) => {
            const excluded = isDetectedFolderExcluded(autoDetect, folder.path);
            return (
              <SettingsRow
                key={folder.path}
                title={folder.label}
                description={
                  <code className="block max-w-full truncate font-mono">{folder.path}</code>
                }
                control={
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-muted-foreground">
                      {excluded ? "Excluded" : "Shared"}
                    </span>
                    <Switch
                      checked={!excluded}
                      disabled={pending}
                      onCheckedChange={() =>
                        saveAutoDetectEntry(toggleDetectedFolder(autoDetect, folder.path))
                      }
                      aria-label={`Include ${folder.label} memory folder`}
                    />
                  </div>
                }
              />
            );
          })
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            No Claude memory folders detected for this project yet. Folders under ~/.claude and its
            configured profiles are shared automatically as soon as they exist.
          </p>
        )
      ) : null}

      <div className="flex min-h-8 flex-col items-start gap-3 px-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">Manual sources</h3>
          <p className="text-pretty text-sm text-muted-foreground">
            Extra files or folders to share with this checkout's agents.
          </p>
        </div>
      </div>
      {manualSources.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          No manual sources for this checkout yet.
        </p>
      ) : (
        manualSources.map((source) => (
          <SettingsRow
            key={`${source.projectRoot}:${source.path}`}
            className="group py-2"
            title={source.label}
            description={<code className="block max-w-full truncate font-mono">{source.path}</code>}
            control={
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    saveManualList(
                      toggleMemorySourceEnabled(settings.memorySources, {
                        projectRoot: workspaceRoot,
                        path: source.path,
                      }),
                    )
                  }
                >
                  {source.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground"
                  aria-label={`Remove ${source.label}`}
                  disabled={pending}
                  onClick={() =>
                    saveManualList(
                      applyMemorySourceListEdit(settings.memorySources, {
                        kind: "remove",
                        key: { projectRoot: workspaceRoot, path: source.path },
                      }),
                    )
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </>
            }
          />
        ))
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pt-1 sm:px-4">
        <Input
          className="w-full sm:w-44"
          value={label}
          disabled={pending}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label, e.g. Team memory"
          aria-label="Manual memory source label"
        />
        <Input
          className="min-w-44 flex-1"
          value={path}
          disabled={pending}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/home/you/.claude/CLAUDE.md"
          aria-label="Manual memory source path"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending || label.trim().length === 0 || path.trim().length === 0}
          onClick={addManualSource}
        >
          <PlusIcon className="size-3.5" />
          Add source
        </Button>
      </div>
    </SettingsSection>
  );
}
