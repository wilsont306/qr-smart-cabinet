import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db, seed } from "./store";
import type { User } from "./types";

// Short-lived signed session cookie (HttpOnly/Secure/SameSite=Strict).
// Claims are HMAC-signed so any Vercel isolate can verify auth without the
// in-memory session Map (which does not survive serverless cold starts).
// Local memory still holds optional revoke + warm cache (PRD §5.2).

export const SESSION_COOKIE = "cab_session";
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 min (PRD §5.2)

export interface ResolvedSession {
  user: User;
  trackerSessionId?: string;
  displayName: string;
  teamNumber?: string;
  roboticsLevel?: "FTC" | "FRC" | "FLL";
}

interface SessionClaims {
  v: 1;
  jti: string;
  uid: string;
  name: string;
  sid?: string;
  team?: string;
  level?: "FTC" | "FRC" | "FLL";
  exp: number;
  iat: number;
}

function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET || process.env.SHEETS_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // Shared fallback so multi-instance deploys still agree when env is missing.
  // Prefer setting SESSION_SECRET on Vercel for production.
  return "qr-smart-cabinet-session-dev-v1";
}

function signBody(body: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
}

function seal(claims: SessionClaims): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${signBody(body)}`;
}

function unseal(token: string): SessionClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = signBody(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
    if (claims?.v !== 1 || typeof claims.uid !== "string" || typeof claims.name !== "string") {
      return null;
    }
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function remember(token: string, claims: SessionClaims) {
  db.sessions.set(token, {
    token,
    userId: claims.uid,
    trackerSessionId: claims.sid,
    displayName: claims.name,
    createdAt: claims.iat,
    expiresAt: claims.exp,
  });
}

/** Re-create user + drawer ACL on this isolate after a cold start. */
function hydrateFromClaims(claims: SessionClaims): ResolvedSession | null {
  seed();
  if (db.revokedSessions.has(claims.jti)) return null;

  let user = db.users.get(claims.uid);
  if (!user) {
    user = { id: claims.uid, email: "", name: claims.name };
    db.users.set(claims.uid, user);
  } else if (claims.name && user.name !== claims.name) {
    user = { ...user, name: claims.name };
    db.users.set(claims.uid, user);
  }

  // Tracker visits get every drawer for the session; demo seeds keep theirs.
  if (claims.sid || claims.uid.startsWith("u_trk_")) {
    db.permissions.set(claims.uid, new Set([...db.drawers.keys()]));
  } else if (!db.permissions.has(claims.uid)) {
    db.permissions.set(claims.uid, new Set([...db.drawers.keys()]));
  }

  return {
    user,
    trackerSessionId: claims.sid,
    displayName: claims.name || user.name,
    teamNumber: claims.team,
    roboticsLevel: claims.level,
  };
}

function issueClaims(input: {
  userId: string;
  displayName: string;
  trackerSessionId?: string;
  teamNumber?: string;
  roboticsLevel?: "FTC" | "FRC" | "FLL";
}): { token: string; maxAge: number; claims: SessionClaims } {
  const now = Date.now();
  const claims: SessionClaims = {
    v: 1,
    jti: crypto.randomBytes(16).toString("base64url"),
    uid: input.userId,
    name: input.displayName,
    sid: input.trackerSessionId,
    team: input.teamNumber,
    level: input.roboticsLevel,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const token = seal(claims);
  remember(token, claims);
  return { token, maxAge: Math.floor(SESSION_TTL_MS / 1000), claims };
}

export function createSession(userId: string) {
  seed();
  const user = db.users.get(userId);
  if (!user) throw new Error("unknown_user");
  return issueClaims({ userId, displayName: user.name });
}

/** Workshop tracker session — name + team # + FTC/FRC/FLL for the visit. */
export function createTrackerSession(
  displayName: string,
  opts?: { teamNumber?: string; roboticsLevel?: "FTC" | "FRC" | "FLL" },
) {
  seed();

  const trimmed = displayName.trim().slice(0, 80);
  if (!trimmed) throw new Error("name_required");

  const team = String(opts?.teamNumber ?? "")
    .trim()
    .replace(/\D/g, "")
    .slice(0, 6);
  if (!team) throw new Error("team_required");

  const level = opts?.roboticsLevel;
  if (level !== "FTC" && level !== "FRC" && level !== "FLL") {
    throw new Error("level_required");
  }

  const trackerSessionId = crypto.randomUUID();
  const userId = `u_trk_${trackerSessionId.replace(/-/g, "").slice(0, 16)}`;

  db.users.set(userId, { id: userId, email: "", name: trimmed });
  db.permissions.set(userId, new Set([...db.drawers.keys()]));

  const { token, maxAge, claims } = issueClaims({
    userId,
    displayName: trimmed,
    trackerSessionId,
    teamNumber: team,
    roboticsLevel: level,
  });

  return {
    token,
    maxAge,
    trackerSessionId: claims.sid!,
    displayName: trimmed,
    teamNumber: team,
    roboticsLevel: level,
    userId,
  };
}

export function destroySession(token: string | undefined) {
  if (!token) return;
  const claims = unseal(token);
  if (claims?.jti) db.revokedSessions.add(claims.jti);
  db.sessions.delete(token);
}

function resolveSessionRecord(token: string | undefined): ResolvedSession | null {
  if (!token) return null;

  const claims = unseal(token);
  if (claims) {
    const resolved = hydrateFromClaims(claims);
    if (!resolved) return null;
    // Refresh warm cache with remaining TTL
    remember(token, claims);
    return resolved;
  }

  // Legacy opaque in-memory token (dev hot-reload / older cookies)
  const s = db.sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    db.sessions.delete(token);
    return null;
  }
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  const user = db.users.get(s.userId);
  if (!user) return null;
  return {
    user,
    trackerSessionId: s.trackerSessionId,
    displayName: s.displayName ?? user.name,
  };
}

export function resolveUser(token: string | undefined): User | null {
  return resolveSessionRecord(token)?.user ?? null;
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return resolveUser(jar.get(SESSION_COOKIE)?.value);
}

export async function currentSession(): Promise<ResolvedSession | null> {
  const jar = await cookies();
  return resolveSessionRecord(jar.get(SESSION_COOKIE)?.value);
}

export function setSessionCookie(token: string, maxAge: number) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    // Secure in production only. Over plain http:// to a LAN IP (e.g. testing
    // on a phone via http://192.168.x.x:3000) a browser silently drops a
    // Secure cookie, breaking the session and looping back to sign-in.
    // Production runs on HTTPS, so the Secure-cookie invariant still holds there.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

export const _internal = { id: () => crypto.randomUUID() };
