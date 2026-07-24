import { NextResponse } from "next/server";
import { audit, db, seed } from "@/lib/store";
import { LIMITS, canAccessDrawer, clientIp, rateLimit } from "@/lib/security";
import { currentSession } from "@/lib/session";
import { drawerView } from "@/lib/dto";
import {
  noteLocalLock,
  ensureSheetInventory,
  setSheetLockEvent,
  setSheetLocked,
  sheetsEnabled,
} from "@/lib/sheets";

// POST /api/drawers/{id}/lock — physical lock (no stock mutation).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  seed();
  const { id: key } = await params;

  const visit = await currentSession();
  if (!visit) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const user = visit.user;

  const gate = rateLimit(
    `lock:${user.id}`,
    LIMITS.unlock.limit,
    LIMITS.unlock.windowMs,
  );
  if (!gate.ok) {
    audit({ type: "lock.rate_limited", userId: user.id, ip: clientIp(req) });
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  if (sheetsEnabled()) {
    await ensureSheetInventory({ timeoutMs: 8000 });
  }

  const drawerId =
    db.drawers.get(key)?.id ?? db.drawersByShortCode.get(key.toUpperCase());
  const drawer = drawerId ? db.drawers.get(drawerId) : undefined;
  if (!drawer || !canAccessDrawer(user.id, drawer.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const stock = db.stock.get(drawer.id)!;
  const item = db.items.get(drawer.itemId);
  const partName = item?.name ?? drawer.itemId;
  const openSessionId = db.openDrawer.get(drawer.id);
  if (!openSessionId) {
    noteLocalLock(drawer.id, true);
    if (sheetsEnabled()) {
      try {
        await setSheetLocked(drawer, true);
      } catch (err) {
        audit({
          type: "sheets.lock_error",
          userId: user.id,
          drawerId: drawer.id,
          detail: String(err),
        });
      }
    }
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
  if (sheetsEnabled()) {
    try {
      await setSheetLockEvent(
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
    } catch (err) {
      audit({
        type: "sheets.lock_tx_error",
        userId: user.id,
        drawerId: drawer.id,
        detail: String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, locked: true, drawer: drawerView(drawer, stock) });
}
