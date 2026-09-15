import { describe, test, expect } from "bun:test";
import {
  MAIN_POCKET_ACCOUNT,
  POCKET_COLORS,
  normalizePockets,
  nextAccountIndex,
  addPocket,
  renamePocket,
  updatePocketMeta,
  removePocket,
  canDeletePocket,
  findPocket,
  type PocketInfo,
} from "./pockets";

const IMAGE = "file:///img.jpg";

const main: PocketInfo = {
  account: 0,
  name: "Main",
  createdAt: 1,
  color: POCKET_COLORS[0],
};

describe("Pockets registry (pure)", () => {
  test("normalizePockets always includes the main Pocket", () => {
    expect(normalizePockets([])).toEqual([
      {
        account: MAIN_POCKET_ACCOUNT,
        name: "Main",
        createdAt: 0,
        color: POCKET_COLORS[0],
      },
    ]);
  });

  test("normalizePockets sorts by account and dedupes", () => {
    const out = normalizePockets([
      { account: 2, name: "B", createdAt: 3, color: "#e5588a" },
      { account: 0, name: "Main", createdAt: 1, color: "#0064b3" },
      { account: 2, name: "dupe", createdAt: 9, color: "#e29316" },
    ]);
    expect(out.map((p) => p.account)).toEqual([0, 2]);
    expect(findPocket(out, 2)?.name).toBe("B"); // first wins
  });

  test("normalizePockets defaults color and drops the legacy emoji field", () => {
    // Simulates JSON persisted before color existed and while Pockets still
    // carried an emoji instead of an image.
    const legacy = [
      { account: 0, name: "Main", createdAt: 0, emoji: "💧" },
      { account: 3, name: "Rent", createdAt: 5 },
    ] as PocketInfo[];
    const out = normalizePockets(legacy);
    expect(findPocket(out, 0)?.color).toBe(POCKET_COLORS[0 % POCKET_COLORS.length]);
    expect(findPocket(out, 3)?.color).toBe(POCKET_COLORS[3 % POCKET_COLORS.length]);
    const legacyMain = findPocket(out, 0);
    expect(legacyMain).toBeDefined();
    if (legacyMain) expect("emoji" in legacyMain).toBe(false);
  });

  test("normalizePockets defaults no image (initial fallback is a render concern)", () => {
    expect(findPocket(normalizePockets([]), 0)?.image).toBeUndefined();
  });

  test("normalizePockets preserves image/color/goal already present", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    const out = normalizePockets(list);
    const savings = findPocket(out, 1);
    expect(savings?.image).toBe(IMAGE);
    expect(savings?.color).toBe("#12a46b");
    expect(savings?.goal).toBe(500);
  });

  test("nextAccountIndex is max(account) + 1", () => {
    expect(nextAccountIndex([main])).toBe(1);
    expect(
      nextAccountIndex([
        main,
        { account: 5, name: "X", createdAt: 2, color: "#e29316" },
      ]),
    ).toBe(6);
  });

  test("addPocket appends at the next account index with the given image/color/goal", () => {
    const out = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      account: 1,
      name: "Savings",
      createdAt: 100,
      image: IMAGE,
      color: "#12a46b",
      goal: 500,
    });
  });

  test("addPocket without an image or a goal omits both", () => {
    const out = addPocket([main], "Rent", undefined, "#e29316", undefined, 100);
    expect(out[1].image).toBeUndefined();
    expect(out[1].goal).toBeUndefined();
  });

  test("renamePocket updates only the name, preserving image/color/goal", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    const out = renamePocket(list, 1, "Rent");
    const renamed = findPocket(out, 1);
    expect(renamed?.name).toBe("Rent");
    expect(renamed?.image).toBe(IMAGE);
    expect(renamed?.color).toBe("#12a46b");
    expect(renamed?.goal).toBe(500);
    expect(findPocket(out, 0)?.name).toBe("Main");
  });

  test("updatePocketMeta updates only the fields provided", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    const out = updatePocketMeta(list, 1, { color: "#0ea5a5" });
    const updated = findPocket(out, 1);
    expect(updated?.color).toBe("#0ea5a5");
    expect(updated?.image).toBe(IMAGE); // untouched
    expect(updated?.goal).toBe(500); // untouched
    expect(updated?.name).toBe("Savings"); // untouched
  });

  test("updatePocketMeta with an image URI sets it", () => {
    const list = addPocket([main], "Rent", undefined, "#e29316", undefined, 100);
    const out = updatePocketMeta(list, 1, { image: "file:///rent.jpg" });
    expect(findPocket(out, 1)?.image).toBe("file:///rent.jpg");
  });

  test("updatePocketMeta with image: null clears an existing image", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    const out = updatePocketMeta(list, 1, { image: null });
    expect(findPocket(out, 1)?.image).toBeUndefined();
  });

  test("updatePocketMeta with goal: null clears an existing goal", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    const out = updatePocketMeta(list, 1, { goal: null });
    expect(findPocket(out, 1)?.goal).toBeUndefined();
  });

  test("updatePocketMeta with goal: number sets a new goal", () => {
    const list = addPocket([main], "Rent", undefined, "#e29316", undefined, 100);
    const out = updatePocketMeta(list, 1, { goal: 280 });
    expect(findPocket(out, 1)?.goal).toBe(280);
  });

  test("updatePocketMeta leaves other Pockets untouched", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    const out = updatePocketMeta(list, 1, { image: "file:///other.jpg" });
    expect(findPocket(out, 0)).toEqual(main);
  });

  test("removePocket drops the target but keeps the main Pocket", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    expect(removePocket(list, 1).map((p) => p.account)).toEqual([0]);
    expect(removePocket(list, 0).map((p) => p.account)).toEqual([0, 1]); // main is protected
  });

  test("canDeletePocket refuses the main Pocket and unknown accounts", () => {
    const list = addPocket([main], "Savings", IMAGE, "#12a46b", 500, 100);
    expect(canDeletePocket(list, 0)).toBe(false);
    expect(canDeletePocket(list, 1)).toBe(true);
    expect(canDeletePocket(list, 9)).toBe(false);
  });
});
