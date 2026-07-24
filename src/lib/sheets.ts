import { audit, db, seed } from "./store";
import type { Drawer } from "./types";

// ---------------------------------------------------------------------------
// Google Sheets inventory + session tracker.
//
// The Apps Script Web App is the slow hop (cold starts ~5–15s). We mitigate by:
//   • short in-process cache + in-flight dedupe
//   • brief timeouts on menu reads (UI never waits for a cold script)
//   • cron warmup hitting this same path to keep the script warm
//
// Config:
//   SHEETS_WEBHOOK_URL   deployed Apps Script Web App /exec URL
//   SHEETS_SECRET        shared secret checked by the script
// ---------------------------------------------------------------------------

const WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const SECRET = process.env.SHEETS_SECRET;

/** Reuse a successful pull within the same Fluid instance. */
const PULL_CACHE_MS = 120_000;
let lastPullAt = 0;
let lastPullOk = false;
let inflightPull: Promise<{ ok: boolean; error?: string; count?: number }> | null =
  null;

/**
 * After a lock/unlock mutation, ignore sheet Is Locked for a short window so a
 * slow inventory pull can't wipe the local openDrawer state before the
 * background sheet write lands.
 */
const LOCK_HOLD_MS = 20_000;
const recentLockHold = new Map<string, { locked: boolean; until: number }>();

export function noteLocalLock(drawerId: string, locked: boolean) {
  recentLockHold.set(drawerId, { locked, until: Date.now() + LOCK_HOLD_MS });
}

export type SessionAction =
  | "Lock"
  | "Unlock"
  | "Take"
  | "Return"
  | "Take + Lock"
  | "Return + Lock"
  | "Unlock + Take"
  | "Unlock + Return";

export interface SessionRow {
  name: string;
  sessionId: string;
  action: SessionAction;
  part: string;
  shelf: string;
  quantity: number;
  locked: boolean;
  teamNumber?: string;
  roboticsLevel?: string;
  /** ISO timestamp; defaults to now when logging. */
  time?: string;
}

export interface SheetDrawerRow {
  number: number;
  part: string;
  quantity: number;
  locked: boolean;
  /** Image URL, data URL, or Drive view link from the sheet Image column. */
  photo?: string;
  image?: string;
}

async function postToSheets(
  payload: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<Response | null> {
  if (!sheetsEnabled()) return null;

  try {
    const ctrl = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? 20000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "text/plain;charset=utf-8" };

    // Apps Script /exec returns 302 → googleusercontent. Prefer manual follow so
    // we don't lose the ContentService body (common with auto-follow + JSON mime).
    let res = await fetch(WEBHOOK_URL!, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        res = await fetch(loc, {
          method: "GET",
          signal: ctrl.signal,
          redirect: "follow",
        });
      } else {
        res = await fetch(WEBHOOK_URL!, {
          method: "POST",
          headers,
          body,
          signal: ctrl.signal,
          redirect: "follow",
        });
      }
    }

    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

/** Parse Apps Script body — they sometimes wrap or return empty on bad redirects. */
function parseSheetsJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty_body");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("invalid_json");
  }
}

