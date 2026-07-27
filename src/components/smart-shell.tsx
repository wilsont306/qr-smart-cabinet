"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export const SMART_ACCENT = "#CF2233";

export interface SmartThemeTokens {
  bg: string;
  ink: string;
  sub: string;
  line: string;
  dot: string;
  panelBg: string;
  panelBorder: string;
}

export const smartEspressoTheme: SmartThemeTokens = {
  bg: "radial-gradient(ellipse 82% 44% at 60% 30%, rgba(255,240,214,0.13), rgba(255,240,214,0) 64%), linear-gradient(180deg, #2C2822 0%, #1D1A16 100%)",
  ink: "#F2ECDD",
  sub: "#B7AF9E",
  line: "rgba(242,236,221,0.30)",
  dot: "rgba(242,236,221,0.09)",
  panelBg: "rgba(242,236,221,0.06)",
  panelBorder: "rgba(242,236,221,0.16)",
};

export function buildSmartScreenStyle(
  theme: SmartThemeTokens,
  accent: string = SMART_ACCENT,
): React.CSSProperties {
  return {
    "--smart-bg": theme.bg,
    "--smart-ink": theme.ink,
    "--smart-sub": theme.sub,
    "--smart-line": theme.line,
    "--smart-dot": theme.dot,
    "--smart-panel-bg": theme.panelBg,
    "--smart-panel-border": theme.panelBorder,
    "--smart-accent": accent,
  } as React.CSSProperties;
}

export function BottomTabs({
  accent = SMART_ACCENT,
  active,
  centerAction,
}: {
  accent?: string;
  active: "drawers" | "activity";
  centerAction?: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <nav className="smart-bottom-nav">
      <button
        type="button"
        className={active === "drawers" ? undefined : "inactive"}
        onClick={() => router.push("/drawers")}
        aria-current={active === "drawers" ? "page" : undefined}
      >
        <div className="smart-drawer-icon" aria-hidden>
          <span style={{ background: active === "drawers" ? accent : undefined }} />
          <span style={{ background: active === "drawers" ? accent : undefined }} />
        </div>
        <b style={active === "drawers" ? { color: accent } : undefined}>Drawers</b>
      </button>
      {/* Always reserve the center slot so tab layout doesn't jump. */}
      <div className="smart-bottom-center" aria-hidden={!centerAction}>
        {centerAction}
      </div>
      <button
        type="button"
        className={active === "activity" ? undefined : "inactive"}
        onClick={() => router.push("/activity")}
        aria-current={active === "activity" ? "page" : undefined}
      >
        <div className="smart-activity-icon" aria-hidden>
          <span style={active === "activity" ? { background: accent } : undefined} />
          <span style={active === "activity" ? { background: accent } : undefined} />
          <span style={active === "activity" ? { background: accent } : undefined} />
        </div>
        <b style={active === "activity" ? { color: accent } : undefined}>My activity</b>
      </button>
    </nav>
  );
}

