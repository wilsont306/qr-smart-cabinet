import { NextResponse } from "next/server";
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
import {
  noteLocalStock,
  setSheetTransaction,
  sheetsEnabled,
} from "@/lib/sheets";
import type { Intent, Transaction } from "@/lib/types";

interface Body {
  quantity?: unknown;
  intent?: unknown;
  idempotencyKey?: unknown;
  stockVersion?: unknown;
}

// POST /api/drawers/{id}/transaction — take/return stock only (no lock hardware).
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
  const trackerName = session.displayName;
  const trackerSessionId = session.trackerSessionId;
  if (!trackerSessionId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const quantity = body.quantity;
  const intent = body.intent as Intent;
  const idempotencyKey = body.idempotencyKey;

  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10_000
  ) {
    return NextResponse.json({ error: "invalid_quantity" }, { status: 400 });
  }
  if (intent !== "take" && intent !== "return") {
    return NextResponse.json({ error: "invalid_intent" }, { status: 400 });
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return NextResponse.json({ error: "missing_idempotency_key" }, { status: 400 });
  }

  const prior = getIdempotent(user.id, idempotencyKey);
  if (prior) return NextResponse.json(prior);

  const gate = rateLimit(`tx:${user.id}`, LIMITS.unlock.limit, LIMITS.unlock.windowMs);
  if (!gate.ok) {
    audit({ type: "transaction.rate_limited", userId: user.id, ip });
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
    audit({ type: "transaction.denied_authz", userId: user.id, ip, detail: key });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (drawer.status !== "active") {
    return NextResponse.json({ error: "drawer_disabled" }, { status: 409 });
  }

  // Never pull inventory mid-mutation: that races quantity/lock writes.
  const stock = db.stock.get(drawer.id)!;

  // Version skew across Fluid isolates is expected with the in-memory store.
  // Still enforce real stock; don't 409 on a stale counter alone.
  if (
    typeof body.stockVersion === "number" &&
    body.stockVersion !== stock.version
  ) {
    audit({
      type: "transaction.version_skew",
      userId: user.id,
      drawerId: drawer.id,
      detail: `client_${body.stockVersion} server_${stock.version}`,
    });
  }

  const delta = intent === "take" ? -quantity : quantity;
  if (intent === "take" && quantity > stock.quantity) {
    return NextResponse.json(
      { error: "insufficient_stock", drawer: drawerView(drawer, stock) },
      { status: 409 },
    );
  }

  const now = Date.now();
  stock.quantity += delta;
  stock.version += 1;
  noteLocalStock(drawer.id, stock.quantity);

  const ledgerSessionId = newId();
  db.unlockSessions.set(ledgerSessionId, {
    id: ledgerSessionId,
    userId: user.id,
    drawerId: drawer.id,
    requestedAt: now,
    grantedAt: now,
    openedAt: now,
    closedAt: now,
    expiresAt: now,
    outcome: "closed",
    quantity,
    intent,
  });

  const tx: Transaction = {
    id: newId(),
    userId: user.id,
    drawerId: drawer.id,
    itemId: drawer.itemId,
    delta,
    balanceAfter: stock.quantity,
    intent,
    unlockSessionId: ledgerSessionId,
    createdAt: now,
  };
  db.transactions.push(tx);

  const item = db.items.get(drawer.itemId);
  const partName = item?.name ?? drawer.itemId;
  const drawerOpen = db.openDrawer.has(drawer.id);
  const action =
    drawerOpen
      ? intent === "take"
        ? "Unlock + Take"
        : "Unlock + Return"
      : intent === "take"
        ? "Take"
        : "Return";

  audit({
    type: "transaction.recorded",
    userId: user.id,
    drawerId: drawer.id,
    detail: `${intent} ${quantity}`,
  });

  const payload = {
    transaction: {
      id: tx.id,
      delta: tx.delta,
      intent: tx.intent,
      balanceAfter: tx.balanceAfter,
      createdAt: tx.createdAt,
    },
    drawer: drawerView(drawer, stock),
  };
  saveIdempotent(user.id, idempotencyKey, payload);

  // Mirror to the sheet before responding so Vercel can't freeze the isolate
  // mid-write. Sheets API is typically 200–800ms; Apps Script may be slower.
  // If the drawer is already open, UPDATE the Unlock row → "Unlock + Take/Return"
  // instead of appending a second tracker line.
  const qtyAfter = stock.quantity;
  const sessionAction: "append" | "update" = drawerOpen ? "update" : "append";
  if (sheetsEnabled()) {
    try {
      await setSheetTransaction(
        drawer,
        qtyAfter,
        {
          name: trackerName,
          sessionId: trackerSessionId,
          action,
          part: partName,
          shelf: drawer.label,
          quantity,
          locked: !drawerOpen,
          teamNumber: session.teamNumber,
          roboticsLevel: session.roboticsLevel,
        },
        sessionAction,
      );
    } catch (err) {
      audit({
        type: "sheets.tx_error",
        userId: user.id,
        drawerId: drawer.id,
        detail: String(err),
      });
    }
  }

  return NextResponse.json(payload);
}
