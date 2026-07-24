import crypto from "crypto";

/**
 * Direct Google Sheets API (service account) — typically 200–800ms vs
 * Apps Script Web App cold starts of 5–15s.
 *
 * Required env:
 *   SHEETS_SPREADSHEET_ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 * Or a single JSON blob:
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 *
 * Share the spreadsheet with the service-account email as Editor.
 */

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID?.trim() || "";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

type ColMap = Record<string, number>; // 0-based column index

interface SheetLayout {
  inventoryTitle: string;
  inventorySheetId: number;
  inventoryCols: ColMap;
  inventoryDrawerRow: Map<number, number>; // drawer# → 1-based sheet row
  sessionTitle: string;
  sessionSheetId: number;
  sessionCols: ColMap;
  loadedAt: number;
}

interface SessionWriteRow {
  name: string;
  sessionId: string;
  actionLabel: string;
  part: string;
  shelf: string;
  quantity: number;
  locked: boolean;
  teamNumber?: string;
  roboticsLevel?: string;
  time?: string;
}

let cachedToken: { accessToken: string; exp: number } | null = null;
let cachedLayout: SheetLayout | null = null;
const LAYOUT_TTL_MS = 60_000;

function readServiceAccount(): { email: string; privateKey: string } | null {
  let jsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonRaw) {
    // Vercel / .env pastes often wrap the blob in quotes or double-encode it.
    if (
      (jsonRaw.startsWith('"') && jsonRaw.endsWith('"')) ||
      (jsonRaw.startsWith("'") && jsonRaw.endsWith("'"))
    ) {
      jsonRaw = jsonRaw.slice(1, -1);
    }
    // Some UIs store the whole JSON with escaped quotes.
    if (jsonRaw.includes('\\"') && !jsonRaw.includes('{"')) {
      jsonRaw = jsonRaw.replace(/\\"/g, '"').replace(/\\n/g, "\\n");
    }
    try {
      const parsed = JSON.parse(jsonRaw) as {
        client_email?: string;
        private_key?: string;
      };
      if (parsed.client_email && parsed.private_key) {
        return {
          email: parsed.client_email,
          privateKey: parsed.private_key.replace(/\\n/g, "\n"),
        };
      }
    } catch {
      // try base64-encoded JSON
      try {
        const decoded = Buffer.from(jsonRaw, "base64").toString("utf8");
        const parsed = JSON.parse(decoded) as {
          client_email?: string;
          private_key?: string;
        };
        if (parsed.client_email && parsed.private_key) {
          return {
            email: parsed.client_email,
            privateKey: parsed.private_key.replace(/\\n/g, "\n"),
          };
        }
      } catch {
        // fall through
      }
    }
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n",
  );
  if (email && privateKey) return { email, privateKey };
  return null;
}

export function sheetsApiEnabled(): boolean {
  return Boolean(SPREADSHEET_ID && readServiceAccount());
}