async function postResult(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await postToSheets(payload, { timeoutMs: 20000 });
  if (!res) return { ok: false, error: "fetch_failed" };
  try {
    const text = await res.text();
    const body = parseSheetsJson(text) as { error?: string; ok?: boolean };
    if (body?.error && body.error !== "snapshot_disabled") {
      return { ok: false, error: body.error };
    }
    return { ok: res.ok || res.status === 200 };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

async function postOk(payload: Record<string, unknown>): Promise<boolean> {
  return (await postResult(payload)).ok;
}

function invalidatePullCache() {
  lastPullAt = 0;
  lastPullOk = false;
}

function drawerNumber(drawer: Drawer): number {
  return parseInt(drawer.label.replace(/[^0-9]/g, ""), 10) || 0;
}

function sessionRowPayload(row: SessionRow) {
  return {
    name: row.name,
    sessionId: row.sessionId,
    actionLabel: row.action,
    part: row.part,
    shelf: row.shelf,
    quantity: row.quantity,
    locked: row.locked,
    teamNumber: row.teamNumber ?? "",
    roboticsLevel: row.roboticsLevel ?? "",
    time: row.time ?? new Date().toISOString(),
  };
}

export async function logSessionRow(
  row: SessionRow,
  action: "append" | "update" = "append",
): Promise<void> {
  if (!sheetsEnabled()) return;

  const payload = {
    secret: SECRET,
    type: "session_row",
    action,
    row: sessionRowPayload(row),
  };

  const ok = await postOk(payload);
  if (!ok) {
    audit({
      type: "sheets.session_error",
      detail: `${action} ${row.action} ${row.sessionId}`,
    });
    return;
  }
  audit({
    type: "sheets.session_ok",
    detail: `${action} ${row.action} ${row.sessionId}`,
  });
}

async function pullOnce(opts?: {
  force?: boolean;
  timeoutMs?: number;
  includePhotos?: boolean;
}): Promise<{
  ok: boolean;
  error?: string;
  count?: number;
  photos?: number;
  imageCol?: number | null;
}> {
  const res = await postToSheets(
    {
      secret: SECRET,
      type: "inventory",
      includePhotos: Boolean(opts?.includePhotos),
    },
    { timeoutMs: opts?.timeoutMs },
  );
  if (!res) {
    audit({ type: "sheets.pull_error", detail: "fetch_failed" });
    lastPullOk = false;
    return { ok: false, error: "fetch_failed" };
  }

  let text = "";
  try {
    text = await res.text();
  } catch {
    audit({ type: "sheets.pull_error", detail: "read_body_failed" });
    lastPullOk = false;
    return { ok: false, error: "read_body_failed" };
  }

  // Dead Apps Script deployment returns Google HTML 404 — not JSON.
  if (
    res.status === 404 ||
    /Page Not Found/i.test(text) ||
    /^\s*<!DOCTYPE html/i.test(text)
  ) {
    audit({ type: "sheets.pull_error", detail: "webhook_gone" });
    lastPullOk = false;
    return { ok: false, error: "webhook_gone" };
  }

  let body: {
    drawers?: SheetDrawerRow[];
    error?: string;
    ok?: boolean;
    photos?: number;
    imageCol?: number | null;
  };
  try {
    body = parseSheetsJson(text) as {
      drawers?: SheetDrawerRow[];
      error?: string;
      ok?: boolean;
      photos?: number;
      imageCol?: number | null;
    };
  } catch {
    audit({
      type: "sheets.pull_error",
      detail: `invalid_json http_${res.status} ${text.slice(0, 120)}`,
    });
    lastPullOk = false;
    return { ok: false, error: "invalid_json" };
  }

  if (body.error) {
    audit({ type: "sheets.pull_error", detail: String(body.error) });
    lastPullOk = false;
    return { ok: false, error: String(body.error) };
  }

  if (!res.ok) {
    audit({ type: "sheets.pull_error", detail: `http ${res.status}` });
    lastPullOk = false;
    return { ok: false, error: `http_${res.status}` };
  }

  const rows = Array.isArray(body.drawers) ? body.drawers : [];
  applySheetRowsToStore(rows);
  lastPullAt = Date.now();
  lastPullOk = true;
  const photoCount =
    typeof body.photos === "number"
      ? body.photos
      : rows.filter((r) => String(r.photo ?? r.image ?? "").trim()).length;
  audit({
    type: "sheets.pull_ok",
    detail: `${rows.length} drawers photos_${photoCount} imageCol_${body.imageCol ?? "none"}`,
  });
  return {
    ok: true,
    count: rows.length,
    photos: photoCount,
    imageCol: body.imageCol ?? null,
  };
}

/**
 * Pull inventory from the sheet into the in-memory store.
 * Concurrent callers share one in-flight request.
 */
export async function pullStockFromSheets(opts?: {
  force?: boolean;
  timeoutMs?: number;
  includePhotos?: boolean;
}): Promise<{
  ok: boolean;
  error?: string;
  count?: number;
  photos?: number;
  imageCol?: number | null;
}> {
  if (!sheetsEnabled()) return { ok: false, error: "not_configured" };
  seed();

  const now = Date.now();
  if (!opts?.force && lastPullOk && now - lastPullAt < PULL_CACHE_MS) {
    return { ok: true, count: db.drawers.size };
  }

  if (inflightPull) {
    const shared = await inflightPull;
    if (shared.ok && !opts?.force) return shared;
    if (shared.ok && opts?.force && Date.now() - lastPullAt < 2_000) {
      return shared;
    }
  }

  const run = pullOnce(opts).finally(() => {
    if (inflightPull === run) inflightPull = null;
  });
  inflightPull = run;
  return run;
}

/** Lightweight ping used by cron to keep Apps Script warm. */
export async function warmSheets(): Promise<{ ok: boolean; error?: string; ms: number }> {
  if (!sheetsEnabled()) return { ok: false, error: "not_configured", ms: 0 };
  const started = Date.now();
  // Prefer a real light inventory so this isolate also has fresh stock cached.
  const result = await pullStockFromSheets({ force: true, timeoutMs: 25000 });
  if (!result.ok) {
    // Fall back to a tiny ping so the script process stays awake.
    const ping = await postToSheets(
      { secret: SECRET, type: "ping" },
      { timeoutMs: 12000 },
    );
    if (!ping) {
      return { ok: false, error: result.error ?? "fetch_failed", ms: Date.now() - started };
    }
  }
  return { ok: true, ms: Date.now() - started };
}

function applySheetRowsToStore(rows: SheetDrawerRow[]) {
  const byNumber = new Map<number, Drawer>();
  for (const d of db.drawers.values()) {
    const n = parseInt(d.label.replace(/[^0-9]/g, ""), 10);
    if (n) byNumber.set(n, d);
  }

  for (const row of rows) {
    const number = Number(row.number);
    if (!Number.isFinite(number) || number < 1) continue;
    const drawer = byNumber.get(Math.floor(number));
    if (!drawer) continue;

    const stock = db.stock.get(drawer.id);
    if (!stock) continue;

    const qty = Math.max(0, Math.floor(Number(row.quantity) || 0));
    if (stock.quantity !== qty) {
      stock.quantity = qty;
      stock.version += 1;
    }

    const part = String(row.part ?? "").trim();
    if (part || row.photo !== undefined || row.image !== undefined) {
      const item = db.items.get(drawer.itemId);
      if (item) {
        const next = { ...item };
        if (part) next.name = part;
        if (row.photo !== undefined || row.image !== undefined) {
          // Empty clears seed Unsplash so the wire placeholder shows.
          next.photo = String(row.photo ?? row.image ?? "").trim();
        }
        db.items.set(drawer.itemId, next);
      }
    }

    if (row.locked) {
      const hold = recentLockHold.get(drawer.id);
      if (hold && Date.now() < hold.until) {
        // Keep the post-mutation lock state until the sheet write catches up.
        if (hold.locked) db.openDrawer.delete(drawer.id);
        else if (!db.openDrawer.has(drawer.id)) {
          db.openDrawer.set(drawer.id, "sheet-open");
        }
      } else {
        db.openDrawer.delete(drawer.id);
      }
    } else if (!db.openDrawer.has(drawer.id)) {
      const hold = recentLockHold.get(drawer.id);
      if (hold && Date.now() < hold.until && hold.locked) {
        // Local just locked — don't reopen from a stale sheet row.
      } else {
        db.openDrawer.set(drawer.id, "sheet-open");
      }
    } else {
      const hold = recentLockHold.get(drawer.id);
      if (hold && Date.now() < hold.until && hold.locked) {
        db.openDrawer.delete(drawer.id);
      }
    }
  }
}

/** Patch Quantity for one drawer only — does not rewrite Part or Is Locked. */
export async function setSheetQuantity(
  drawer: Drawer,
  quantity: number,
): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  const number = drawerNumber(drawer);
  if (!number) return false;

  const ok = await postOk({
    secret: SECRET,
    type: "set_quantity",
    number,
    quantity: Math.max(0, Math.floor(quantity)),
  });
  if (!ok) {
    audit({ type: "sheets.qty_error", drawerId: drawer.id, detail: String(quantity) });
    return false;
  }
  invalidatePullCache();
  audit({ type: "sheets.qty_ok", drawerId: drawer.id, detail: String(quantity) });
  return true;
}

/**
 * Take/return in one request: patch Quantity + write the session row together.
 * Halves the Apps Script round-trips vs. two separate posts. Falls back to the
 * legacy pair of calls if the deployed script predates the combined `tx` type.
 */
export async function setSheetTransaction(
  drawer: Drawer,
  quantity: number,
  row: SessionRow,
  rowAction: "append" | "update" = "append",
): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  const number = drawerNumber(drawer);
  if (!number) return false;

  const result = await postResult({
    secret: SECRET,
    type: "tx",
    number,
    quantity: Math.max(0, Math.floor(quantity)),
    action: rowAction,
    row: sessionRowPayload(row),
  });

  if (result.ok) {
    invalidatePullCache();
    audit({ type: "sheets.tx_ok", drawerId: drawer.id, detail: `${row.action} ${quantity}` });
    return true;
  }

  // Older script without the combined endpoint — do the two writes in parallel.
  if (result.error === "unknown_type") {
    const [qtyOk] = await Promise.all([
      setSheetQuantity(drawer, quantity),
      logSessionRow(row, rowAction),
    ]);
    return qtyOk;
  }

  audit({ type: "sheets.tx_error", drawerId: drawer.id, detail: result.error ?? "failed" });
  return false;
}

