import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandCodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialCommandCodeProviderSnapshot,
  checkCommandCodeProviderStatus,
} from "./CommandCodeProvider.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);

describe("buildInitialCommandCodeProviderSnapshot", () => {
  it.effect("advertises the enabled Early Access provider while checking", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCommandCodeProviderSnapshot(decodeSettings({}));
      expect(snapshot.displayName).toBe("Command Code");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.showInteractionModeToggle).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["deepseek/deepseek-v4-flash"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkCommandCodeProviderStatus", (it) => {
  it.effect("reports authenticated status and discovered models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-provider-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'case " $* " in',
            '  *" status "*) printf \'%s\\n\' \'{"authenticated":true,"version":"1.15.1","user":"rony","provider":"command-code","model":"deepseek/deepseek-v4-flash","context_window":1000000}\' ;;',
            "  *\" --list-models \"*) printf '%s\\n' 'Open Source' 'deepseek/deepseek-v4-flash  DeepSeek V4 Flash (default)' 'Anthropic' 'claude-sonnet-4-6  Claude Sonnet 4.6' ;;",
            "esac",
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const snapshot = yield* checkCommandCodeProviderStatus(
          decodeSettings({ binaryPath, customModels: ["custom/model"] }),
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("1.15.1");
        expect(snapshot.auth).toEqual({ status: "authenticated", label: "rony" });
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "deepseek/deepseek-v4-flash",
          "claude-sonnet-4-6",
          "custom/model",
        ]);
        expect(snapshot.models[0]?.isDefault).toBe(true);
      }),
    ),
  );

  it.effect("reports an unauthenticated installation without listing models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-auth-" });
        const binaryPath = path.join(dir, "command-code");
        yield* fs.writeFileString(
          binaryPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' \'{"authenticated":false,"version":"1.15.1","provider":"command-code"}\'',
          ].join("\n"),
        );
        yield* fs.chmod(binaryPath, 0o755);

        const snapshot = yield* checkCommandCodeProviderStatus(decodeSettings({ binaryPath }));
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("command-code login");
      }),
    ),
  );

  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCommandCodeProviderStatus(
        decodeSettings({ binaryPath: "/definitely/not/installed/command-code" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );
});
