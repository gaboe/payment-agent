import { expect, test } from "bun:test";
import { vtxosNeedingRefresh, type Vtxo } from "./keeper";

const v = (id: string, expiry: number, state = "spendable"): Vtxo =>
  ({ id, amount_sat: 500, expiry_height: expiry, state: { type: state } });

test("picks only VTXOs inside the threshold", () => {
  const tip = 1000;
  const due = vtxosNeedingRefresh([v("near", 1100), v("far", 1500)], tip, 144);
  expect(due.map((x) => x.id)).toEqual(["near"]);
});

test("boundary is inclusive", () => {
  expect(vtxosNeedingRefresh([v("edge", 1144)], 1000, 144)).toHaveLength(1);
  expect(vtxosNeedingRefresh([v("edge", 1145)], 1000, 144)).toHaveLength(0);
});

test("already expired VTXOs are still selected", () => {
  // Negative blocks left: refreshing may fail, but not trying guarantees loss.
  expect(vtxosNeedingRefresh([v("late", 900)], 1000, 144)).toHaveLength(1);
});

test("ignores VTXOs that are not spendable", () => {
  expect(vtxosNeedingRefresh([v("locked", 1100, "locked")], 1000, 144)).toHaveLength(0);
});

import { parseVtxos } from "./keeper";

test("parseVtxos rejects shapes that would throw later", () => {
  expect(() => parseVtxos({ message: "unauthorized" })).toThrow(/not an array/);
  expect(() => parseVtxos([{ id: "a", amount_sat: 1, expiry_height: 2 }])).toThrow(/missing expected fields/);
  expect(() => parseVtxos([{ id: 1, amount_sat: 1, expiry_height: 2, state: { type: "x" } }])).toThrow(/missing/);
});

test("parseVtxos accepts a well-formed list", () => {
  const ok = parseVtxos([{ id: "a", amount_sat: 500, expiry_height: 100, state: { type: "spendable" } }]);
  expect(ok).toHaveLength(1);
});

import { runKeeperOnce } from "./keeper";

// A pass that fails must reject. The caller stamps `keeperLastSuccess` when
// this resolves, and `/health` is read from that stamp — resolving after a
// failed step is how a wallet stops being refreshed without anyone noticing.
const deps = (bark: (path: string, init?: RequestInit) => Promise<Response>) => ({
  bark,
  esploraUrl: "http://esplora.test",
  thresholdBlocks: 144,
  log: () => {},
});

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test("rejects when barkd refuses the sync", async () => {
  const bark = async () => new Response("nope", { status: 503 });
  await expect(runKeeperOnce(deps(bark))).rejects.toThrow(/sync failed with 503/);
});

test("rejects when the refresh is refused", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("900000", { status: 200 })) as typeof fetch;
  try {
    const bark = async (path: string) => {
      if (path.includes("/sync")) return new Response("", { status: 200 });
      if (path.includes("/vtxos") && !path.includes("refresh")) {
        return json([{ id: "a", amount_sat: 500, expiry_height: 900_050, state: { type: "spendable" } }]);
      }
      return new Response("round is closed", { status: 500 });
    };
    expect(runKeeperOnce(deps(bark))).rejects.toThrow(/failed with 500/);
  } finally {
    globalThis.fetch = original;
  }
});

test("resolves when there is nothing due", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("900000", { status: 200 })) as typeof fetch;
  try {
    const bark = async (path: string) =>
      path.includes("/sync") ? new Response("", { status: 200 }) : json([]);
    expect(runKeeperOnce(deps(bark))).resolves.toBeUndefined();
  } finally {
    globalThis.fetch = original;
  }
});
