import { NextResponse } from "next/server";
import { after } from "next/server";
import { audit, db, id as newId, seed } from "@/lib/store";
import {
  LIMITS,
  canAccessDrawer,
  clientIp,
  getIdempotent,
  rateLimit,
  saveIdempotent,
} from "@/lib/security";
import { currentSession } from "@/lib/session";
import { drawerView } from "@/lib/dto";
import { deviceOpen, issueUnlockCommand } from "@/lib/lock";
import {
  noteLocalLock,
  pingSheets,
  setSheetLockEvent,
  setSheetLocked,
  sheetsEnabled,
} from "@/lib/sheets";

interface Body {
  idempotencyKey?: unknown;
}

// POST /api/drawers/{id}/unlock — physical unlock only (no stock mutation).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  seed();
  const { id: raw } = await params;
  const ip = clientIp(req);

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const user = session.user;
  if (!session.trackerSessionId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine if idempotency key is omitted — require it below
  }

  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return NextResponse.json({ error: "missing_idempotency_key" }, { status: 400 });
  }

  const prior = getIdempotent(user.id, idempotencyKey);
  if (prior) return NextResponse.json(prior);

  const gate = rateLimit(`unlock:${user.id}`, LIMITS.unlock.limit, LIMITS.unlock.windowMs);
  if (!gate.ok) {
    audit({ type: "unlock.rate_limited", userId: user.id, ip });
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  const key = decodeURIComponent(raw).trim();
  const drawerId =
    db.drawers.get(key)?.id ?? db.drawersByShortCode.get(key.toUpperCase());
  const drawer = drawerId ? db.drawers.get(drawerId) : undefined;
  if (!drawer || !canAccessDrawer(user.id, drawer.id)) {
    audit({ type: "unlock.denied_authz", userId: user.id, ip, detail: key });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (drawer.status !== "active") {
    return NextResponse.json({ error: "drawer_disabled" }, { status: 409 });
  }

  // Don't block unlock on Sheets — stock/authz use in-memory SoT.
  // Never pull inventory here: a stale pull racing a take/lock overwrites qty.
  if (sheetsEnabled()) void pingSheets();

  if (db.openDrawer.has(drawer.id)) {
    const stock = db.stock.get(drawer.id)!;
    noteLocalLock(drawer.id, false);
    after(() => {
      void setSheetLocked(drawer, false);
    });
    const payload = { ok: true, locked: false, drawer: drawerView(drawer, stock) };
    saveIdempotent(user.id, idempotencyKey, payload);
    return NextResponse.json(payload);
  }

  const cooldownUntil = db.drawerCooldown.get(drawer.id) ?? 0;
  if (cooldownUntil > Date.now()) {
    return NextResponse.json(
      { error: "cooldown" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((cooldownUntil - Date.now()) / 1000)) },
      },
    );
  }

  const cmd = issueUnlockCommand(drawer.id);
  const result = deviceOpen(cmd);
  if (!result.opened) {
    audit({ type: "unlock.lock_error", userId: user.id, drawerId: drawer.id, detail: result.reason });
    return NextResponse.json({ error: "lock_error" }, { status: 502 });
  }

  const now = Date.now();
  const unlockSessionId = newId();
  db.unlockSessions.set(unlockSessionId, {
    id: unlockSessionId,
    userId: user.id,
    drawerId: drawer.id,
    requestedAt: now,
    grantedAt: now,
    openedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    outcome: "opened",
    quantity: 0,
    intent: "take",
  });
  db.openDrawer.set(drawer.id, unlockSessionId);
  noteLocalLock(drawer.id, false);

  const item = db.items.get(drawer.itemId);
  const partName = item?.name ?? drawer.itemId;

  audit({ type: "unlock.granted", userId: user.id, drawerId: drawer.id, detail: "physical" });

  const stock = db.stock.get(drawer.id)!;
  const payload = { ok: true, locked: false, drawer: drawerView(drawer, stock) };
  saveIdempotent(user.id, idempotencyKey, payload);

  const trackerName = session.displayName;
  const trackerSessionId = session.trackerSessionId;
  after(() => {
    void setSheetLockEvent(drawer, false, {
      name: trackerName,
      sessionId: trackerSessionId,
      action: "Unlock",
      part: partName,
      shelf: drawer.label,
      quantity: 0,
      locked: false,
      teamNumber: session.teamNumber,
      roboticsLevel: session.roboticsLevel,
    });
  });

  return NextResponse.json(payload);
}
