/**
 * Memory sources settings section: the list of files other harnesses keep
 * memory in. Paths are machine-local, so this is a server setting, not a
 * shared one — each environment keeps its own list.
 */
import { useState } from "react";

import type { MemorySourceScope } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

import { applyMemorySourceListEdit, hasMemorySourcePath } from "./memorySources.logic.ts";

export function MemorySourcesSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const sources = settings?.memorySources ?? [];
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [scope, setScope] = useState<MemorySourceScope>("global");
  const [pending, setPending] = useState(false);

  const save = (next: typeof sources) => {
    setPending(true);
    void updateSettings({ memorySources: next }).finally(() => setPending(false));
  };

  const add = () => {
    const trimmedLabel = label.trim();
    const trimmedPath = path.trim();
    if (!trimmedLabel || !trimmedPath) return;
    if (hasMemorySourcePath(sources, trimmedPath)) {
      save(
        applyMemorySourceListEdit(sources, {
          kind: "update",
          entry: { label: trimmedLabel, path: trimmedPath, scope, enabled: true },
        }),
      );
    } else {
      save(
        applyMemorySourceListEdit(sources, {
          kind: "add",
          entry: { label: trimmedLabel, path: trimmedPath, scope, enabled: true },
        }),
      );
    }
    setLabel("");
    setPath("");
  };

  return (
    <div className="space-y-2">
      {sources.map((source) => (
        <div key={source.path} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm text-foreground">
            {source.label} — {source.path} ({source.scope})
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                save(
                  applyMemorySourceListEdit(sources, {
                    kind: "update",
                    entry: { ...source, enabled: !source.enabled },
                  }),
                )
              }
            >
              {source.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                save(applyMemorySourceListEdit(sources, { kind: "remove", path: source.path }))
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2 pt-1">
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label, e.g. Claude memory"
          aria-label="Memory source label"
        />
        <Input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="Path, e.g. ~/.claude/CLAUDE.md"
          aria-label="Memory source path"
        />
        <Select
          value={scope}
          onValueChange={(value) => {
            if (value === "global" || value === "project") {
              setScope(value);
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-28" aria-label="Memory source scope">
            <SelectValue>{scope}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="global">
              Global
            </SelectItem>
            <SelectItem hideIndicator value="project">
              Project
            </SelectItem>
          </SelectPopup>
        </Select>
        <Button type="button" disabled={pending} onClick={add}>
          Add source
        </Button>
      </div>
    </div>
  );
}
