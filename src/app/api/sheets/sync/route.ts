import { NextResponse } from "next/server";
import { after } from "next/server";
import { db, seed } from "@/lib/store";
import { LIMITS, canAccessDrawer, clientIp, rateLimit } from "@/lib/security";
import { currentUser } from "@/lib/session";
import { drawerView } from "@/lib/dto";
import { pullStockFromSheets, sheetsEnabled, syncSheet } from "@/lib/sheets";

// POST /api/sheets/sync — re-read inventory from Google Sheets (never overwrite).
// Soft-fails with HTTP 200 so the UI can still refresh drawer cards locally.
export async function POST(req: Request) {
  seed();

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const gate = rateLimit(
    `sheets_pull:${user.id}:${clientIp(req)}`,
    LIMITS.sheetsPull.limit,
    LIMITS.sheetsPull.windowMs,
  );
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  if (!sheetsEnabled()) {
    return NextResponse.json({ ok: false, error: "not_configured" });
  }

  const result = await syncSheet();
  const drawers = [...db.drawers.values()]
    .filter((d) => canAccessDrawer(user.id, d.id))
    .map((d) => drawerView(d, db.stock.get(d.id)!))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  // Optional CellImage conversion — don't block the Refresh button on Apps Script.
  if (result.ok && (result.photos ?? 0) === 0) {
    after(() => {
      void pullStockFromSheets({
        force: true,
        timeoutMs: 25000,
        includePhotos: true,
      });
    });
  }

  return NextResponse.json({ ...result, drawers });
}