/** Safe diagnostics — never returns key material. */
export async function sheetsApiStatus(): Promise<{
  configured: boolean;
  spreadsheetIdSet: boolean;
  credentialsOk: boolean;
  canConnect: boolean;
  error?: string;
  inventorySheet?: string;
  sessionSheet?: string;
}> {
  const spreadsheetIdSet = Boolean(SPREADSHEET_ID);
  const creds = readServiceAccount();
  if (!spreadsheetIdSet || !creds) {
    return {
      configured: false,
      spreadsheetIdSet,
      credentialsOk: Boolean(creds),
      canConnect: false,
      error: !spreadsheetIdSet
        ? "missing_spreadsheet_id"
        : "missing_or_invalid_service_account_json",
    };
  }
  try {
    const layout = await loadLayout(true);
    return {
      configured: true,
      spreadsheetIdSet: true,
      credentialsOk: true,
      canConnect: true,
      inventorySheet: layout.inventoryTitle,
      sessionSheet: layout.sessionTitle,
    };
  } catch (err) {
    return {
      configured: true,
      spreadsheetIdSet: true,
      credentialsOk: true,
      canConnect: false,
      error: String(err),
    };
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.accessToken;

  const sa = readServiceAccount();
  if (!sa) throw new Error("sheets_api_not_configured");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.email,
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(sa.privateKey).toString("base64url");
  const jwt = `${unsigned}.${sig}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token_http_${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("token_missing");
  cachedToken = {
    accessToken: body.access_token,
    exp: now + (body.expires_in ?? 3600),
  };
  return body.access_token;
}

async function sheetsFetch(
  path: string,
  init?: RequestInit & { query?: Record<string, string> },
): Promise<Response> {
  const token = await getAccessToken();
  const url = new URL(`${API}/${SPREADSHEET_ID}${path}`);
  if (init?.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }
  const { query: _q, ...rest } = init ?? {};
  return fetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(rest.headers ?? {}),
    },
  });
}

function headerKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

function mapInventoryCols(headers: unknown[]): ColMap {
  const col: ColMap = {};
  headers.forEach((h, i) => {
    const key = headerKey(h);
    if (
      key === "drawer" ||
      key === "drawer #" ||
      key === "drawer number" ||
      key === "# drawer" ||
      ((key === "#" || key === "no" || key === "no.") && col.drawer == null)
    ) {
      col.drawer = i;
    } else if (key === "part" || key === "item" || key === "parts" || key === "item name") {
      col.part = i;
    } else if (key === "quantity" || key === "qty" || key === "stock" || key === "count") {
      col.quantity = i;
    } else if (key === "is locked" || key === "locked" || key === "locked?") {
      col.locked = i;
    } else if (
      key === "photo url" ||
      key === "image url" ||
      key === "img url" ||
      key === "picture url"
    ) {
      col.imageUrl = i;
    } else if (
      key === "image" ||
      key === "images" ||
      key === "photo" ||
      key === "photos" ||
      key === "img" ||
      key === "picture"
    ) {
      col.image = i;
    }
  });
  return col;
}

/** Turn =IMAGE("url") / Drive links / https into a browser-friendly photo URL. */
function parsePhotoCell(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^data:image\//i.test(s)) return s;

  const formula = s.match(/^=\s*IMAGE\s*\(\s*["']([^"']+)["']/i);
  const candidate = (formula?.[1] || s).trim();
  if (!candidate) return "";

  const id =
    candidate.match(/[?&]id=([a-zA-Z0-9_-]{20,})/)?.[1] ||
    candidate.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] ||
    candidate.match(/\/d\/([a-zA-Z0-9_-]{20,})(?:\/|$)/)?.[1] ||
    (/^[a-zA-Z0-9_-]{25,}$/.test(candidate) ? candidate : undefined);

  if (id && (/drive\.google\.com|googleusercontent\.com/i.test(candidate) || !/^https?:/i.test(candidate))) {
    return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;
  }
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return "";
}

function mapSessionCols(headers: unknown[]): ColMap {
  const col: ColMap = {};
  headers.forEach((h, i) => {
    const key = headerKey(h);
    if (key === "name") col.name = i;
    else if (key === "time" || key === "timestamp" || key === "when") col.time = i;
    else if (key === "session id" || key === "sessionid") col.sessionId = i;
    else if (key === "action") col.action = i;
    else if (key === "part" || key === "item") col.part = i;
    else if (key === "shelf" || key === "drawer") col.shelf = i;
    else if (key === "quantity" || key === "qty") col.quantity = i;
    else if (key === "locked?" || key === "locked" || key === "is locked") col.locked = i;
    else if (
      key === "team #" ||
      key === "team#" ||
      key === "team" ||
      key === "team number" ||
      key === "team no" ||
      key === "team no."
    ) {
      col.team = i;
    } else if (
      key === "robotics level" ||
      key === "robotics le" ||
      key === "level" ||
      key === "program" ||
      key === "first program"
    ) {
      col.level = i;
    }
  });
  return col;
}

function parseDrawerNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  const m = String(value ?? "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function a1(colIndex: number, row: number): string {
  let n = colIndex + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row}`;
}

function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function formatTime(isoOrEmpty?: string): string {
  const d = isoOrEmpty ? new Date(isoOrEmpty) : new Date();
  if (Number.isNaN(d.getTime())) return formatTime();
  const pad = (n: number) => String(n).padStart(2, "0");
  // America/New_York-ish local wall clock without pulling a TZ lib — use UTC-4/-5 approx via locale
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function loadLayout(force = false): Promise<SheetLayout> {
  if (
    !force &&
    cachedLayout &&
    Date.now() - cachedLayout.loadedAt < LAYOUT_TTL_MS
  ) {
    return cachedLayout;
  }

  const meta = await sheetsFetch("", {
    query: { fields: "sheets.properties(sheetId,title)" },
  });
  if (!meta.ok) throw new Error(`meta_http_${meta.status}`);
  const metaBody = (await meta.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const sheetProps = (metaBody.sheets ?? [])
    .map((s) => s.properties)
    .filter(
      (p): p is { sheetId: number; title: string } =>
        typeof p?.sheetId === "number" && Boolean(p?.title),
    );

  let inventoryTitle = "";
  let inventorySheetId = -1;
  let inventoryCols: ColMap = {};
  let inventoryDrawerRow = new Map<number, number>();
  let sessionTitle = "";
  let sessionSheetId = -1;
  let sessionCols: ColMap = {};

  for (const { title, sheetId } of sheetProps) {
    const res = await sheetsFetch(`/values/${encodeURIComponent(quoteTitle(title))}`, {
      query: { majorDimension: "ROWS" },
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { values?: unknown[][] };
    const values = body.values ?? [];
    if (values.length < 1) continue;
    const headers = values[0] ?? [];
    const headerKeys = headers.map(headerKey);
    const hasSessionId = headerKeys.some(
      (k) => k === "session id" || k === "sessionid",
    );

    const inv = mapInventoryCols(headers);
    if (inv.part != null && inv.quantity != null && !hasSessionId) {
      // Prefer inventory-looking tab names when multiple match.
      const score = /inventory|stock|cabinet|drawer/i.test(title)
        ? 10
        : /session|ledger|log|tracker|activity/i.test(title)
          ? -10
          : 0;
      if (!inventoryTitle || score >= 0) {
        inventoryTitle = title;
        inventorySheetId = sheetId;
        inventoryCols = inv;
        inventoryDrawerRow = new Map();
        for (let i = 1; i < values.length; i++) {
          const n = parseDrawerNumber(
            inv.drawer != null ? values[i][inv.drawer] : i,
          );
          if (n) inventoryDrawerRow.set(n, i + 1); // 1-based sheet row
        }
      }
    }

    const sess = mapSessionCols(headers);
    if (
      sess.name != null &&
      sess.sessionId != null &&
      sess.part != null &&
      sess.quantity != null &&
      sess.locked != null
    ) {
      sessionTitle = title;
      sessionSheetId = sheetId;
      sessionCols = sess;
    }
  }

  if (!inventoryTitle || inventoryCols.quantity == null || inventorySheetId < 0) {
    throw new Error("inventory_sheet_not_found");
  }
  if (!sessionTitle || sessionSheetId < 0) {
    throw new Error("session_sheet_not_found");
  }

  cachedLayout = {
    inventoryTitle,
    inventorySheetId,
    inventoryCols,
    inventoryDrawerRow,
    sessionTitle,
    sessionSheetId,
    sessionCols,
    loadedAt: Date.now(),
  };
  return cachedLayout;
}

async function updateCell(
  sheetTitle: string,
  colIndex: number,
  row: number,
  value: string | number | boolean,
): Promise<void> {
  const range = `${quoteTitle(sheetTitle)}!${a1(colIndex, row)}`;
  const res = await sheetsFetch(`/values/${encodeURIComponent(range)}`, {
    method: "PUT",
    query: { valueInputOption: "USER_ENTERED" },
    body: JSON.stringify({ values: [[value]] }),
  });
  if (!res.ok) throw new Error(`update_http_${res.status}`);
}

export async function apiSetQuantity(
  drawerNumber: number,
  quantity: number,
): Promise<boolean> {
  const layout = await loadLayout();
  const row = layout.inventoryDrawerRow.get(drawerNumber);
  if (!row || layout.inventoryCols.quantity == null) return false;
  await updateCell(
    layout.inventoryTitle,
    layout.inventoryCols.quantity,
    row,
    Math.max(0, Math.floor(quantity)),
  );
  return true;
}

export async function apiSetLocked(
  drawerNumber: number,
  locked: boolean,
): Promise<boolean> {
  const layout = await loadLayout();
  const row = layout.inventoryDrawerRow.get(drawerNumber);
  if (!row || layout.inventoryCols.locked == null) return false;
  await updateCell(
    layout.inventoryTitle,
    layout.inventoryCols.locked,
    row,
    locked,
  );
  try {
    await colorInventoryLocked(
      layout.inventorySheetId,
      row,
      layout.inventoryCols.locked,
      locked,
    );
  } catch {
    // Value write succeeded; coloring is best-effort.
  }
  return true;
}

function hexColor(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace("#", "").trim();
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function actionColors(actionLabel: string): {
  row: string;
  action: string;
  text: string;
} {
  const a = String(actionLabel || "").trim();
  if (a === "Take" || a === "Unlock + Take" || a === "Take + Lock") {
    return { row: "#FCE8E6", action: "#EA4335", text: "#FFFFFF" };
  }
  if (a === "Return" || a === "Unlock + Return" || a === "Return + Lock") {
    return { row: "#E6F4EA", action: "#34A853", text: "#FFFFFF" };
  }
  if (a === "Unlock") {
    return { row: "#E8F0FE", action: "#1A73E8", text: "#FFFFFF" };
  }
  if (a === "Lock") {
    return { row: "#F1F3F4", action: "#5F6368", text: "#FFFFFF" };
  }
  return { row: "#FFFFFF", action: "#E8EAED", text: "#202124" };
}

function cellFormatRequest(
  sheetId: number,
  row1Based: number,
  col0Based: number,
  background: string,
  fontColor?: string,
  bold?: boolean,
) {
  const format: Record<string, unknown> = {
    backgroundColor: hexColor(background),
  };
  if (fontColor) format.textFormat = { foregroundColor: hexColor(fontColor), bold: Boolean(bold) };
  else if (bold) format.textFormat = { bold: true };
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: row1Based - 1,
        endRowIndex: row1Based,
        startColumnIndex: col0Based,
        endColumnIndex: col0Based + 1,
      },
      cell: { userEnteredFormat: format },
      fields: fontColor || bold
        ? "userEnteredFormat(backgroundColor,textFormat)"
        : "userEnteredFormat.backgroundColor",
    },
  };
}

async function colorSessionRow(
  layout: SheetLayout,
  sheetRow: number,
  actionLabel: string,
  locked: boolean,
): Promise<void> {
  const cols = layout.sessionCols;
  const width = Math.max(...Object.values(cols), 0) + 1;
  const colors = actionColors(actionLabel);
  const requests: unknown[] = [
    {
      repeatCell: {
        range: {
          sheetId: layout.sessionSheetId,
          startRowIndex: sheetRow - 1,
          endRowIndex: sheetRow,
          startColumnIndex: 0,
          endColumnIndex: width,
        },
        cell: {
          userEnteredFormat: { backgroundColor: hexColor(colors.row) },
        },
        fields: "userEnteredFormat.backgroundColor",
      },
    },
  ];
  if (cols.action != null) {
    requests.push(
      cellFormatRequest(
        layout.sessionSheetId,
        sheetRow,
        cols.action,
        colors.action,
        colors.text,
        true,
      ),
    );
  }
  if (cols.locked != null) {
    requests.push(
      cellFormatRequest(
        layout.sessionSheetId,
        sheetRow,
        cols.locked,
        locked ? "#5F6368" : "#34A853",
        "#FFFFFF",
        true,
      ),
    );
  }
  if (cols.quantity != null) {
    requests.push(
      cellFormatRequest(
        layout.sessionSheetId,
        sheetRow,
        cols.quantity,
        colors.row,
        undefined,
        true,
      ),
    );
  }
  const res = await sheetsFetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`color_session_http_${res.status}`);
}

async function colorInventoryLocked(
  sheetId: number,
  row1Based: number,
  col0Based: number,
  locked: boolean,
): Promise<void> {
  const res = await sheetsFetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [
        cellFormatRequest(
          sheetId,
          row1Based,
          col0Based,
          locked ? "#5F6368" : "#34A853",
          "#FFFFFF",
          true,
        ),
      ],
    }),
  });
  if (!res.ok) throw new Error(`color_lock_http_${res.status}`);
}

