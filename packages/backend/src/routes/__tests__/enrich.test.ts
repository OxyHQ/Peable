import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";
import {
  resetGatewayTables,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createEnrichRouter } from "../enrich";

const TEST_VIEWER_ID = "user_test_viewer";
const stubRequireOxyUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = TEST_VIEWER_ID;
  next();
};

let server: Server;
let baseUrl: string;

interface EnrichHttpResponse {
  data?: Record<string, { kind: string }>;
  error?: { type: string; message: string };
}

async function postEnrich(
  body: Record<string, unknown>,
): Promise<{ status: number; body: EnrichHttpResponse }> {
  const res = await fetch(`${baseUrl}/v1/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as EnrichHttpResponse };
}

useGatewayDatabase();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createEnrichRouter({ requireOxyUser: stubRequireOxyUser }));

  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await resetGatewayTables();
});

describe("POST /v1/enrich", () => {
  test("returns unknown for addresses with no matching record", async () => {
    const { status, body } = await postEnrich({ addresses: ["TAddrA", "TAddrB"] });
    expect(status).toBe(200);
    expect(body.data?.TAddrA).toEqual({ kind: "unknown" });
    expect(body.data?.TAddrB).toEqual({ kind: "unknown" });
  });

  test("422s on an empty addresses array", async () => {
    const { status, body } = await postEnrich({ addresses: [] });
    expect(status).toBe(422);
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("422s when the batch exceeds the max size", async () => {
    const addresses = Array.from({ length: 51 }, (_, i) => `TAddr${i}`);
    const { status } = await postEnrich({ addresses });
    expect(status).toBe(422);
  });

  test("422s on a missing addresses field", async () => {
    const { status } = await postEnrich({});
    expect(status).toBe(422);
  });
});