/**
 * Lock/unlock in one request: patch Is Locked + write the session row together.
 * Falls back to the legacy pair of calls if the deployed script lacks `lock_tx`.
 */
export async function setSheetLockEvent(
  drawer: Drawer,
  locked: boolean,
  row: SessionRow,
  rowAction: "append" | "update" = "append",
): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  const number = drawerNumber(drawer);
  if (!number) return false;

  const result = await postResult({
    secret: SECRET,
    type: "lock_tx",
    number,
    locked: Boolean(locked),
    action: rowAction,
    row: sessionRowPayload(row),
  });

  if (result.ok) {
    invalidatePullCache();
    audit({
      type: "sheets.lock_tx_ok",
      drawerId: drawer.id,
      detail: `${row.action} ${locked ? "locked" : "unlocked"}`,
    });
    return true;
  }

  if (result.error === "unknown_type") {
    const [lockOk] = await Promise.all([
      setSheetLocked(drawer, locked),
      logSessionRow(row, rowAction),
    ]);
    return lockOk;
  }

  audit({
    type: "sheets.lock_tx_error",
    drawerId: drawer.id,
    detail: result.error ?? "failed",
  });
  return false;
}

/** Patch Is Locked for one drawer only — does not rewrite Part or Quantity. */
export async function setSheetLocked(
  drawer: Drawer,
  locked: boolean,
): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  const number = drawerNumber(drawer);
  if (!number) return false;

  const ok = await postOk({
    secret: SECRET,
    type: "set_locked",
    number,
    locked: Boolean(locked),
  });
  if (!ok) {
    audit({
      type: "sheets.lock_error",
      drawerId: drawer.id,
      detail: locked ? "locked" : "unlocked",
    });
    return false;
  }
  invalidatePullCache();
  audit({
    type: "sheets.lock_ok",
    drawerId: drawer.id,
    detail: locked ? "locked" : "unlocked",
  });
  return true;
}