function mergeAction(existing: string, incoming: string): string {
  const prev = existing.trim();
  const next = incoming.trim();
  if (!next) return prev;
  if (!prev) return next;
  // First take/return after Unlock replaces the Unlock label (keep one row).
  if (prev === "Unlock") {
    if (next === "Take" || next === "Unlock + Take") return "Take";
    if (next === "Return" || next === "Unlock + Return") return "Return";
  }
  if (next === "Lock") {
    if (prev === "Take" || prev === "Unlock + Take") return "Take + Lock";
    if (prev === "Return" || prev === "Unlock + Return") return "Return + Lock";
    if (prev.includes("Lock")) return prev;
    return "Lock";
  }
  return next;
}

function buildSessionArray(
  cols: ColMap,
  width: number,
  row: SessionWriteRow,
  existing?: unknown[],
): unknown[] {
  const arr = existing ? existing.slice() : Array.from({ length: width }, () => "");
  while (arr.length < width) arr.push("");
  if (cols.name != null) arr[cols.name] = row.name || "";
  if (cols.time != null && !arr[cols.time]) arr[cols.time] = formatTime(row.time);
  if (cols.sessionId != null) arr[cols.sessionId] = row.sessionId || "";
  if (cols.action != null) {
    const prev = String(arr[cols.action] ?? "");
    arr[cols.action] = existing
      ? mergeAction(prev, row.actionLabel || "")
      : row.actionLabel || "";
  }
  if (cols.part != null) arr[cols.part] = row.part || "";
  if (cols.shelf != null) arr[cols.shelf] = row.shelf || "";
  if (cols.quantity != null && (row.quantity || !existing)) {
    arr[cols.quantity] = row.quantity || 0;
  }
  if (cols.locked != null) arr[cols.locked] = !!row.locked;
  if (cols.team != null && row.teamNumber) arr[cols.team] = row.teamNumber;
  if (cols.level != null && row.roboticsLevel) arr[cols.level] = row.roboticsLevel;
  return arr;
}

