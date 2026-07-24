import { NextResponse } from "next/server";
import { audit, db, seed } from "@/lib/store";
import { createSession, currentUser, setSessionCookie } from "@/lib/session";

// Demo convenience ONLY for local/dev. Disabled in production so anyone on the
// internet cannot mint a full-access session and burn Sheets/Vercel quota.

const DEFAULT_USER = "u_alex";

function demoAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_LOGIN === "1";
}

export async function GET(req: Request) {
  if (!demoAllowed()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  seed();
  const menu = new URL("/drawers", req.url);

  const existing = await currentUser();
  if (existing) return NextResponse.redirect(menu, 303);

  const user = db.users.get(DEFAULT_USER);
  if (!user) return NextResponse.json({ error: "no_demo_user" }, { status: 500 });

  const { token, maxAge } = createSession(user.id);
  audit({ type: "auth.demo_login", userId: user.id });

  const res = NextResponse.redirect(menu, 303);
  res.cookies.set(setSessionCookie(token, maxAge));
  return res;
}

export async function POST() {
  if (!demoAllowed()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  seed();

  const existing = await currentUser();
  if (existing) return NextResponse.json({ ok: true });

  const user = db.users.get(DEFAULT_USER);
  if (!user) return NextResponse.json({ error: "no_demo_user" }, { status: 500 });

  const { token, maxAge } = createSession(user.id);
  audit({ type: "auth.demo_login", userId: user.id });

  const res = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email },
  });
  res.cookies.set(setSessionCookie(token, maxAge));
  return res;
}
