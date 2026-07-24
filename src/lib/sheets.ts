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

/** Same idea for Quantity — rapid takes must not lose to a stale inventory pull. */
const recentStockHold = new Map<string, { quantity: number; until: number }>();

/**
 * Serialize Apps Script writes per drawer on this isolate. Different drawers
 * can write in parallel; unlock→take on the same drawer stays ordered.
 */
const sheetWriteTails = new Map<string, Promise<void>>();
let lastWarmAt = 0;

function enqueueSheetWrite(
  key: string,
  task: () => Promise<void>,
): Promise<void> {
  const prev = sheetWriteTails.get(key) ?? Promise.resolve();
  const run = prev.then(task, task).then(
    () => undefined,
    () => undefined,
  );
  sheetWriteTails.set(key, run);
  return run;
}

/** Nudge Apps Script awake before a mutation when it's been idle. */
function warmSheetsIfIdle(): void {
  if (Date.now() - lastWarmAt < 45_000) return;
  lastWarmAt = Date.now();
  void pingSheets();
}

export function noteLocalLock(drawerId: string, locked: boolean) {
  recentLockHold.set(drawerId, { locked, until: Date.now() + LOCK_HOLD_MS });
}

export function noteLocalStock(drawerId: string, quantity: number) {
  recentStockHold.set(drawerId, {
    quantity: Math.max(0, Math.floor(quantity)),
    until: Date.now() + LOCK_HOLD_MS,
  });
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
    try {
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

      return res;
    } finally {
      clearTimeout(timer);
    }
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
  opts?: { timeoutMs?: number; retries?: number },
): Promise<{ ok: boolean; error?: string }> {
  // Keep writes snappy — long waits made the sheet feel "stuck" after takes.
  const retries = opts?.retries ?? 1;
  const timeoutMs = opts?.timeoutMs ?? 12000;
  let lastError = "fetch_failed";

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    const res = await postToSheets(payload, { timeoutMs });
    if (!res) {
      lastError = "fetch_failed";
      continue;
    }
    try {
      const text = await res.text();
      const body = parseSheetsJson(text) as { error?: string; ok?: boolean };
      if (body?.error && body.error !== "snapshot_disabled") {
        lastError = body.error;
        // Lock contention / brief Apps Script blip — worth retrying.
        if (/sheet_busy|timed out|timeout|service timed out/i.test(body.error)) {
          continue;
        }
        return { ok: false, error: body.error };
      }
      if (res.ok || res.status === 200) {
        lastWarmAt = Date.now();
        return { ok: true };
      }
      lastError = `http_${res.status}`;
    } catch {
      lastError = "invalid_json";
    }
  }

  return { ok: false, error: lastError };
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

async function postSessionRow(
  row: SessionRow,
  action: "append" | "update" = "append",
): Promise<boolean> {
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
    return false;
  }
  audit({
    type: "sheets.session_ok",
    detail: `${action} ${row.action} ${row.sessionId}`,
  });
  return true;
}

