import { test, expect } from "bun:test";
import { loadConfig } from "../config";

/**
 * `DATABASE_URL` is REQUIRED, so every fixture below carries it — these tests
 * are about other variables, and an env without it would fail on a refusal
 * that has nothing to do with what they assert. The value is never connected
 * to; `loadConfig` is pure over its argument.
 */
const DB = { DATABASE_URL: "postgres://peable:peable@localhost:5432/peable" };

test("oxyApiUrl reads OXY_API_URL", () => {
  expect(loadConfig({ ...DB, OXY_API_URL: "https://oxy-api.internal" }).oxyApiUrl).toBe(
    "https://oxy-api.internal",
  );
});

test("oxyApiUrl defaults to https://api.oxy.so when unset — Oxy's production API", () => {
  expect(loadConfig({ ...DB }).oxyApiUrl).toBe("https://api.oxy.so");
});
