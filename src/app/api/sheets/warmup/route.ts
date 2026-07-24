import { NextResponse } from "next/server";
import { warmSheets, sheetsEnabled } from "@/lib/sheets";

/**
 * GET /api/sheets/warmup — keep the Apps Script Web App warm.
 *
 * Scheduled via vercel.json cron. In production CRON_SECRET is required
 * (Vercel Cron sends Authorization: Bearer <CRON_SECRET>).
 */
export async function GET(req: Request) {
  if (!sheetsEnabled()) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const cronSecret = process.env.CRON_SECRET?.trim();
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && (!cronSecret || cronSecret.length < 16)) {
    return NextResponse.json({ error: "cron_secret_required" }, { status: 503 });
  }
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const result = await warmSheets();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
