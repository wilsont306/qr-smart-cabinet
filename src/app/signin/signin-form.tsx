"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  buildSmartScreenStyle,
  RooseveltIslandScene,
  SMART_ACCENT,
  smartEspressoTheme,
} from "@/components/smart-shell";
import { api } from "@/lib/client";

type Step = "name" | "team" | "level";
type RoboticsLevel = "FTC" | "FRC" | "FLL";

const LEVELS: RoboticsLevel[] = ["FTC", "FRC", "FLL"];

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/drawers";
  // After check-in, skip /d/[id] round-trip (and its loading screen) —
  // open the drawer directly in the menu.
  const deep = raw.match(/^\/d\/([^/?#]+)/i);
  if (deep) return `/drawers?open=${encodeURIComponent(decodeURIComponent(deep[1]))}`;
  return raw;
}

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [teamNumber, setTeamNumber] = useState("");
  const [level, setLevel] = useState<RoboticsLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const t = smartEspressoTheme;
  const accent = SMART_ACCENT;

  const nameReady = name.trim().length > 0;
  const teamReady = /^\d{1,6}$/.test(teamNumber.trim());
  const levelReady = level !== null;

  // Prefetch the cabinet route + warm serverless while they type.
  useEffect(() => {
    router.prefetch("/drawers");
    void fetch("/api/sheets/preload", { credentials: "same-origin", cache: "no-store" });
    void fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
  }, [router]);

  // Already signed in — jump straight to the cabinet.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { ok, data } = await api<{ user: { name: string } | null }>("/api/auth/me");
      if (cancelled || !ok || !data.user) return;
      if (data.user.name) {
        try {
          sessionStorage.setItem("cab_session_name", data.user.name);
        } catch {
          // ignore
        }
      }
      if (!cancelled) router.replace(safeNextPath(searchParams.get("next")));
    })();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  function clearError() {
    if (error) setError(null);
  }

  function goNextFromName(e: React.FormEvent) {
    e.preventDefault();
    if (!nameReady) {
      setError("Enter your name to continue.");
      return;
    }
    setError(null);
    setStep("team");
  }

  function goNextFromTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!teamReady) {
      setError("Enter your team number (digits only).");
      return;
    }
    setError(null);
    setStep("level");
  }

  async function finishCheckIn(e: React.FormEvent) {
    e.preventDefault();
    if (!levelReady || !level) {
      setError("Choose FTC, FRC, or FLL.");
      return;
    }

    const trimmedName = name.trim();
    const trimmedTeam = teamNumber.trim();

    setWorking(true);
    setError(null);
    const next = safeNextPath(searchParams.get("next"));
    const { ok, status } = await api("/api/auth/tracker", {
      method: "POST",
      body: JSON.stringify({
        name: trimmedName,
        teamNumber: trimmedTeam,
        roboticsLevel: level,
      }),
    });

    if (ok) {
      try {
        sessionStorage.setItem("cab_session_name", trimmedName);
        sessionStorage.setItem("cab_team_number", trimmedTeam);
        sessionStorage.setItem("cab_robotics_level", level);
      } catch {
        // ignore
      }
      router.replace(next);
      return;
    }
    setWorking(false);
    if (status === 429) {
      setError("Too many attempts. Wait a moment and try again.");
      return;
    }
    setError("Could not start your session. Try again.");
  }

  const copy =
    step === "name"
      ? {
          kicker: "Session",
          title: "Who’s checking in?",
          lead: "We’ll use your name to track what you take or return.",
        }
      : step === "team"
        ? {
            kicker: "Team",
            title: "What’s your team #?",
            lead: "Enter the team number on your robot or badge.",
          }
        : {
            kicker: "Program",
            title: "Which program?",
            lead: "Pick the FIRST program you’re competing in.",
          };

  return (
    <div className="h-dvh overflow-hidden" style={{ background: t.bg }}>
      <main className="smart-screen" style={buildSmartScreenStyle(t, accent)}>
        <RooseveltIslandScene />

        <div className="smart-screen-body smart-signin-body">
          <header className="smart-header smart-signin-header">
            <div>
              <div className="smart-eyebrow">NYC FIRST</div>
              <h1>Smart Cabinet</h1>
            </div>
          </header>

          <div className="smart-signin">
            <div className="smart-signin-copy">
              <p className="smart-signin-kicker">{copy.kicker}</p>
              <h2 className="smart-signin-title">{copy.title}</h2>
              <p className="smart-signin-lead">{copy.lead}</p>
              <div className="smart-signin-steps" aria-hidden>
                <span className={step === "name" ? "on" : "done"} />
                <span className={step === "team" ? "on" : step === "level" ? "done" : ""} />
                <span className={step === "level" ? "on" : ""} />
              </div>
            </div>

            {step === "name" && (
              <form className="smart-signin-form" onSubmit={goNextFromName}>
                <div className={`smart-signin-field${nameReady ? " filled" : ""}`}>
                  <label className="smart-signin-label" htmlFor="tracker-name">
                    Name
                  </label>
                  <input
                    id="tracker-name"
                    className="smart-signin-input"
                    type="text"
                    name="name"
                    autoComplete="name"
                    autoFocus
                    maxLength={80}
                    placeholder=" "
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      clearError();
                    }}
                  />
                  <span className="smart-signin-underline" aria-hidden />
                </div>

                {error && <p className="smart-signin-error">{error}</p>}

                <button
                  type="submit"
                  className="smart-signin-submit"
                  disabled={!nameReady}
                  style={{ background: accent }}
                >
                  <span>Continue</span>
                  <ArrowIcon />
                </button>
              </form>
            )}

            {step === "team" && (
              <form className="smart-signin-form" onSubmit={goNextFromTeam}>
                <div className={`smart-signin-field${teamReady ? " filled" : ""}`}>
                  <label className="smart-signin-label" htmlFor="tracker-team">
                    Team #
                  </label>
                  <input
                    id="tracker-team"
                    className="smart-signin-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    name="teamNumber"
                    autoComplete="off"
                    autoFocus
                    maxLength={6}
                    placeholder=" "
                    value={teamNumber}
                    onChange={(e) => {
                      setTeamNumber(e.target.value.replace(/\D/g, "").slice(0, 6));
                      clearError();
                    }}
                  />
                  <span className="smart-signin-underline" aria-hidden />
                </div>

                {error && <p className="smart-signin-error">{error}</p>}

                <div className="smart-signin-actions">
                  <button
                    type="button"
                    className="smart-signin-back"
                    onClick={() => {
                      setError(null);
                      setStep("name");
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    className="smart-signin-submit"
                    disabled={!teamReady}
                    style={{ background: accent }}
                  >
                    <span>Continue</span>
                    <ArrowIcon />
                  </button>
                </div>
              </form>
            )}

            {step === "level" && (
              <form className="smart-signin-form" onSubmit={finishCheckIn}>
                <div className="smart-signin-levels" role="radiogroup" aria-label="Robotics level">
                  {LEVELS.map((option) => {
                    const selected = level === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`smart-signin-level${selected ? " selected" : ""}`}
                        onClick={() => {
                          setLevel(option);
                          clearError();
                        }}
                        disabled={working}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>

                {error && <p className="smart-signin-error">{error}</p>}

                <div className="smart-signin-actions">
                  <button
                    type="button"
                    className="smart-signin-back"
                    disabled={working}
                    onClick={() => {
                      setError(null);
                      setStep("team");
                    }}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    className="smart-signin-submit"
                    disabled={working || !levelReady}
                    style={{ background: accent }}
                  >
                    <span>{working ? "Starting…" : "Continue"}</span>
                    {!working && <ArrowIcon />}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
