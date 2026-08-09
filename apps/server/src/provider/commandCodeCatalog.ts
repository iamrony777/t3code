import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { CommandCodeModel } from "./commandCodeCli.ts";

export const COMMAND_CODE_API_MAX_BODY_BYTES = 1024 * 1024;
export const COMMAND_CODE_API_MAX_MODELS = 500;
export const COMMAND_CODE_API_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
export const COMMAND_CODE_CATALOG_CACHE_SCHEMA_VERSION = 1 as const;
export const COMMAND_CODE_CATALOG_API_FRESHNESS = Duration.hours(24);
export const COMMAND_CODE_API_FETCH_TIMEOUT = Duration.seconds(10);
export const COMMAND_CODE_EFFORT_PROBE_TIMEOUT = Duration.seconds(5);
export const COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES = 64 * 1024;
const COMMAND_CODE_CACHE_MAX_BODY_BYTES = 2 * 1024 * 1024;
const INVALID_EFFORT_PROBE = "__t3_invalid_effort_probe__";

const BoundedNonEmptyString = Schema.Trim.check(Schema.isNonEmpty());
const ContextWindow = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(10_000_000),
);
const CommandCodeApiModelWire = Schema.Struct({
  id: BoundedNonEmptyString,
  name: BoundedNonEmptyString,
  context_length: ContextWindow,
});
const CommandCodeApiDocumentWire = Schema.Struct({
  data: Schema.Array(CommandCodeApiModelWire).check(
    Schema.isLengthBetween(0, COMMAND_CODE_API_MAX_MODELS),
  ),
});
const decodeApiDocument = Schema.decodeUnknownExit(
  Schema.fromJsonString(CommandCodeApiDocumentWire),
);

export interface CommandCodeApiModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
}

export type CommandCodeEffortCapability =
  | { readonly kind: "adjustable"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "fixed" }
  | { readonly kind: "unknown" };

export interface CommandCodeReasoningEffortValidator {
  readonly supportsReasoningEffort: (
    modelSlug: string,
    reasoningEffort: string,
  ) => Effect.Effect<boolean>;
}

export interface CommandCodeCatalogModel extends CommandCodeModel {
  readonly contextWindow?: number | undefined;
  readonly effort: CommandCodeEffortCapability;
}

export interface CommandCodeCatalogIdentity {
  readonly instanceId: string;
  readonly resolvedBinaryPath: string;
  readonly cliVersion: string;
}

export interface CommandCodeEffortProbeInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: "closed";
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface CommandCodeEffortProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandCodeApiFetchInput {
  readonly url: string;
  readonly maxBodyBytes: number;
}

export interface CommandCodeCatalogDependencies<DependencyError = never> {
  readonly providerStatusCacheDir: string;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly readFile: (path: string) => Effect.Effect<string, DependencyError>;
  readonly writeFileAtomically: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, DependencyError>;
  readonly fetchApiDocument: (
    input: CommandCodeApiFetchInput,
  ) => Effect.Effect<string, DependencyError>;
  readonly probeEffort: (
    input: CommandCodeEffortProbeInput,
  ) => Effect.Effect<CommandCodeEffortProbeResult, DependencyError>;
}

export interface CommandCodeCatalogCache {
  readonly schemaVersion: typeof COMMAND_CODE_CATALOG_CACHE_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly resolvedBinaryPath: string;
  readonly cliVersion: string;
  readonly apiFetchedAt: DateTime.Utc;
  readonly apiModels: ReadonlyArray<CommandCodeApiModel>;
  readonly efforts: Readonly<Record<string, CommandCodeEffortCapability>>;
}

interface CommandCodeValidationCatalogState {
  readonly managed: boolean;
  readonly identity?: CommandCodeCatalogIdentity | undefined;
  readonly inventoryKeys: ReadonlyArray<string>;
  readonly catalog: ReadonlyArray<CommandCodeCatalogModel>;
}

