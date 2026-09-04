/**
 * Detected Claude auto-memory folder contract — the read-only preview RPC
 * (`server.getDetectedMemoryFolders`).
 *
 * Memory folders are machine-local disk state that lives under each Claude
 * config dir (`<configDir>/projects/<encoded root>/memory`), so the client
 * cannot compute them: it asks the environment's server to stat them for a
 * given project root. They are deliberately *not* part of
 * {@link ServerSettings} — nothing about them is configured or shared, and
 * they change when the user creates or deletes folders inside Claude, outside
 * T3 Code.
 *
 * @module memory
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One Claude auto-memory folder that exists on the environment's disk for a
 * project root right now.
 */
export const DetectedMemoryFolder = Schema.Struct({
  /** Absolute path of the detected `<configDir>/projects/.../memory` folder. */
  path: TrimmedNonEmptyString,
  /** The Claude instance's display name, falling back to its config dir label. */
  label: TrimmedNonEmptyString,
});
export type DetectedMemoryFolder = typeof DetectedMemoryFolder.Type;

/** Request: the workspace root whose Claude memory folders to preview. */
export const DetectedMemoryFoldersInput = Schema.Struct({
  projectRoot: TrimmedNonEmptyString,
});
export type DetectedMemoryFoldersInput = typeof DetectedMemoryFoldersInput.Type;

/**
 * Response: every detected folder for the root. Empty when none exist — the
 * preview never fails, so an unreadable environment also answers empty.
 */
export const DetectedMemoryFolders = Schema.Array(DetectedMemoryFolder);
export type DetectedMemoryFolders = typeof DetectedMemoryFolders.Type;
