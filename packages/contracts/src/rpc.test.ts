import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  WS_METHODS,
  WsServerSetProviderGlobalOptionRpc,
  WsSubscribeServerConfigRpc,
} from "./rpc.ts";

const decodePayload = (input: unknown) =>
  Schema.decodeUnknownSync(WsServerSetProviderGlobalOptionRpc.payloadSchema)(input);
const decodeSuccess = (input: unknown) =>
  Schema.decodeUnknownSync(WsServerSetProviderGlobalOptionRpc.successSchema)(input);
const decodeError = (input: unknown) =>
  Schema.decodeUnknownSync(WsServerSetProviderGlobalOptionRpc.errorSchema)(input);

describe("WsServerSetProviderGlobalOptionRpc", () => {
  it("uses the provider-global option method and decodes valid payloads", () => {
    expect(WS_METHODS.serverSetProviderGlobalOption).toBe("server.setProviderGlobalOption");
    expect(WsServerSetProviderGlobalOptionRpc._tag).toBe(WS_METHODS.serverSetProviderGlobalOption);

    expect(
      decodePayload({ instanceId: "commandcode", optionId: "account", value: "work" }),
    ).toEqual({ instanceId: "commandcode", optionId: "account", value: "work" });
    expect(
      decodePayload({ instanceId: "commandcode", optionId: "fastMode", value: false }),
    ).toEqual({ instanceId: "commandcode", optionId: "fastMode", value: false });
  });

  it("rejects invalid payloads", () => {
    expect(() => decodePayload({ instanceId: "commandcode", optionId: "", value: true })).toThrow();
    expect(() =>
      decodePayload({ instanceId: "commandcode", optionId: "account", value: null }),
    ).toThrow();
    expect(() => decodePayload({ optionId: "account", value: "work" })).toThrow();
  });

  it("decodes the provider update success and typed error payloads", () => {
    expect(decodeSuccess({ providers: [] })).toEqual({ providers: [] });
    expect(
      decodeError({
        _tag: "ServerProviderGlobalOptionSetError",
        instanceId: "commandcode",
        optionId: "account",
        message: "Failed to update account.",
      }),
    ).toMatchObject({
      _tag: "ServerProviderGlobalOptionSetError",
      instanceId: "commandcode",
      optionId: "account",
      message: "Failed to update account.",
    });
  });
});

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});