export async function logSessionRow(
  row: SessionRow,
  action: "append" | "update" = "append",
): Promise<void> {
  if (!sheetsEnabled()) return;
  await enqueueSheetWrite(row.shelf || "session", async () => {
    warmSheetsIfIdle();
    await postSessionRow(row, action);
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

/** Tiny Apps Script round-trip — keeps the Web App warm while someone is using the cabinet. */
export async function pingSheets(): Promise<{ ok: boolean; error?: string; ms: number }> {
  if (!sheetsEnabled()) return { ok: false, error: "not_configured", ms: 0 };
  const started = Date.now();
  const res = await postToSheets(
    { secret: SECRET, type: "ping" },
    { timeoutMs: 8000 },
  );
  if (!res) return { ok: false, error: "fetch_failed", ms: Date.now() - started };
  return { ok: true, ms: Date.now() - started };
}

/** Lightweight ping used by cron to keep Apps Script warm. */
export async function warmSheets(): Promise<{ ok: boolean; error?: string; ms: number }> {
  if (!sheetsEnabled()) return { ok: false, error: "not_configured", ms: 0 };
  const started = Date.now();
  // Prefer a real light inventory so this isolate also has fresh stock cached.
  const result = await pullStockFromSheets({ force: true, timeoutMs: 25000 });
  if (!result.ok) {
    // Fall back to a tiny ping so the script process stays awake.
    const ping = await pingSheets();
    if (!ping.ok) {
      return { ok: false, error: result.error ?? ping.error ?? "fetch_failed", ms: Date.now() - started };
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
    const stockHold = recentStockHold.get(drawer.id);
    if (stockHold && Date.now() < stockHold.until) {
      // Keep post-mutation quantity until the sheet write catches up.
      if (stock.quantity !== stockHold.quantity) {
        stock.quantity = stockHold.quantity;
        stock.version += 1;
      }
    } else if (stock.quantity !== qty) {
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
  return enqueueSheetWrite(drawer.id, async () => {
    warmSheetsIfIdle();
    const number = drawerNumber(drawer);
    if (!number) return;
    const live = db.stock.get(drawer.id)?.quantity ?? quantity;
    const qty = Math.max(0, Math.floor(live));

    const ok = await postOk({
      secret: SECRET,
      type: "set_quantity",
      number,
      quantity: qty,
    });
    if (!ok) {
      audit({ type: "sheets.qty_error", drawerId: drawer.id, detail: String(qty) });
      return;
    }
    invalidatePullCache();
    audit({ type: "sheets.qty_ok", drawerId: drawer.id, detail: String(qty) });
  }).then(() => true);
}

/**
 * Take/return in one request: patch Quantity + write the session row together.
 * Halves the Apps Script round-trips vs. two separate posts. Falls back to the
 * legacy pair of calls if the deployed script predates the combined `tx` type.
 * Queued so rapid takes can't last-write-win with a stale quantity.
 */
export async function setSheetTransaction(
  drawer: Drawer,
  quantity: number,
  row: SessionRow,
  rowAction: "append" | "update" = "append",
): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  return enqueueSheetWrite(drawer.id, async () => {
    warmSheetsIfIdle();
    const number = drawerNumber(drawer);
    if (!number) return;

    // Always mirror the latest in-memory stock — earlier queued writes may be stale.
    const liveQty = db.stock.get(drawer.id)?.quantity ?? quantity;
    const qty = Math.max(0, Math.floor(liveQty));
    const locked = !db.openDrawer.has(drawer.id);
    const liveRow: SessionRow = { ...row, locked };

    const result = await postResult({
      secret: SECRET,
      type: "tx",
      number,
      quantity: qty,
      action: rowAction,
      row: sessionRowPayload(liveRow),
    });

    if (result.ok) {
      invalidatePullCache();
      audit({ type: "sheets.tx_ok", drawerId: drawer.id, detail: `${row.action} ${qty}` });
      return;
    }

    if (result.error === "unknown_type") {
      await Promise.all([
        postOk({
          secret: SECRET,
          type: "set_quantity",
          number,
          quantity: qty,
        }),
        postSessionRow(liveRow, rowAction),
      ]);
      invalidatePullCache();
      return;
    }

    audit({ type: "sheets.tx_error", drawerId: drawer.id, detail: result.error ?? "failed" });
  }).then(() => true);
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
  return enqueueSheetWrite(drawer.id, async () => {
    warmSheetsIfIdle();
    const number = drawerNumber(drawer);
    if (!number) return;

    const liveLocked = !db.openDrawer.has(drawer.id);
    const liveRow: SessionRow = { ...row, locked: liveLocked };

    const result = await postResult({
      secret: SECRET,
      type: "lock_tx",
      number,
      locked: liveLocked,
      action: rowAction,
      row: sessionRowPayload(liveRow),
    });

    if (result.ok) {
      invalidatePullCache();
      audit({
        type: "sheets.lock_tx_ok",
        drawerId: drawer.id,
        detail: `${row.action} ${liveLocked ? "locked" : "unlocked"}`,
      });
      return;
    }

    if (result.error === "unknown_type") {
      await Promise.all([
        postOk({
          secret: SECRET,
          type: "set_locked",
          number,
          locked: liveLocked,
        }),
        postSessionRow(liveRow, rowAction),
      ]);
      invalidatePullCache();
      return;
    }

    audit({
      type: "sheets.lock_tx_error",
      drawerId: drawer.id,
      detail: result.error ?? "failed",
    });
  }).then(() => true);
}

/** Patch Is Locked for one drawer only — does not rewrite Part or Quantity. */
export async function setSheetLocked(
  drawer: Drawer,
  locked: boolean,
): Promise<boolean> {
  if (!sheetsEnabled()) return false;
  return enqueueSheetWrite(drawer.id, async () => {
    warmSheetsIfIdle();
    const number = drawerNumber(drawer);
    if (!number) return;
    const liveLocked = !db.openDrawer.has(drawer.id);

    const ok = await postOk({
      secret: SECRET,
      type: "set_locked",
      number,
      locked: liveLocked,
    });
    if (!ok) {
      audit({
        type: "sheets.lock_error",
        drawerId: drawer.id,
        detail: liveLocked ? "locked" : "unlocked",
      });
      return;
    }
    invalidatePullCache();
    audit({
      type: "sheets.lock_ok",
      drawerId: drawer.id,
      detail: liveLocked ? "locked" : "unlocked",
    });
  }).then(() => true);
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