const EffortValueWire = Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/));
const AdjustableEffortWire = Schema.Struct({
  kind: Schema.Literal("adjustable"),
  values: Schema.Array(EffortValueWire).check(Schema.isLengthBetween(1, 10), Schema.isUnique()),
});
const EffortCapabilityWire = Schema.Union([
  AdjustableEffortWire,
  Schema.Struct({ kind: Schema.Literal("fixed") }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
const CommandCodeApiModelCacheWire = Schema.Struct({
  id: BoundedNonEmptyString,
  name: BoundedNonEmptyString,
  contextLength: ContextWindow,
});
const EffortCacheEntryWire = Schema.Struct({
  modelKey: BoundedNonEmptyString,
  capability: EffortCapabilityWire,
});
const CommandCodeCatalogCacheWire = Schema.Struct({
  schemaVersion: Schema.Literal(COMMAND_CODE_CATALOG_CACHE_SCHEMA_VERSION),
  instanceId: BoundedNonEmptyString,
  resolvedBinaryPath: BoundedNonEmptyString,
  cliVersion: BoundedNonEmptyString,
  apiFetchedAt: Schema.DateTimeUtcFromString,
  apiModels: Schema.Array(CommandCodeApiModelCacheWire).check(
    Schema.isLengthBetween(0, COMMAND_CODE_API_MAX_MODELS),
  ),
  efforts: Schema.Array(EffortCacheEntryWire).check(
    Schema.isLengthBetween(0, COMMAND_CODE_API_MAX_MODELS),
  ),
});
const decodeCatalogCache = Schema.decodeUnknownExit(
  Schema.fromJsonString(CommandCodeCatalogCacheWire),
);

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function parseCommandCodeApiDocument(
  body: string,
): ReadonlyArray<CommandCodeApiModel> | undefined {
  if (utf8ByteLength(body) > COMMAND_CODE_API_MAX_BODY_BYTES) return undefined;
  const decoded = decodeApiDocument(body);
  if (Exit.isFailure(decoded)) return undefined;
  return decoded.value.data.map((model) => ({
    id: model.id,
    name: model.name,
    contextLength: model.context_length,
  }));
}

export const normalizeCommandCodeModelKey = (value: string): string =>
  value.toLocaleLowerCase("en-US");

function matchingApiModel(
  slug: string,
  apiModels: ReadonlyArray<CommandCodeApiModel>,
): CommandCodeApiModel | undefined {
  const normalizedSlug = normalizeCommandCodeModelKey(slug);
  const exact = apiModels.find(
    (model) => normalizeCommandCodeModelKey(model.id) === normalizedSlug,
  );
  if (exact) return exact;

  const dated = apiModels.filter((model) => {
    const normalizedId = normalizeCommandCodeModelKey(model.id);
    return (
      normalizedId.startsWith(normalizedSlug) &&
      /^[-_.]\d{8}$/.test(normalizedId.slice(normalizedSlug.length))
    );
  });
  return dated.length === 1 ? dated[0] : undefined;
}

export function buildCommandCodeCatalog(
  cliModels: ReadonlyArray<CommandCodeModel>,
  apiModels: ReadonlyArray<CommandCodeApiModel>,
  efforts: Readonly<Record<string, CommandCodeEffortCapability>>,
): ReadonlyArray<CommandCodeCatalogModel> {
  return cliModels.map((cliModel) => {
    const apiModel = matchingApiModel(cliModel.slug, apiModels);
    const effortKey = normalizeCommandCodeModelKey(cliModel.slug);
    return {
      slug: cliModel.slug,
      name: apiModel?.name ?? cliModel.name,
      subProvider: cliModel.subProvider,
      ...(cliModel.isDefault !== undefined ? { isDefault: cliModel.isDefault } : {}),
      ...(apiModel ? { contextWindow: apiModel.contextLength } : {}),
      effort: Object.hasOwn(efforts, effortKey) ? efforts[effortKey]! : { kind: "unknown" },
    };
  });
}

export function parseCommandCodeEffortOutput(output: string): CommandCodeEffortCapability {
  const line = output.trim();
  const fixedModelName = line.match(/^([^\r\n]{1,200}) has no adjustable reasoning effort\.$/)?.[1];
  if (fixedModelName !== undefined && fixedModelName.trim().length > 0) {
    return { kind: "fixed" };
  }

  const supported = line.match(
    /^Unknown effort "__t3_invalid_effort_probe__"\. Supported: ([a-z0-9_-]{1,32}(?:, [a-z0-9_-]{1,32}){0,9})\.$/,
  )?.[1];
  if (supported === undefined) return { kind: "unknown" };

  const values = Array.from(new Set(supported.split(", ")));
  if (values.length === 0 || values.length > 10) {
    return { kind: "unknown" };
  }
  return { kind: "adjustable", values };
}

const makeEffortRecord = (
  source: Readonly<Record<string, CommandCodeEffortCapability>> = {},
): Record<string, CommandCodeEffortCapability> => {
  const record = Object.create(null) as Record<string, CommandCodeEffortCapability>;
  for (const [key, capability] of Object.entries(source)) {
    record[normalizeCommandCodeModelKey(key)] = capability;
  }
  return record;
};

export function commandCodeCatalogCachePath(
  providerStatusCacheDir: string,
  instanceId: string,
  joinPath: (...parts: ReadonlyArray<string>) => string,
): string {
  return joinPath(providerStatusCacheDir, `${instanceId}.commandcode-catalog.json`);
}

function parseCommandCodeCatalogCache(
  body: string,
  identity: CommandCodeCatalogIdentity,
): CommandCodeCatalogCache | undefined {
  if (utf8ByteLength(body) > COMMAND_CODE_CACHE_MAX_BODY_BYTES) return undefined;
  const decoded = decodeCatalogCache(body);
  if (Exit.isFailure(decoded)) return undefined;
  const cache = decoded.value;
  if (
    cache.instanceId !== identity.instanceId ||
    cache.resolvedBinaryPath !== identity.resolvedBinaryPath ||
    cache.cliVersion !== identity.cliVersion
  ) {
    return undefined;
  }

  const efforts = makeEffortRecord();
  for (const entry of cache.efforts) {
    efforts[normalizeCommandCodeModelKey(entry.modelKey)] = entry.capability;
  }
  return { ...cache, efforts };
}

const cacheMatchesIdentity = (
  cache: CommandCodeCatalogCache,
  identity: CommandCodeCatalogIdentity,
): boolean =>
  cache.instanceId === identity.instanceId &&
  cache.resolvedBinaryPath === identity.resolvedBinaryPath &&
  cache.cliVersion === identity.cliVersion;

function cacheJson(cache: CommandCodeCatalogCache): string {
  return `${JSON.stringify({
    schemaVersion: cache.schemaVersion,
    instanceId: cache.instanceId,
    resolvedBinaryPath: cache.resolvedBinaryPath,
    cliVersion: cache.cliVersion,
    apiFetchedAt: DateTime.formatIso(cache.apiFetchedAt),
    apiModels: cache.apiModels,
    efforts: Object.entries(cache.efforts).map(([modelKey, capability]) => ({
      modelKey,
      capability,
    })),
  })}\n`;
}

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  const encoded = textEncoder.encode(value);
  return encoded.byteLength <= maximumBytes
    ? value
    : textDecoder.decode(encoded.slice(0, maximumBytes));
};

const isApiCacheFresh = (cache: CommandCodeCatalogCache, now: DateTime.Utc): boolean => {
  const age = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(cache.apiFetchedAt);
  return age >= 0 && age < Duration.toMillis(COMMAND_CODE_CATALOG_API_FRESHNESS);
};

const catalogIdentityMatches = (
  left: CommandCodeCatalogIdentity | undefined,
  right: CommandCodeCatalogIdentity,
): boolean =>
  left?.instanceId === right.instanceId &&
  left.resolvedBinaryPath === right.resolvedBinaryPath &&
  left.cliVersion === right.cliVersion;

const commandCodeInventoryKeys = (
  cliModels: ReadonlyArray<CommandCodeModel>,
): ReadonlyArray<string> =>
  Array.from(new Set(cliModels.map((model) => normalizeCommandCodeModelKey(model.slug)))).sort();

const inventoryMatches = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index]);