export async function apiAppendSession(row: SessionWriteRow): Promise<boolean> {
  const layout = await loadLayout();
  const cols = layout.sessionCols;
  const width = Math.max(...Object.values(cols), 0) + 1;
  const values = [buildSessionArray(cols, width, row)];

  // Insert under the header so newest activity is at the top of Table2.
  const insert = await sheetsFetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: layout.sessionSheetId,
              dimension: "ROWS",
              startIndex: 1,
              endIndex: 2,
            },
            inheritFromBefore: false,
          },
        },
      ],
    }),
  });
  if (!insert.ok) throw new Error(`insert_row_http_${insert.status}`);

  const range = `${quoteTitle(layout.sessionTitle)}!A2:${a1(width - 1, 2)}`;
  const res = await sheetsFetch(`/values/${encodeURIComponent(range)}`, {
    method: "PUT",
    query: { valueInputOption: "USER_ENTERED" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`prepend_http_${res.status}`);
  try {
    const finalAction =
      cols.action != null
        ? String(values[0][cols.action] ?? row.actionLabel)
        : row.actionLabel;
    await colorSessionRow(layout, 2, finalAction, !!row.locked);
  } catch {
    // Values landed; colors are best-effort.
  }
  return true;
}

export async function apiUpdateSession(row: SessionWriteRow): Promise<boolean> {
  const layout = await loadLayout();
  const cols = layout.sessionCols;
  // Newest rows sit under the header — scan the top of the tracker.
  const res = await sheetsFetch(
    `/values/${encodeURIComponent(quoteTitle(layout.sessionTitle))}!A1:Z81`,
    { query: { majorDimension: "ROWS" } },
  );
  if (!res.ok) throw new Error(`session_read_http_${res.status}`);
  const body = (await res.json()) as { values?: unknown[][] };
  const values = body.values ?? [];
  if (values.length < 2) return apiAppendSession(row);

  const incoming = (row.actionLabel || "").trim();
  const data = values.slice(1);
  let found = -1;
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const sameSession =
      cols.sessionId != null &&
      String(r[cols.sessionId] ?? "") === String(row.sessionId);
    const samePart =
      cols.part == null || String(r[cols.part] ?? "") === String(row.part || "");
    if (!sameSession || !samePart) continue;

    const prev =
      cols.action != null ? String(r[cols.action] ?? "").trim() : "";
    // Lock folds into the open unlock/take row. Extra takes/returns always
    // get a new line — only a bare Unlock row absorbs the first take/return.
    if (incoming === "Lock" || incoming.includes("+ Lock") || incoming.endsWith("Lock")) {
      found = i;
      break;
    }
    if (prev === "Unlock" || prev === "") {
      found = i;
      break;
    }
  }

  if (found < 0) return apiAppendSession(row);

  const sheetRow = found + 2; // header + 1-based
  const width = Math.max(values[0]?.length ?? 0, Math.max(...Object.values(cols), 0) + 1);
  const next = buildSessionArray(cols, width, row, data[found]);
  const range = `${quoteTitle(layout.sessionTitle)}!A${sheetRow}:${a1(width - 1, sheetRow)}`;
  const put = await sheetsFetch(`/values/${encodeURIComponent(range)}`, {
    method: "PUT",
    query: { valueInputOption: "USER_ENTERED" },
    body: JSON.stringify({ values: [next] }),
  });
  if (!put.ok) throw new Error(`session_update_http_${put.status}`);
  try {
    const finalAction =
      cols.action != null
        ? String(next[cols.action] ?? row.actionLabel)
        : row.actionLabel;
    const finalLocked =
      cols.locked != null ? Boolean(next[cols.locked]) : !!row.locked;
    await colorSessionRow(layout, sheetRow, finalAction, finalLocked);
  } catch {
    // Values landed; colors are best-effort.
  }
  return true;
}

