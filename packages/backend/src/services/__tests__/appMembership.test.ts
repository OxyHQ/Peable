import { test, expect, describe, mock } from "bun:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { SsrfRejection } from "@oxy.so/core/server";
import type { SafeFetchResult } from "@oxy.so/core/server";
import { assertAppMembership } from "../appMembership";

const OXY_API_URL = "https://oxy-api.test";

/**
 * Build a fake `SafeFetchFn` that resolves once with a real `IncomingMessage`
 * carrying `body` as its JSON payload — mirrors the fake-safeFetch pattern
 * `routes/__tests__/webhookDeliveries.test.ts` already uses (a real
 * `IncomingMessage` so `fetchCallerMembership`'s stream reader runs for real
 * against controlled bytes, not a mock of the reader itself).
 */
function fakeSafeFetchOnce(status: number, body: unknown): {
  fn: (url: string, options?: { headers?: Record<string, string> }) => Promise<SafeFetchResult>;
  calls: { url: string; headers?: Record<string, string> }[];
} {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fn = async (
    url: string,
    options?: { headers?: Record<string, string> },
  ): Promise<SafeFetchResult> => {
    calls.push({ url, headers: options?.headers });
    const response = new IncomingMessage(new Socket());
    response.push(Buffer.from(JSON.stringify(body)));
    response.push(null);
    return { response, status, headers: {}, finalUrl: url };
  };
  return { fn, calls };
}

describe("assertAppMembership", () => {
  test("a non-null callerMembership -> allowed: true", async () => {
    const { fn } = fakeSafeFetchOnce(200, {
      application: { callerMembership: { role: "owner", permissions: ["app:read"] } },
    });
    const result = await assertAppMembership("user_a", "app_1", "bearer-a", {
      safeFetch: fn,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(true);
  });

  test("a null callerMembership -> allowed: false", async () => {
    const { fn } = fakeSafeFetchOnce(200, { application: { callerMembership: null } });
    const result = await assertAppMembership("user_b", "app_1", "bearer-b", {
      safeFetch: fn,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(false);
  });

  test("a 403 from oxy-api -> allowed: false", async () => {
    const { fn } = fakeSafeFetchOnce(403, { error: "forbidden" });
    const result = await assertAppMembership("user_c", "app_1", "bearer-c", {
      safeFetch: fn,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(false);
  });

  test("a 404 from oxy-api -> allowed: false", async () => {
    const { fn } = fakeSafeFetchOnce(404, { error: "not found" });
    const result = await assertAppMembership("user_d", "app_1", "bearer-d", {
      safeFetch: fn,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(false);
  });

  test("forwards the caller's bearer as Authorization and hits the right URL", async () => {
    const { fn, calls } = fakeSafeFetchOnce(200, {
      application: { callerMembership: { role: "owner" } },
    });
    await assertAppMembership("user_e", "app_forward", "bearer-e-secret", {
      safeFetch: fn,
      oxyApiUrl: OXY_API_URL,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${OXY_API_URL}/applications/app_forward`);
    expect(calls[0]?.headers?.Authorization).toBe("Bearer bearer-e-secret");
  });

  test("a malformed (non-JSON) body -> allowed: false, never throws", async () => {
    const safeFetch = async (): Promise<SafeFetchResult> => {
      const response = new IncomingMessage(new Socket());
      response.push(Buffer.from("not json"));
      response.push(null);
      return { response, status: 200, headers: {}, finalUrl: OXY_API_URL };
    };
    const result = await assertAppMembership("user_f", "app_1", "bearer-f", {
      safeFetch,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(false);
  });

  test("safeFetch throwing SsrfRejection -> allowed: false, never throws", async () => {
    const safeFetch = async (): Promise<SafeFetchResult> => {
      throw new SsrfRejection("blocked");
    };
    const result = await assertAppMembership("user_g", "app_1", "bearer-g", {
      safeFetch,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(false);
  });

  test("safeFetch throwing an unexpected error -> allowed: false, never throws", async () => {
    const safeFetch = async (): Promise<SafeFetchResult> => {
      throw new Error("network unreachable");
    };
    const result = await assertAppMembership("user_h", "app_1", "bearer-h", {
      safeFetch,
      oxyApiUrl: OXY_API_URL,
    });
    expect(result.allowed).toBe(false);
  });

  test("a cache hit avoids a second upstream call", async () => {
    const upstream = mock(async (): Promise<SafeFetchResult> => {
      const response = new IncomingMessage(new Socket());
      response.push(Buffer.from(JSON.stringify({ application: { callerMembership: { role: "owner" } } })));
      response.push(null);
      return { response, status: 200, headers: {}, finalUrl: OXY_API_URL };
    });

    const first = await assertAppMembership("user_cache", "app_cache", "bearer-i", {
      safeFetch: upstream,
      oxyApiUrl: OXY_API_URL,
    });
    expect(first.allowed).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);

    // Second call within the TTL — even though the stub would still answer
    // `true` if invoked, the assertion that matters is the call COUNT: prove
    // it's genuinely served from cache, not merely consistently true.
    const second = await assertAppMembership("user_cache", "app_cache", "bearer-i", {
      safeFetch: upstream,
      oxyApiUrl: OXY_API_URL,
    });
    expect(second.allowed).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  test("TTL expiry re-checks against oxy-api instead of serving a stale cache entry", async () => {
    let call = 0;
    const upstream = async (): Promise<SafeFetchResult> => {
      call += 1;
      // Flips the answer on the second call so the assertion can only pass if
      // the cache entry genuinely expired and a real re-check happened.
      const callerMembership = call === 1 ? { role: "owner" } : null;
      const response = new IncomingMessage(new Socket());
      response.push(Buffer.from(JSON.stringify({ application: { callerMembership } })));
      response.push(null);
      return { response, status: 200, headers: {}, finalUrl: OXY_API_URL };
    };

    const first = await assertAppMembership("user_ttl", "app_ttl", "bearer-j", {
      safeFetch: upstream,
      oxyApiUrl: OXY_API_URL,
      ttlMs: 10,
    });
    expect(first.allowed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await assertAppMembership("user_ttl", "app_ttl", "bearer-j", {
      safeFetch: upstream,
      oxyApiUrl: OXY_API_URL,
      ttlMs: 10,
    });
    expect(second.allowed).toBe(false);
    expect(call).toBe(2);
  });

  test("the cache is keyed per (userId, applicationId) — a different user against the same application is checked independently", async () => {
    const upstream = mock(async (): Promise<SafeFetchResult> => {
      const response = new IncomingMessage(new Socket());
      response.push(Buffer.from(JSON.stringify({ application: { callerMembership: { role: "member" } } })));
      response.push(null);
      return { response, status: 200, headers: {}, finalUrl: OXY_API_URL };
    });

    await assertAppMembership("user_k1", "app_shared", "bearer-k1", {
      safeFetch: upstream,
      oxyApiUrl: OXY_API_URL,
    });
    await assertAppMembership("user_k2", "app_shared", "bearer-k2", {
      safeFetch: upstream,
      oxyApiUrl: OXY_API_URL,
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
