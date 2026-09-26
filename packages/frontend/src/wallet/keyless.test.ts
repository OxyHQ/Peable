import { describe, test, expect } from "bun:test";
import type { AuthMethodEntry } from "@oxy.so/contracts";
import {
  resolveKeylessAction,
  hasIdentityAuthMethod,
  COMMONS_CREATE_IDENTITY_URL,
  COMMONS_IMPORT_IDENTITY_URL,
} from "./keyless";

const identityMethod: AuthMethodEntry = {
  type: "identity",
  linkedAt: "2026-09-01T00:00:00.000Z",
  verificationMethodId: "#key-1",
};

describe("hasIdentityAuthMethod", () => {
  test("true when the account holds an identity key", () => {
    expect(hasIdentityAuthMethod([identityMethod])).toBe(true);
  });
  test("false for a keyless (email / password / authenticator) account: /auth/methods is empty", () => {
    expect(hasIdentityAuthMethod([])).toBe(false);
  });
});

describe("a keyless email account", () => {
  test("lands on creating its Oxy ID in Commons", () => {
    const action = resolveKeylessAction(hasIdentityAuthMethod([]));
    expect(action).toEqual({ kind: "create", url: COMMONS_CREATE_IDENTITY_URL });
  });
});

describe("resolveKeylessAction", () => {
  test("no server identity → create in Commons", () => {
    const action = resolveKeylessAction(false);
    expect(action.kind).toBe("create");
    expect(action.url).toBe(COMMONS_CREATE_IDENTITY_URL);
  });
  test("server has identity (exists on another device) → open Commons to import it", () => {
    const action = resolveKeylessAction(true);
    expect(action.kind).toBe("sync");
    expect(action.url).toBe(COMMONS_IMPORT_IDENTITY_URL);
  });
});
