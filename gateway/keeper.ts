/**
 * Keeps the wallet's VTXOs from expiring.
 *
 * This cannot be done with `bark maintain`: the CLI takes an exclusive lock on
 * the datadir, and barkd already holds it —
 *
 *     another process is already using datadir /data (holder PID: 147)
 *
 * so every run would fail. The work goes through barkd's own HTTP API instead.
 *
 * It also cannot be `POST /refresh/all`, which refreshes every VTXO regardless
 * of expiry. The server charges 0 ppm to refresh something close to expiring and
 * 2000-5000 ppm for something that still has life in it, so refreshing
 * indiscriminately is a standing fee for no benefit.
 */

export interface Vtxo {
  id: string;
  amount_sat: number;
  expiry_height: number;
  state: { type: string };
}

/**
 * barkd's response is trusted but not assumed: an unchecked cast means a error
 * shape or a missing field throws inside the keeper, the caller swallows it,
 * and the container keeps looking healthy while VTXOs march to expiry — the
 * exact failure the keeper exists to prevent.
 */
export function parseVtxos(value: unknown): Vtxo[] {
  if (!Array.isArray(value)) throw new Error("vtxos response is not an array");
  return value.map((v, i) => {
    if (
      typeof v?.id !== "string" ||
      typeof v?.amount_sat !== "number" ||
      typeof v?.expiry_height !== "number" ||
      typeof v?.state?.type !== "string"
    ) {
      throw new Error(`vtxo at index ${i} is missing expected fields`);
    }
    return v as Vtxo;
  });
}

/**
 * VTXOs close enough to expiry that they should be refreshed now.
 * `bark`'s own default threshold on mainnet is 144 blocks (~24h).
 */
export function vtxosNeedingRefresh(
  vtxos: Vtxo[],
  tipHeight: number,
  thresholdBlocks: number,
): Vtxo[] {
  return vtxos.filter(
    (v) => v.state.type === "spendable" && v.expiry_height - tipHeight <= thresholdBlocks,
  );
}

interface KeeperDeps {
  bark: (path: string, init?: RequestInit) => Promise<Response>;
  esploraUrl: string;
  thresholdBlocks: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * One maintenance pass. It **throws** on every failure, and that is the whole
 * contract: the caller records a success timestamp when this returns, and
 * `/health` is derived from that timestamp. An early `return` on a failed sync,
 * tip read, vtxo list or refresh would publish "healthy" while nothing was
 * refreshed — the exact silence this file exists to prevent.
 */
export async function runKeeperOnce(deps: KeeperDeps): Promise<void> {
  const { bark, esploraUrl, thresholdBlocks, log } = deps;

  const sync = await bark("/api/v1/wallet/sync", { method: "POST" });
  if (!sync.ok) {
    log("keeper_sync_failed", { status: sync.status });
    throw new Error(`wallet sync failed with ${sync.status}`);
  }

  const tipRes = await fetch(`${esploraUrl}/blocks/tip/height`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!tipRes.ok) {
    log("keeper_tip_failed", { status: tipRes.status });
    throw new Error(`esplora tip failed with ${tipRes.status}`);
  }
  const tip = Number(await tipRes.text());
  if (!Number.isFinite(tip)) {
    log("keeper_tip_unparseable");
    throw new Error("esplora tip is not a number");
  }

  const vtxoRes = await bark("/api/v1/wallet/vtxos");
  if (!vtxoRes.ok) {
    log("keeper_vtxos_failed", { status: vtxoRes.status });
    throw new Error(`listing vtxos failed with ${vtxoRes.status}`);
  }
  let vtxos: Vtxo[];
  try {
    vtxos = parseVtxos(await vtxoRes.json());
  } catch (e) {
    log("keeper_vtxos_unparseable", { error: String(e) });
    throw e;
  }
  const due = vtxosNeedingRefresh(vtxos, tip, thresholdBlocks);

  if (due.length === 0) {
    log("keeper_ok", { tip, vtxos: vtxos.length, due: 0 });
    return;
  }

  log("keeper_refreshing", {
    tip,
    due: due.map((v) => ({ id: v.id, blocks_left: v.expiry_height - tip })),
  });

  const res = await bark("/api/v1/wallet/refresh/vtxos", {
    method: "POST",
    body: JSON.stringify({ vtxos: due.map((v) => v.id) }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    log("keeper_refresh_failed", { status: res.status, body });
    throw new Error(`refreshing ${due.length} vtxo(s) failed with ${res.status}: ${body}`);
  }
  log("keeper_refresh_submitted", { status: res.status });
}
