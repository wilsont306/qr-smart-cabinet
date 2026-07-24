import { NextResponse } from "next/server";
import { after } from "next/server";
import { audit, db, seed } from "@/lib/store";
import { LIMITS, canAccessDrawer } from "@/lib/security";
import { currentSession } from "@/lib/session";
import { drawerView } from "@/lib/dto";
import {
  noteLocalLock,
  pingSheets,
  setSheetLockEvent,
  setSheetLocked,
  sheetsEnabled,
} from "@/lib/sheets";

// POST /api/drawers/{id}/lock — physical lock (no stock mutation).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  seed();
  const { id: raw } = await params;
  const visit = await currentSession();
  if (!visit) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const user = visit.user;
  if (!visit.trackerSessionId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const key = decodeURIComponent(raw).trim();
  const drawerId =
    db.drawers.get(key)?.id ?? db.drawersByShortCode.get(key.toUpperCase());
  const drawer = drawerId ? db.drawers.get(drawerId) : undefined;
  if (!drawer || !canAccessDrawer(user.id, drawer.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (sheetsEnabled()) void pingSheets();

  const stock = db.stock.get(drawer.id)!;
  const item = db.items.get(drawer.itemId);
  const partName = item?.name ?? drawer.itemId;
  const openSessionId = db.openDrawer.get(drawer.id);
  if (!openSessionId) {
    // Already locked in-app — still mirror Is Locked onto the inventory sheet.
    noteLocalLock(drawer.id, true);
    after(() => {
      void setSheetLocked(drawer, true);
    });
    return NextResponse.json({ ok: true, locked: true, drawer: drawerView(drawer, stock) });
  }

  const unlockSession = db.unlockSessions.get(openSessionId);
  if (unlockSession && unlockSession.userId !== user.id) {
    return NextResponse.json({ error: "not_open" }, { status: 409 });
  }

  db.openDrawer.delete(drawer.id);
  noteLocalLock(drawer.id, true);
  db.drawerCooldown.set(drawer.id, Date.now() + LIMITS.drawerCooldownMs);
  if (unlockSession) {
    unlockSession.closedAt = Date.now();
    unlockSession.outcome = "closed";
  }
  audit({ type: "lock.relocked_by_user", userId: user.id, drawerId: drawer.id });

  const qtyLogged = unlockSession?.quantity || 0;
  after(() => {
    void setSheetLockEvent(
      drawer,
      true,
      {
        name: visit.displayName,
        sessionId: visit.trackerSessionId!,
        action: "Lock",
        part: partName,
        shelf: drawer.label,
        quantity: qtyLogged,
        locked: true,
        teamNumber: visit.teamNumber,
        roboticsLevel: visit.roboticsLevel,
      },
      "update",
    );
  });

  return NextResponse.json({ ok: true, locked: true, drawer: drawerView(drawer, stock) });
}
