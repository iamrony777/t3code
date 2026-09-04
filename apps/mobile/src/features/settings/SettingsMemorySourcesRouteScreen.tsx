/**
 * Memory sources settings screen. Mirrors the web section: list, add,
 * enable/disable, remove. Paths are machine-local, so this is a server
 * setting, not a shared one — each environment keeps its own list. Mobile has
 * no primary environment, so the first connected environment is the reference
 * and edits patch that environment's settings.
 */
import { useNavigation } from "@react-navigation/native";
import type { MemorySourceScope } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { applyMemorySourceListEdit, hasMemorySourcePath } from "./memorySources.logic";

const SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: MemorySourceScope;
  readonly label: string;
}> = [
  { scope: "global", label: "Global" },
  { scope: "project", label: "Project" },
];

export function SettingsMemorySourcesRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });
  const reference =
    environments.find((environment) => environment.connection.phase === "connected") ?? null;
  const settings = reference?.serverConfig?.settings ?? null;
  const sources = settings?.memorySources ?? [];
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [scope, setScope] = useState<MemorySourceScope>("global");
  const [pending, setPending] = useState(false);
  // Editing needs a connected environment whose settings have loaded;
  // otherwise a save built from the empty fallback could replace the real list.
  const ready = reference !== null && settings !== null;
  const controlsDisabled = pending || !ready;

  const save = (next: typeof sources) => {
    if (reference === null || settings === null) return;
    setPending(true);
    void updateSettings({
      environmentId: reference.environmentId,
      input: { patch: { memorySources: next } },
    }).finally(() => setPending(false));
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
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Memory Sources" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {reference ? (
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Editing memory sources for {reference.label}
          </Text>
        ) : null}
        {!ready ? (
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Connect an environment to manage memory sources.
          </Text>
        ) : null}
        <SettingsSection title="Sources">
          {sources.map((source, index) => (
            <View
              key={source.path}
              className={
                index === 0
                  ? "flex-row items-center gap-3 p-4"
                  : "flex-row items-center gap-3 border-t border-border-subtle p-4"
              }
            >
              <Text className="min-w-0 flex-1 text-base leading-normal text-foreground">
                {source.label} — {source.path} ({source.scope})
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: controlsDisabled }}
                disabled={controlsDisabled}
                onPress={() =>
                  save(
                    applyMemorySourceListEdit(sources, {
                      kind: "update",
                      entry: { ...source, enabled: !source.enabled },
                    }),
                  )
                }
                className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">
                  {source.enabled ? "Disable" : "Enable"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: controlsDisabled }}
                disabled={controlsDisabled}
                onPress={() =>
                  save(applyMemorySourceListEdit(sources, { kind: "remove", path: source.path }))
                }
                className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">Remove</Text>
              </Pressable>
            </View>
          ))}
        </SettingsSection>
        <SettingsSection title="Add source">
          <View className="gap-3 p-4">
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Label, e.g. Claude memory"
              accessibilityLabel="Memory source label"
            />
            <TextInput
              value={path}
              onChangeText={setPath}
              placeholder="Path, e.g. ~/.claude/CLAUDE.md"
              accessibilityLabel="Memory source path"
            />
            <View className="flex-row gap-2">
              {SCOPE_OPTIONS.map((option) => (
                <Pressable
                  key={option.scope}
                  accessibilityRole="radio"
                  accessibilityLabel={`Memory source scope ${option.label}`}
                  accessibilityState={{ checked: scope === option.scope }}
                  onPress={() => setScope(option.scope)}
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-full bg-subtle px-4 py-2 active:opacity-70"
                >
                  <Text className="text-base font-t3-medium text-foreground">{option.label}</Text>
                  {scope === option.scope ? (
                    <SymbolView
                      name="checkmark"
                      size={16}
                      tintColorClassName={"accent-icon"}
                      type="monochrome"
                      weight="semibold"
                    />
                  ) : null}
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: controlsDisabled }}
              disabled={controlsDisabled}
              onPress={add}
              className="rounded-full bg-primary px-4 py-2 active:opacity-70"
            >
              <Text className="text-center text-base font-t3-medium text-primary-foreground">
                Add source
              </Text>
            </Pressable>
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
