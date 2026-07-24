import { NextResponse } from "next/server";
import { after } from "next/server";
import { LIMITS, clientIp, rateLimit } from "@/lib/security";
import { pullStockFromSheets, sheetsCacheFresh, sheetsEnabled } from "@/lib/sheets";

/**
 * GET /api/sheets/preload — start warming inventory while the user is on sign-in.
 * Public but tightly rate-limited — this hits Google Sheets.
 * Always returns immediately — pull runs in after().
 */
export async function GET(req: Request) {
  if (!sheetsEnabled()) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  // Public endpoint — keep this low so bots can't farm Sheets/Vercel quota.
  const gate = rateLimit(
    `sheets_preload:${clientIp(req)}`,
    LIMITS.sheetsPull.limit,
    LIMITS.sheetsPull.windowMs,
  );
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  if (sheetsCacheFresh()) {
    return NextResponse.json({ ok: true, fresh: true });
  }

  after(() => {
    void pullStockFromSheets({ force: true, timeoutMs: 20000 });
  });

  // Also start the pull immediately so this isolate is warming before the
  // response is flushed (helps when the user continues within a second).
  void pullStockFromSheets({ force: true, timeoutMs: 20000 });

  return NextResponse.json({ ok: true, fresh: false, warming: true });
}