const retainCatalogCapabilities = (
  cliModels: ReadonlyArray<CommandCodeModel>,
  catalog: ReadonlyArray<CommandCodeCatalogModel>,
): ReadonlyArray<CommandCodeCatalogModel> => {
  const currentByKey = new Map(
    catalog.map((model) => [normalizeCommandCodeModelKey(model.slug), model] as const),
  );
  return cliModels.map((model) => {
    const current = currentByKey.get(normalizeCommandCodeModelKey(model.slug));
    if (current === undefined) return { ...model, effort: { kind: "unknown" } };
    return {
      ...model,
      name: current.name,
      ...(current.contextWindow !== undefined ? { contextWindow: current.contextWindow } : {}),
      effort: current.effort,
    };
  });
};

export const createCommandCodeCatalogController = Effect.fn("createCommandCodeCatalogController")(
  function* <DependencyError>(dependencies: CommandCodeCatalogDependencies<DependencyError>) {
    const validationCatalogRef = yield* Ref.make<CommandCodeValidationCatalogState>({
      managed: false,
      inventoryKeys: [],
      catalog: [],
    });
    const cacheRef = yield* Ref.make<CommandCodeCatalogCache | undefined>(undefined);
    const cachePath = (identity: CommandCodeCatalogIdentity): string =>
      commandCodeCatalogCachePath(
        dependencies.providerStatusCacheDir,
        identity.instanceId,
        dependencies.joinPath,
      );

    const readDiskCache = Effect.fn("CommandCodeCatalog.readDiskCache")(function* (
      identity: CommandCodeCatalogIdentity,
    ) {
      const body = yield* dependencies
        .readFile(cachePath(identity))
        .pipe(Effect.orElseSucceed(() => undefined));
      return body === undefined ? undefined : parseCommandCodeCatalogCache(body, identity);
    });

    const readCache = Effect.fn("CommandCodeCatalog.readCache")(function* (
      identity: CommandCodeCatalogIdentity,
    ) {
      const memoryCache = yield* Ref.get(cacheRef);
      if (memoryCache !== undefined && cacheMatchesIdentity(memoryCache, identity)) {
        return memoryCache;
      }
      const diskCache = yield* readDiskCache(identity);
      if (diskCache !== undefined) {
        yield* Ref.set(cacheRef, diskCache);
      }
      return diskCache;
    });

    const publishValidationCatalog = (
      identity: CommandCodeCatalogIdentity,
      cliModels: ReadonlyArray<CommandCodeModel>,
      catalog: ReadonlyArray<CommandCodeCatalogModel>,
    ) => {
      const inventoryKeys = commandCodeInventoryKeys(cliModels);
      return Ref.update(validationCatalogRef, (state) => {
        if (
          state.managed &&
          (!catalogIdentityMatches(state.identity, identity) ||
            !inventoryMatches(state.inventoryKeys, inventoryKeys))
        ) {
          return state;
        }
        return { ...state, identity, inventoryKeys, catalog };
      });
    };

    const activateInventory = (
      identity: CommandCodeCatalogIdentity,
      cliModels: ReadonlyArray<CommandCodeModel>,
    ) =>
      Ref.update(validationCatalogRef, (state) => ({
        managed: true,
        identity,
        inventoryKeys: commandCodeInventoryKeys(cliModels),
        catalog: catalogIdentityMatches(state.identity, identity)
          ? retainCatalogCapabilities(cliModels, state.catalog)
          : buildCommandCodeCatalog(cliModels, [], {}),
      }));

    const clearInventory = () =>
      Ref.set(validationCatalogRef, {
        managed: true,
        inventoryKeys: [],
        catalog: [],
      });

    const probeOne = Effect.fn("CommandCodeCatalog.probeOne")(function* (
      identity: CommandCodeCatalogIdentity,
      model: CommandCodeModel,
    ) {
      const result = yield* dependencies
        .probeEffort({
          executable: identity.resolvedBinaryPath,
          args: ["--model", model.slug, "--effort", INVALID_EFFORT_PROBE, "--no-auto-update"],
          stdin: "closed",
          maxStdoutBytes: COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES,
          maxStderrBytes: COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES,
        })
        .pipe(
          Effect.timeoutOption(COMMAND_CODE_EFFORT_PROBE_TIMEOUT),
          Effect.orElseSucceed(() => Option.none()),
        );
      return Option.flatMap(result, (completed) =>
        completed.exitCode === 1
          ? Option.some(
              parseCommandCodeEffortOutput(
                truncateUtf8(completed.stderr, COMMAND_CODE_EFFORT_PROBE_OUTPUT_BYTES),
              ),
            )
          : Option.none(),
      );
    });

    const catalogFromCache = Effect.fn("CommandCodeCatalog.catalogFromCache")(function* (
      identity: CommandCodeCatalogIdentity,
      cliModels: ReadonlyArray<CommandCodeModel>,
    ) {
      const cache = yield* readCache(identity);
      const catalog = buildCommandCodeCatalog(
        cliModels,
        cache?.apiModels ?? [],
        cache?.efforts ?? {},
      );
      yield* publishValidationCatalog(identity, cliModels, catalog);
      return catalog;
    });

    const refresh = Effect.fn("CommandCodeCatalog.refresh")(function* (
      identity: CommandCodeCatalogIdentity,
      cliModels: ReadonlyArray<CommandCodeModel>,
    ) {
      const now = yield* DateTime.now;
      const existing = yield* readCache(identity);
      let apiModels = existing?.apiModels ?? [];
      let apiFetchedAt = existing?.apiFetchedAt ?? DateTime.makeUnsafe(0);
      let hasApiDocument = existing !== undefined;

      if (existing === undefined || !isApiCacheFresh(existing, now)) {
        const fetched = yield* dependencies
          .fetchApiDocument({
            url: COMMAND_CODE_API_MODELS_URL,
            maxBodyBytes: COMMAND_CODE_API_MAX_BODY_BYTES,
          })
          .pipe(
            Effect.map(parseCommandCodeApiDocument),
            Effect.timeoutOption(COMMAND_CODE_API_FETCH_TIMEOUT),
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
        if (fetched !== undefined) {
          apiModels = fetched;
          apiFetchedAt = now;
          hasApiDocument = true;
        }
      }

      // Only the first 500 unique installed CLI models are probed. Later models remain
      // available in the catalog with unknown effort capability.
      const currentEffortKeys = new Set<string>();
      for (const model of cliModels) {
        if (currentEffortKeys.size >= COMMAND_CODE_API_MAX_MODELS) break;
        currentEffortKeys.add(normalizeCommandCodeModelKey(model.slug));
      }

      const efforts = makeEffortRecord();
      if (existing !== undefined) {
        for (const key of currentEffortKeys) {
          if (Object.hasOwn(existing.efforts, key)) {
            efforts[key] = existing.efforts[key]!;
          }
        }
      }
      const missingModels: CommandCodeModel[] = [];
      const scheduledKeys = new Set<string>();
      for (const model of cliModels) {
        const key = normalizeCommandCodeModelKey(model.slug);
        if (currentEffortKeys.has(key) && !Object.hasOwn(efforts, key) && !scheduledKeys.has(key)) {
          scheduledKeys.add(key);
          missingModels.push(model);
        }
      }

      const probed = yield* Effect.forEach(missingModels, (model) => probeOne(identity, model), {
        concurrency: 4,
      });
      for (let index = 0; index < missingModels.length; index += 1) {
        const capability = Option.getOrUndefined(probed[index]!);
        if (capability !== undefined) {
          efforts[normalizeCommandCodeModelKey(missingModels[index]!.slug)] = capability;
        }
      }

      const catalog = buildCommandCodeCatalog(cliModels, apiModels, efforts);
      yield* publishValidationCatalog(identity, cliModels, catalog);

      if (hasApiDocument || Object.keys(efforts).length > 0) {
        const nextCache: CommandCodeCatalogCache = {
          schemaVersion: COMMAND_CODE_CATALOG_CACHE_SCHEMA_VERSION,
          ...identity,
          apiFetchedAt,
          apiModels,
          efforts,
        };
        const contents = cacheJson(nextCache);
        yield* Ref.set(cacheRef, nextCache);
        if (utf8ByteLength(contents) > COMMAND_CODE_CACHE_MAX_BODY_BYTES) {
          yield* Effect.logWarning("Command Code catalog cache exceeds size limit", {
            path: cachePath(identity),
            bytes: utf8ByteLength(contents),
          });
        } else if (existing === undefined || contents !== cacheJson(existing)) {
          yield* dependencies.writeFileAtomically(cachePath(identity), contents).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to write Command Code catalog cache", {
                path: cachePath(identity),
                detail: String(error),
              }),
            ),
          );
        }
      }

      return catalog;
    });

    const getCatalog = () =>
      Ref.get(validationCatalogRef).pipe(Effect.map((state) => state.catalog));

    const getModelCapability = (modelSlug: string) => {
      const key = normalizeCommandCodeModelKey(modelSlug);
      return Ref.get(validationCatalogRef).pipe(
        Effect.map(
          (state) =>
            state.catalog.find((model) => normalizeCommandCodeModelKey(model.slug) === key)?.effort,
        ),
      );
    };

    const supportsReasoningEffort = (modelSlug: string, reasoningEffort: string) =>
      getModelCapability(modelSlug).pipe(
        Effect.map(
          (capability) =>
            capability?.kind === "adjustable" && capability.values.includes(reasoningEffort),
        ),
      );

    const getModelContextWindow = (modelSlug: string) => {
      const key = normalizeCommandCodeModelKey(modelSlug);
      return Ref.get(validationCatalogRef).pipe(
        Effect.map(
          (state) =>
            state.catalog.find((model) => normalizeCommandCodeModelKey(model.slug) === key)
              ?.contextWindow,
        ),
      );
    };

    return {
      cachePath,
      activateInventory,
      clearInventory,
      readCache,
      catalogFromCache,
      refresh,
      getCatalog,
      getModelCapability,
      supportsReasoningEffort,
      getModelContextWindow,
    } as const;
  },
);
