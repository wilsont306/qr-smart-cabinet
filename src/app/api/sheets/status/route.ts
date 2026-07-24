import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { sheetsApiStatus } from "@/lib/google-sheets-api";
import { sheetsEnabled } from "@/lib/sheets";

/**
 * GET /api/sheets/status — diagnose Sheets API config (no secrets returned).
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const api = await sheetsApiStatus();
  return NextResponse.json({
    sheetsEnabled: sheetsEnabled(),
    api,
  });
}
