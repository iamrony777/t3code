import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsServerSetProviderGlobalOptionRpc } from "./rpc.ts";

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
