import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { EnrichmentResult } from "@peable.to/shared-types";

const postMock = mock(async (_path: string, _body: unknown): Promise<unknown> => {
  throw new Error("postMock not configured for this test");
});

const getMock = mock(async (_path: string, _config?: unknown): Promise<unknown> => {
  throw new Error("getMock not configured for this test");
});

mock.module("./oxy-services", () => ({
  oxyServices: {
    createLinkedClient: () => ({ client: { post: postMock, get: getMock } }),
  },
}));

const {
  reserveNextSocialAddress,
  enrichAddresses,
  getSocialReceiveCursor,
  KeylessRecipientError,
} = await import("./gateway-client");

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
});

describe("reserveNextSocialAddress", () => {
  test("returns the reserved address and index", async () => {
    postMock.mockImplementationOnce(async () => ({ address: "TAbC123", index: 1 }));

    const result = await reserveNextSocialAddress("alice", "testnet");

    expect(result).toEqual({ address: "TAbC123", index: 1 });
    expect(postMock).toHaveBeenCalledWith("/v1/social/alice/next_address", {
      network: "testnet",
    });
  });

  test("URL-encodes the username", async () => {
    postMock.mockImplementationOnce(async () => ({ address: "TAbC123", index: 1 }));
    await reserveNextSocialAddress("weird name", "testnet");
    expect(postMock).toHaveBeenCalledWith("/v1/social/weird%20name/next_address", {
      network: "testnet",
    });
  });

  test("wraps a 409 response into KeylessRecipientError", async () => {
    postMock.mockImplementationOnce(async () => {
      const err = new Error("keyless") as Error & { status: number };
      err.status = 409;
      throw err;
    });

    await expect(reserveNextSocialAddress("bob", "testnet")).rejects.toBeInstanceOf(
      KeylessRecipientError,
    );
  });

  test("re-throws a non-409 error unchanged", async () => {
    postMock.mockImplementationOnce(async () => {
      const err = new Error("server exploded") as Error & { status: number };
      err.status = 500;
      throw err;
    });

    await expect(reserveNextSocialAddress("carol", "testnet")).rejects.toThrow(
      "server exploded",
    );
  });
});

describe("enrichAddresses", () => {
  test("posts the batch and returns the data map", async () => {
    // The real linked client's `unwrapResponse` already strips the backend's
    // `{ data: map }` envelope before resolving `client.post(...)`, so the
    // mock must return the NAKED map (the post-unwrap shape), not `{ data }`
    // — otherwise this test can't catch a re-introduced `.data` unwrap.
    const enrichmentMap: Record<string, EnrichmentResult> = {
      TAddr1: { kind: "unknown" },
      TAddr2: { kind: "merchant", displayName: "Shop" },
    };
    postMock.mockImplementationOnce(async () => enrichmentMap);

    const result = await enrichAddresses(["TAddr1", "TAddr2"]);

    expect(postMock).toHaveBeenCalledWith("/v1/enrich", { addresses: ["TAddr1", "TAddr2"] });
    expect(result).toEqual(enrichmentMap);
  });
});

describe("getSocialReceiveCursor", () => {
  test("returns the cursor directly (no {data} double-unwrap) and sends network as a query param", async () => {
    // The real Gateway route sends the cursor with no `data` envelope, so the
    // mock returns the NAKED shape (the post-unwrap shape) — otherwise this
    // test can't catch a re-introduced `.data` unwrap.
    const cursor = { reservedThrough: 7, identityPublicKey: `02${"ab".repeat(32)}` };
    getMock.mockImplementationOnce(async () => cursor);

    const result = await getSocialReceiveCursor("testnet");

    expect(getMock).toHaveBeenCalledWith("/v1/social/me/cursor", {
      params: { network: "testnet" },
    });
    expect(result).toEqual(cursor);
  });

  // The device compares that key with the one it derives from itself, so it
  // has to survive the client untouched rather than being dropped on the way.
  test("carries the identity key the backend derived those addresses from", async () => {
    const identityPublicKey = `02${"cd".repeat(32)}`;
    getMock.mockImplementationOnce(async () => ({ reservedThrough: 3, identityPublicKey }));

    const result = await getSocialReceiveCursor("testnet");

    expect(result.identityPublicKey).toBe(identityPublicKey);
  });

  test("returns reservedThrough: 0 and no key for a caller with no reservation cursor yet", async () => {
    getMock.mockImplementationOnce(async () => ({ reservedThrough: 0, identityPublicKey: null }));

    const result = await getSocialReceiveCursor("mainnet");

    expect(result).toEqual({ reservedThrough: 0, identityPublicKey: null });
  });
});