export async function apiTx(
  drawerNumber: number,
  quantity: number,
  row: SessionWriteRow,
  rowAction: "append" | "update",
): Promise<boolean> {
  await apiSetQuantity(drawerNumber, quantity);
  if (rowAction === "update") await apiUpdateSession(row);
  else await apiAppendSession(row);
  return true;
}

export async function apiLockTx(
  drawerNumber: number,
  locked: boolean,
  row: SessionWriteRow,
  rowAction: "append" | "update",
): Promise<boolean> {
  await apiSetLocked(drawerNumber, locked);
  if (rowAction === "update") await apiUpdateSession(row);
  else await apiAppendSession(row);
  return true;
}

export async function apiPing(): Promise<boolean> {
  const res = await sheetsFetch("", {
    query: { fields: "spreadsheetId" },
  });
  return res.ok;
}

/** Inventory pull via Sheets API (qty/lock + Image/=IMAGE URLs when present). */
export async function apiPullInventory(): Promise<
  | {
      ok: true;
      drawers: {
        number: number;
        part: string;
        quantity: number;
        locked: boolean;
        photo?: string;
      }[];
      photos: number;
      imageCol: number | null;
    }
  | { ok: false; error: string }
> {
  try {
    const layout = await loadLayout(true);
    const cols = layout.inventoryCols;
    const hasImageCol = cols.image != null || cols.imageUrl != null;

    // FORMULA render so =IMAGE("https://...") comes through as text.
    const res = await sheetsFetch(
      `/values/${encodeURIComponent(quoteTitle(layout.inventoryTitle))}`,
      {
        query: {
          majorDimension: "ROWS",
          ...(hasImageCol ? { valueRenderOption: "FORMULA" } : {}),
        },
      },
    );
    if (!res.ok) return { ok: false, error: `pull_http_${res.status}` };
    const body = (await res.json()) as { values?: unknown[][] };
    const values = body.values ?? [];
    const drawers: {
      number: number;
      part: string;
      quantity: number;
      locked: boolean;
      photo?: string;
    }[] = [];
    const drawerRows = new Map<number, number>();
    let photos = 0;

    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      const number = parseDrawerNumber(
        cols.drawer != null ? r[cols.drawer] : i,
      );
      if (!number) continue;
      const part = cols.part != null ? String(r[cols.part] ?? "").trim() : "";
      const rawQty = cols.quantity != null ? r[cols.quantity] : 0;
      const quantity = Math.max(
        0,
        Math.floor(Number(String(rawQty).replace(/,/g, "")) || 0),
      );
      let locked = true;
      if (cols.locked != null) {
        const raw = r[cols.locked];
        if (typeof raw === "boolean") locked = raw;
        else {
          const s = String(raw ?? "")
            .trim()
            .toLowerCase();
          locked = !(
            s === "false" ||
            s === "0" ||
            s === "no" ||
            s === "unlocked" ||
            s === ""
          );
        }
      }

      let photo = "";
      if (cols.imageUrl != null) {
        photo = parsePhotoCell(r[cols.imageUrl]);
      }
      if (!photo && cols.image != null) {
        photo = parsePhotoCell(r[cols.image]);
      }
      if (photo) photos++;

      drawers.push({
        number,
        part,
        quantity,
        locked,
        ...(photo ? { photo } : {}),
      });
      drawerRows.set(number, i + 1);
    }

    layout.inventoryDrawerRow = drawerRows;
    layout.loadedAt = Date.now();
    cachedLayout = layout;

    return {
      ok: true,
      drawers,
      photos,
      imageCol:
        cols.image != null
          ? cols.image + 1
          : cols.imageUrl != null
            ? cols.imageUrl + 1
            : null,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
