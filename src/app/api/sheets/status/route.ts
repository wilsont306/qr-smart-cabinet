import { NextResponse } from "next/server";
import { LIMITS, clientIp, rateLimit } from "@/lib/security";
import { currentUser } from "@/lib/session";
import { sheetsApiStatus } from "@/lib/google-sheets-api";
import { sheetsEnabled } from "@/lib/sheets";

/**
 * GET /api/sheets/status — diagnose Sheets API config (no secrets returned).
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const gate = rateLimit(
    `sheets_status:${user.id}:${clientIp(req)}`,
    LIMITS.sheetsPull.limit,
    LIMITS.sheetsPull.windowMs,
  );
  if (!gate.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } },
    );
  }

  const api = await sheetsApiStatus();
  return NextResponse.json({
    sheetsEnabled: sheetsEnabled(),
    api,
  });
}
