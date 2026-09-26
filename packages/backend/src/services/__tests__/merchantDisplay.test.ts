import { test, expect } from "bun:test";
import type { MerchantRow } from "../../db/merchants/merchantRepository";
import { resolveMerchantDisplay } from "../merchantDisplay";

const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";

/**
 * No database here, deliberately.
 *
 * `resolveMerchantDisplay` is a PURE function over a `MerchantRow` — it reads
 * three fields and calls a synchronous, no-network URL builder. The Mongo
 * version needed a server only because a `Merchant` document could not be
 * constructed without one; a row is an object literal. The identity fields it
 * reads (`display_name`, `avatar_file_id`, `description`) additionally have no
 * writer at all — no route registers them and `insertMerchant` takes their
 * column defaults — so seeding them would mean writing the columns directly,
 * which would test a fixture rather than this function.
 */
function merchantRow(values: Partial<MerchantRow>): MerchantRow {
  return {
    id: "0199a000-0000-7000-8000-000000000000",
    publicId: "merch_test_display",
    oxyAppId: "app_display",
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    webhookUrl: null,
    requiredConfirmations: 1,
    livemode: false,
    displayName: null,
    avatarFileId: null,
    description: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...values,
  };
}

test("resolves displayName + avatarUrl + description when all identity fields are set", async () => {
  const merchant = merchantRow({
    publicId: "merch_test_display_1",
    oxyAppId: "app_display_1",
    displayName: "Mercaria",
    avatarFileId: "file_mercaria_logo",
    description: "Marketplace",
  });

  const display = await resolveMerchantDisplay(merchant);

  expect(display).toEqual({
    name: "Mercaria",
    // The public-CDN builder (`oxy.assets.publicUrl`) — never a
    // hand-built `cloud.oxy.so` string — with the ecosystem's 'thumb' variant.
    avatarUrl: "https://cloud.oxy.so/file_mercaria_logo?variant=thumb",
    description: "Marketplace",
  });
});

test("falls back to a neutral name and null avatar/description when unset", async () => {
  const merchant = merchantRow({
    publicId: "merch_test_display_2",
    oxyAppId: "app_display_2",
  });

  const display = await resolveMerchantDisplay(merchant);

  expect(display.name).toBe("Peable merchant");
  expect(display.avatarUrl).toBeNull();
  expect(display.description).toBeNull();
});
