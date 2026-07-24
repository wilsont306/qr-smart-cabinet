import { NextResponse } from "next/server";
import { after } from "next/server";
import { audit, seed } from "@/lib/store";
import { clientIp, rateLimit, LIMITS } from "@/lib/security";
import { createTrackerSession, setSessionCookie } from "@/lib/session";
import { pullStockFromSheets, sheetsEnabled } from "@/lib/sheets";

interface TrackerBody {
  name?: unknown;
  teamNumber?: unknown;
  roboticsLevel?: unknown;
}

const LEVELS = new Set(["FTC", "FRC", "FLL"]);

// POST /api/auth/tracker — start a workshop visit session (name + team + level).
export async function POST(req: Request) {
  seed();
  const ip = clientIp(req);

  const gate = rateLimit(`tracker:${ip}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
  if (!gate.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: TrackerBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  const teamNumber =
    typeof body.teamNumber === "string" || typeof body.teamNumber === "number"
      ? String(body.teamNumber).trim().replace(/\D/g, "").slice(0, 6)
      : "";
  if (!teamNumber) {
    return NextResponse.json({ error: "invalid_team" }, { status: 400 });
  }

  const roboticsLevel =
    typeof body.roboticsLevel === "string" ? body.roboticsLevel.trim().toUpperCase() : "";
  if (!LEVELS.has(roboticsLevel)) {
    return NextResponse.json({ error: "invalid_level" }, { status: 400 });
  }

  try {
    const session = createTrackerSession(name, {
      teamNumber,
      roboticsLevel: roboticsLevel as "FTC" | "FRC" | "FLL",
    });
    audit({
      type: "auth.tracker_session",
      userId: session.userId,
      detail: `${session.trackerSessionId} team_${session.teamNumber} ${session.roboticsLevel}`,
    });

    const res = NextResponse.json({
      ok: true,
      trackerSessionId: session.trackerSessionId,
      user: {
        id: session.userId,
        name: session.displayName,
        email: "",
        teamNumber: session.teamNumber,
        roboticsLevel: session.roboticsLevel,
      },
    });
    res.cookies.set(setSessionCookie(session.token, session.maxAge));

    if (sheetsEnabled()) {
      // Force a fresh pull for the next cabinet load — don't reuse a stale isolate cache.
      after(() => {
        void pullStockFromSheets({ force: true, timeoutMs: 20000 });
      });
    }

    return res;
  } catch {
    return NextResponse.json({ error: "invalid_checkin" }, { status: 400 });
  }
}
