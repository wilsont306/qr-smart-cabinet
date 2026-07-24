import { NextResponse } from "next/server";
import { seed } from "@/lib/store";
import { currentSession } from "@/lib/session";

export async function GET() {
  seed();
  const session = await currentSession();
  if (!session) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({
    user: {
      id: session.user.id,
      name: session.displayName,
      email: session.user.email,
      trackerSessionId: session.trackerSessionId ?? null,
      teamNumber: session.teamNumber ?? null,
      roboticsLevel: session.roboticsLevel ?? null,
    },
  });
}