/** Refresh from sheet (UI Sync button). Never pushes inventory rows. */
export async function syncSheet(): Promise<{
  ok: boolean;
  error?: string;
  count?: number;
  parts?: string[];
  photos?: number;
  imageCol?: number | null;
}> {
  if (!sheetsEnabled()) return { ok: false, error: "not_configured" };
  const result = await pullStockFromSheets({
    force: true,
    timeoutMs: 45000,
    includePhotos: true,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "pull_failed" };

  const parts = [...db.drawers.values()]
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    .map((d) => {
      const item = db.items.get(d.itemId);
      return `${d.label}: ${item?.name ?? "?"}`;
    });

  const photos = [...db.drawers.values()].filter((d) => {
    const item = db.items.get(d.itemId);
    return Boolean(item?.photo?.trim());
  }).length;

  return {
    ok: true,
    count: result.count ?? parts.length,
    parts,
    photos: result.photos ?? photos,
    imageCol: result.imageCol ?? null,
  };
}

export function sheetsEnabled(): boolean {
  return Boolean(WEBHOOK_URL && SECRET);
}

/** True when this isolate already has a recent successful inventory pull. */
export function sheetsCacheFresh(): boolean {
  return lastPullOk && Date.now() - lastPullAt < PULL_CACHE_MS;
}

export function sheetsCacheAgeMs(): number | null {
  if (!lastPullOk || !lastPullAt) return null;
  return Date.now() - lastPullAt;
}