/** Header chip: signed-in name + sign out (return to name check-in). */
export function SessionChip({ name }: { name: string }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function signOut() {
    if (working) return;
    setWorking(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* still bounce to check-in */
    }
    router.replace("/signin");
  }

  return (
    <div className="smart-session-chip" title={`Signed in as ${name}`}>
      <span>Signed in</span>
      <b>{name}</b>
      <button
        type="button"
        className="smart-sign-out"
        onClick={signOut}
        disabled={working}
      >
        {working ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export function RooseveltIslandScene() {
  return (
    <div className="smart-scene">
      <svg
        width="402"
        height="820"
        viewBox="0 0 402 820"
        preserveAspectRatio="xMidYMin slice"
        fill="none"
        aria-hidden
      >
        <defs>
          <radialGradient id="smart-glow" cx="70%" cy="18%" r="55%">
            <stop offset="0%" stopColor="var(--smart-accent)" stopOpacity="0.18" />
            <stop offset="55%" stopColor="var(--smart-accent)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--smart-accent)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="smart-haze" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.05" />
            <stop offset="40%" stopColor="currentColor" stopOpacity="0" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        <rect width="402" height="820" fill="url(#smart-glow)" />
        <rect width="402" height="820" fill="url(#smart-haze)" />

        {/* Near-bank towers */}
        <g opacity="0.14" fill="currentColor">
          <rect x="6" y="150" width="13" height="22" />
          <rect x="22" y="138" width="9" height="34" />
          <rect x="34" y="156" width="11" height="16" />
          <rect x="120" y="152" width="12" height="20" />
          <rect x="135" y="143" width="10" height="29" />
          <rect x="150" y="150" width="14" height="22" />
          <rect x="168" y="136" width="11" height="36" />
          <rect x="223" y="154" width="10" height="18" />
          <rect x="238" y="146" width="13" height="26" />
          <rect x="256" y="140" width="11" height="32" />
          <rect x="272" y="151" width="14" height="21" />
          <rect x="290" y="134" width="10" height="38" />
          <rect x="356" y="148" width="11" height="24" />
          <rect x="372" y="140" width="16" height="32" />
          <rect x="390" y="152" width="9" height="20" />
        </g>

        {/* Window dots in towers */}
        <g opacity="0.12" fill="currentColor">
          <circle cx="27" cy="148" r="1.1" />
          <circle cx="27" cy="156" r="1.1" />
          <circle cx="140" cy="152" r="1.1" />
          <circle cx="140" cy="160" r="1.1" />
          <circle cx="261" cy="150" r="1.1" />
          <circle cx="261" cy="158" r="1.1" />
          <circle cx="295" cy="148" r="1.1" />
          <circle cx="380" cy="152" r="1.1" />
        </g>

        {/* Distant river traffic / wakes */}
        <g opacity="0.14" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          <path d="M10 188h16M32 188h10M8 200h20M14 212h12M6 224h18M360 186h18M384 186h10M366 198h20M372 210h14M362 222h20" />
          <path d="M18 248h22M48 260h14M12 274h18M348 250h20M370 264h12M340 278h24" />
        </g>

        {/* Truss bridge deck */}
        <g opacity="0.2" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round">
          <path d="M0 171h214M0 177h214" />
          <path d="M6 171l32 6M38 171 6 177M38 171l32 6M70 171l-32 6M70 171l32 6M102 171l-32 6M102 171l32 6M134 171l-32 6M134 171l32 6M166 171l-32 6M166 171l32 6M198 171l-32 6" />
          <path d="M100 178v-78M126 178v-78M96 100h34M100 100l13-10 13 10" />
          <path d="M100 150l26-18M126 150l-26-18M100 132l26-18M126 132l-26-18" />
          <path d="M113 92 16 171M113 92l97 79" />
        </g>

        {/* Aerial tram cables + towers */}
        <g opacity="0.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
          <path d="M50 172 60 52l10 120M60 172V52M46 56h28" />
          <path d="M336 172 346 20l10 152M346 172V20M332 24h28" />
          <path d="M60 52q140 8 286-32" />
          <path d="M60 52-6 78M346 20l62 20" />
        </g>
        <g opacity="0.16" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          <path d="M60 56q140 10 286-32" />
          <path d="M62 62q138 12 282-30" />
        </g>

        <g className="smart-tram">
          <circle cx="286" cy="34" r="2.4" fill="currentColor" opacity="0.55" />
          <path d="M286 35v7" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <rect x="269" y="42" width="34" height="21" rx="6" fill="var(--smart-accent)" />
          <rect x="272" y="42" width="28" height="3.3" rx="1.5" fill="#000" opacity="0.14" />
          <rect x="274" y="48" width="24" height="8.5" rx="2" fill="#FFF" opacity="0.5" />
          <path d="M286 48v8.5" stroke="var(--smart-accent)" strokeWidth="1.4" />
        </g>

        {/* East River bands */}
        <g opacity="0.11" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          <path d="M0 320h402M24 336h354M0 352h402M40 368h322M0 384h402" />
          <path d="M12 408h378M48 424h306M8 440h386M56 456h290M0 472h402" />
        </g>

        {/* Soft water shimmer */}
        <g opacity="0.08" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M60 330q20 6 40 0M140 346q24 8 48 0M220 362q28 6 52 0M300 378q22 7 44 0" />
          <path d="M80 414q26 7 50 0M180 430q30 8 56 0M270 446q24 6 48 0" />
        </g>

        {/* Island promenade + rail */}
        <g opacity="0.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M0 510h402" />
          <path d="M0 518h402" />
          <path d="M18 510v28M54 510v22M90 510v30M126 510v20M306 510v28M342 510v20M378 510v26" />
        </g>

        {/* Centered bench */}
        <g opacity="0.18" fill="currentColor">
          <rect x="158" y="526" width="86" height="5" rx="1.5" />
          <rect x="164" y="514" width="74" height="12" rx="2" />
          <rect x="166" y="531" width="4" height="20" rx="1.5" />
          <rect x="232" y="531" width="4" height="20" rx="1.5" />
        </g>

        {/*
          Pictogram figure sitting on the bench, from behind, watching the ocean.
        */}
        <g className="smart-watcher" opacity="0.38" fill="currentColor">
          {/* head */}
          <circle cx="201" cy="48" r="9" />
          {/* torso */}
          <rect x="192" y="492" width="18" height="28" rx="7" />
          {/* left arm resting on lap */}
          <path
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            d="M194 502c-6 5-8 11-8 16"
          />
          {/* right arm resting on lap */}
          <path
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            d="M208 502c6 5 8 11 8 16"
          />
          {/* left thigh → knee */}
          <path
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            d="M196 520c-3 1-5 2-6 1"
          />
          {/* right thigh → knee */}
          <path
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            d="M206 520c3 1 5 2 6 1"
          />
          {/* left calf hanging */}
          <path
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            d="M190 521v22"
          />
          {/* right calf hanging */}
          <path
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            d="M212 521v22"
          />
        </g>
      </svg>
    </div>
  );
}
