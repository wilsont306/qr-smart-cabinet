import { NextResponse } from "next/server";
import { db, seed } from "@/lib/store";
import { canAccessDrawer } from "@/lib/security";
import { currentUser } from "@/lib/session";
import { drawerView } from "@/lib/dto";
import { pullStockFromSheets, sheetsEnabled } from "@/lib/sheets";

/**
 * GET /api/sheets/hydrate — force a light inventory pull and return drawers.
 * Used right after check-in so the cabinet opens on sheet data, not seed stock.
 */
export async function GET() {
  seed();

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  if (!sheetsEnabled()) {
    return NextResponse.json({ ok: false, error: "not_configured", drawers: [] });
  }

  const result = await pullStockFromSheets({
    force: true,
    timeoutMs: 20000,
    includePhotos: false,
  });

  const drawers = [...db.drawers.values()]
    .filter((d) => canAccessDrawer(user.id, d.id))
    .map((d) => drawerView(d, db.stock.get(d.id)!))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  return NextResponse.json({
    ok: result.ok,
    error: result.error,
    count: result.count,
    sheetsFresh: result.ok,
    drawers,
  });
}
