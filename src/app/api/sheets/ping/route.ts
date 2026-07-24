import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/security";
import { pingSheets, sheetsEnabled } from "@/lib/sheets";

/**
 * GET /api/sheets/ping — tiny Apps Script keepalive while the cabinet is open.
 * Cheaper than a full inventory pull; keeps cold starts rare during a visit.
 */
export async function GET(req: Request) {
  if (!sheetsEnabled()) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const gate = rateLimit(`sheets_ping:${clientIp(req)}`, 30, 60_000);
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const result = await pingSheets();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
