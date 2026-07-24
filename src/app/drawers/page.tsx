"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BottomTabs,
  buildSmartScreenStyle,
  RooseveltIslandScene,
  SessionChip,
  SMART_ACCENT,
  smartEspressoTheme,
} from "@/components/smart-shell";
import { api, uuid } from "@/lib/client";
import type { DrawerView } from "@/lib/dto";

type Intent = "take" | "return";
type Accent = "#CF2233" | "#1F5FA8" | "#1C2B4A";
type DetailPhase = "idle" | "enter" | "shown" | "exit";

/** Drive uc?export=view links often 404 in <img>; thumbnails work when shared. */
function toDisplayPhotoUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const id =
    s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/)?.[1] ||
    s.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] ||
    s.match(/\/d\/([a-zA-Z0-9_-]{20,})(?:\/|$)/)?.[1];
  if (id && /drive\.google\.com|googleusercontent\.com/i.test(s)) {
    return `https://drive.google.com/thumbnail?id=${id}&sz=w800`;
  }
  return s;
}

interface ThemeTokens {
  bg: string;
  ink: string;
  sub: string;
  line: string;
  dot: string;
  panelBg: string;
  panelBorder: string;
}

interface TxResult {
  transaction: {
    id: string;
    delta: number;
    intent: Intent;
    balanceAfter: number;
    createdAt: number;
  };
  drawer: DrawerView;
}

const INK = "#1C2B4A";

const fronts = ["#FFFDF8", "#F7F0DF", "#FBF6EC"];
const borders = ["#E6DCC4", "#DFD3B6", "#E4DAC1"];

/** Instant first paint — prefer last hydrated sheet snapshot, else placeholders. */
function bootDrawers(): DrawerView[] {
  try {
    const raw = sessionStorage.getItem("cab_drawers_boot");
    if (raw) {
      const parsed = JSON.parse(raw) as DrawerView[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.label) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return Array.from({ length: 9 }, (_, i) => ({
    id: `__boot_${i + 1}`,
    cabinet: "Cabinet A",
    label: `Drawer ${i + 1}`,
    location: "…",
    status: "active" as const,
    locked: true,
    item: {
      id: `__boot_item_${i + 1}`,
      name: "Loading…",
      unit: "item",
      photo: "",
    },
    quantity: 0,
    stockVersion: 0,
  }));
}

function cacheDrawersBoot(list: DrawerView[]) {
  try {
    sessionStorage.setItem("cab_drawers_boot", JSON.stringify(list));
  } catch {
    // ignore
  }
}

function readCachedSessionName(): string | null {
  try {
    return sessionStorage.getItem("cab_session_name");
  } catch {
    return null;
  }
}

export default function DrawersPage() {
  return (
    <Suspense fallback={<DrawersBoot />}>
      <DrawersPageInner />
    </Suspense>
  );
}

function DrawersBoot() {
  const t = smartEspressoTheme;
  const accent = SMART_ACCENT;
  const boot = bootDrawers();
  const rulerBg = `repeating-linear-gradient(180deg, ${t.line} 0px, ${t.line} 1.5px, transparent 1.5px, transparent 70px), repeating-linear-gradient(180deg, ${t.dot} 0px, ${t.dot} 1px, transparent 1px, transparent 14px)`;
  const dotBg = `radial-gradient(${t.dot} 1px, transparent 1.2px)`;
  return (
    <div className="h-dvh overflow-hidden" style={{ background: t.bg }}>
      <main className="smart-screen" style={buildSmartScreenStyle(t, accent)}>
        <div className="smart-screen-body">
          <header className="smart-header">
            <div>
              <div className="smart-eyebrow">NYC FIRST</div>
              <h1>Smart Cabinet</h1>
            </div>
          </header>
          <div className="smart-cabinet-boot">
            <CabinetStage
              drawers={boot}
              accent={accent}
              openIdx={null}
              stagger={0}
              rulerBg={rulerBg}
              dotBg={dotBg}
              line={t.line}
              onOpen={() => {}}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function DrawersPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openParam = searchParams.get("open");
  const [drawers, setDrawers] = useState<DrawerView[]>(() => bootDrawers());
  const [ready, setReady] = useState(false);
  const [sheets, setSheets] = useState(false);
  const [sessionName, setSessionName] = useState<string | null>(() => readCachedSessionName());
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [detailPhase, setDetailPhase] = useState<DetailPhase>("idle");
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedFromScan = useRef(false);
  /** Keep optimistic lock UI until sheet / other isolates catch up. */
  const lockHold = useRef<Map<string, { locked: boolean; until: number }>>(new Map());

  const DETAIL_REVEAL_DELAY_MS = 80;

  function applyLockHold(list: DrawerView[]): DrawerView[] {
    const now = Date.now();
    return list.map((d) => {
      const hold = lockHold.current.get(d.id);
      if (!hold || now >= hold.until) return d;
      return hold.locked === d.locked ? d : { ...d, locked: hold.locked };
    });
  }

  function rememberLock(id: string, locked: boolean) {
    lockHold.current.set(id, { locked, until: Date.now() + 20_000 });
  }

  async function fetchCabinet(): Promise<{
    drawers: DrawerView[];
    sheets: boolean;
    sheetsFresh: boolean;
  } | null> {
    const { ok, status, data } = await api<{
      drawers: DrawerView[];
      sheets: boolean;
      sheetsFresh?: boolean;
    }>("/api/drawers");
    if (status === 401) {
      router.replace("/signin");
      return null;
    }
    if (!ok) {
      return { drawers: [], sheets: false, sheetsFresh: false };
    }
    return {
      drawers: data.drawers,
      sheets: data.sheets,
      sheetsFresh: data.sheetsFresh ?? false,
    };
  }

  async function loadCabinet() {
    const result = await fetchCabinet();
    if (!result) return null;
    setDrawers(applyLockHold(result.drawers));
    setSheets(result.sheets);
    setReady(true);
    return result.drawers;
  }

  useEffect(() => {
    let cancelled = false;
    // Kick a background warm on this page's isolate immediately.
    void fetch("/api/sheets/preload", { credentials: "same-origin", cache: "no-store" });
    // Keep Apps Script warm while the cabinet stays open (Hobby cron is daily only).
    void fetch("/api/sheets/ping", { credentials: "same-origin", cache: "no-store" });
    const keepAlive = window.setInterval(() => {
      void fetch("/api/sheets/ping", { credentials: "same-origin", cache: "no-store" });
    }, 45 * 1000);

    void (async () => {
      // After check-in, force a sheet pull on THIS isolate before trusting seed stock.
      let needSync = false;
      try {
        needSync = sessionStorage.getItem("cab_need_sheet_sync") === "1";
        if (needSync) sessionStorage.removeItem("cab_need_sheet_sync");
      } catch {
        // ignore
      }

      if (needSync) {
        const hydrated = await api<{
          ok?: boolean;
          drawers?: DrawerView[];
          sheetsFresh?: boolean;
        }>("/api/sheets/hydrate");
        if (!cancelled && hydrated.ok && Array.isArray(hydrated.data?.drawers) && hydrated.data.drawers.length) {
          const list = applyLockHold(hydrated.data.drawers);
          setDrawers(list);
          setSheets(true);
          setReady(true);
          cacheDrawersBoot(list);
          if (hydrated.data.sheetsFresh) return;
        }
      }

      const first = await fetchCabinet();
      if (cancelled || !first) return;
      setDrawers(applyLockHold(first.drawers));
      setSheets(first.sheets);
      setReady(true);
      if (first.drawers.length && !first.drawers[0]?.id.startsWith("__boot_")) {
        cacheDrawersBoot(first.drawers);
      }

      if (!first.sheets || first.sheetsFresh) return;

      // Quietly keep asking until the sheet lands (cold Apps Script is slow).
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (cancelled) return;
        const next = await fetchCabinet();
        if (!next) return;
        setDrawers(applyLockHold(next.drawers));
        setSheets(next.sheets);
        if (next.drawers.length) cacheDrawersBoot(next.drawers);
        if (next.sheetsFresh) return;
      }
    })();
    api<{
      user: {
        name: string;
        teamNumber?: string | null;
        roboticsLevel?: string | null;
      } | null;
    }>("/api/auth/me").then(({ ok, data }) => {
      if (!ok || !data.user?.name) return;
      const team = data.user.teamNumber?.trim() ?? "";
      const level = data.user.roboticsLevel?.trim() ?? "";
      if (!/^\d{1,6}$/.test(team) || !["FTC", "FRC", "FLL"].includes(level)) {
        router.replace("/signin");
        return;
      }
      setSessionName(data.user.name);
      try {
        sessionStorage.setItem("cab_session_name", data.user.name);
        sessionStorage.setItem("cab_team_number", team);
        sessionStorage.setItem("cab_robotics_level", level);
      } catch {
        // ignore
      }
    });
    return () => {
      cancelled = true;
      window.clearInterval(keepAlive);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount load
  }, [router]);

  // QR / deep-link: /drawers?open=<id|shortCode> opens that drawer.
  useEffect(() => {
    if (!drawers || !openParam || openedFromScan.current) return;
    const key = openParam.trim();
    if (!key) return;

    const localIdx = drawers.findIndex((d) => d.id === key);
    if (localIdx >= 0) {
      openedFromScan.current = true;
      openDrawer(localIdx);
      router.replace("/drawers", { scroll: false });
      return;
    }

    let cancelled = false;
    void (async () => {
      const { ok, data } = await api<{ drawer: DrawerView }>(
        `/api/drawers/${encodeURIComponent(key)}`,
      );
      if (cancelled || !ok || !data.drawer) return;
      const idx = drawers.findIndex((d) => d.id === data.drawer.id);
      if (idx < 0) return;
      openedFromScan.current = true;
      openDrawer(idx);
      router.replace("/drawers", { scroll: false });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once from scan
  }, [drawers, openParam]);

  const t = smartEspressoTheme;
  const accent = SMART_ACCENT;
  const rulerBg = `repeating-linear-gradient(180deg, ${t.line} 0px, ${t.line} 1.5px, transparent 1.5px, transparent 70px), repeating-linear-gradient(180deg, ${t.dot} 0px, ${t.dot} 1px, transparent 1px, transparent 14px)`;
  const dotBg = `radial-gradient(${t.dot} 1px, transparent 1.2px)`;
  const detail = detailIdx !== null && drawers ? drawers[detailIdx] : null;

  function openDrawer(i: number) {
    if (!ready) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setDetailIdx(null);
    setDetailPhase("idle");
    setOpenIdx(i);

    openTimer.current = setTimeout(() => {
      setDetailIdx(i);
      setDetailPhase("enter");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setDetailPhase("shown"));
      });
    }, DETAIL_REVEAL_DELAY_MS);
  }

  function closeDrawer() {
    if (openTimer.current) clearTimeout(openTimer.current);
    setDetailPhase("exit");
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setDetailIdx(null);
      setOpenIdx(null);
      setDetailPhase("idle");
    }, 180);
  }

  function updateDrawer(next: DrawerView) {
    const hold = lockHold.current.get(next.id);
    const merged =
      hold && Date.now() < hold.until ? { ...next, locked: hold.locked } : next;
    setDrawers((current) =>
      current?.map((drawer) => (drawer.id === merged.id ? merged : drawer)) ?? current,
    );
  }

  function setDrawerLock(next: DrawerView, locked: boolean) {
    rememberLock(next.id, locked);
    updateDrawer({ ...next, locked });
  }

  return (
    <div className="h-dvh overflow-hidden" style={{ background: t.bg }}>
      <main
        className="smart-screen"
        style={buildSmartScreenStyle(t, accent)}
      >
        <RooseveltIslandScene />

        <div className="smart-screen-body">
          <header className="smart-header">
            <div>
              <div className="smart-eyebrow">NYC FIRST</div>
              <h1>Smart Cabinet</h1>
            </div>
            {sessionName && <SessionChip name={sessionName} />}
          </header>

          {drawers.length === 0 ? (
            <p className="relative z-[1] mx-5 mt-24 rounded-2xl border border-[var(--smart-panel-border)] bg-[var(--smart-panel-bg)] p-5 text-center text-sm text-[var(--smart-sub)]">
              No drawers available for your account.
            </p>
          ) : (
            <div className={ready ? undefined : "smart-cabinet-boot"}>
              <CabinetStage
                drawers={drawers}
                accent={accent}
                openIdx={openIdx}
                stagger={ready ? 40 : 0}
                rulerBg={rulerBg}
                dotBg={dotBg}
                line={t.line}
                onOpen={openDrawer}
              />
            </div>
          )}
        </div>

        {detailIdx === null && (
          <BottomTabs
            accent={accent}
            active="drawers"
            centerAction={
              sheets ? (
                <SyncButton
                  onRefreshed={(next) => setDrawers(applyLockHold(next))}
                  reload={loadCabinet}
                />
              ) : undefined
            }
          />
        )}

        <DrawerDetail
          drawer={detail}
          index={detailIdx}
          phase={detailPhase}
          accent={accent}
          t={t}
          onClose={closeDrawer}
          onUpdated={updateDrawer}
          onLockChange={setDrawerLock}
        />
      </main>
    </div>
  );
}

function SyncButton({
  onRefreshed,
  reload,
}: {
  onRefreshed: (drawers: DrawerView[]) => void;
  reload: () => Promise<DrawerView[] | null>;
}) {
  const [state, setState] = useState<"idle" | "syncing" | "ok" | "err">("idle");
  const [hint, setHint] = useState("");

  async function syncNow() {
    setState("syncing");
    setHint("");
    try {
      const sync = await api<{
        ok?: boolean;
        error?: string;
        count?: number;
        parts?: string[];
        photos?: number;
        imageCol?: number | null;
        drawers?: DrawerView[];
      }>("/api/sheets/sync", { method: "POST" });

      if (Array.isArray(sync.data?.drawers) && sync.data.drawers.length) {
        onRefreshed(sync.data.drawers);
        try {
          sessionStorage.setItem("cab_drawers_boot", JSON.stringify(sync.data.drawers));
        } catch {
          // ignore
        }
      } else {
        const next = await reload();
        if (!next) {
          setState("err");
          setHint("Reload failed");
          setTimeout(() => setState("idle"), 2800);
          return;
        }
        onRefreshed(next);
      }

      if (!sync.data?.ok) {
        setState("err");
        const err = sync.data?.error || "Sync failed";
        setHint(
          err === "webhook_gone"
            ? "Sheet link broken"
            : err === "not_configured"
              ? "Sheets not set"
              : err === "fetch_failed"
                ? "Sheet offline"
                : err,
        );
      } else {
        setState("ok");
        const n = sync.data.photos ?? 0;
        if (sync.data.imageCol == null) setHint("No Image col");
        else if (n === 0) setHint("0 photos");
        else setHint(`${n} photo${n === 1 ? "" : "s"}`);
      }
    } catch {
      setState("err");
      setHint("Network error");
    }
    setTimeout(() => {
      setState("idle");
      setHint("");
    }, 4200);
  }

  return (
    <button
      type="button"
      className={`smart-refresh-action state-${state}`}
      onClick={syncNow}
      disabled={state === "syncing"}
      aria-label="Refresh inventory from Google Sheet"
    >
      <span className="smart-refresh-circle">
        <svg
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className={state === "syncing" ? "spin" : undefined}
        >
          <path
            d="M20 7v5h-5M4 17v-5h5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M18.5 9A7 7 0 0 0 6.1 6.8L4 12M5.5 15A7 7 0 0 0 17.9 17.2L20 12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <b>
        {state === "err"
          ? "Retry"
          : state === "ok" && hint
            ? hint
            : "Refresh"}
      </b>
    </button>
  );
}

function CabinetStage({
  drawers,
  accent,
  openIdx,
  stagger,
  rulerBg,
  dotBg,
  line,
  onOpen,
}: {
  drawers: DrawerView[];
  accent: Accent;
  openIdx: number | null;
  stagger: number;
  rulerBg: string;
  dotBg: string;
  line: string;
  onOpen: (index: number) => void;
}) {
  return (
    <div className="smart-stage" style={{ backgroundImage: dotBg }}>
      <div
        className="smart-ruler"
        style={{
          backgroundImage: rulerBg,
          backgroundSize: "13px 100%, 7px 100%",
          backgroundPosition: "right top, right top",
        }}
      />

      <div className="smart-cabinet-column">
        <div className="smart-perspective">
          <div className="smart-cabinet">
            <div className="smart-carcass" />
            <div className="smart-side-panel">
              <span />
              <span />
            </div>
            <div className="smart-top-panel">
              <span />
              <i />
            </div>

            {drawers.map((drawer, index) => (
              <DrawerRow
                key={drawer.id}
                drawer={drawer}
                index={index}
                open={openIdx === index}
                accent={accent}
                delay={index * stagger}
                onOpen={() => onOpen(index)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="smart-rail" style={{ "--rail-line": line } as React.CSSProperties}>
        {drawers.map((drawer, index) => {
          const open = openIdx === index;
          return (
            <button
              key={drawer.id}
              onClick={() => onOpen(index)}
              style={{
                color: open ? "#FFFDF8" : "#A9A28F",
                background: open ? accent : "transparent",
                borderColor: open ? accent : line,
              }}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DrawerRow({
  drawer,
  index,
  open,
  accent,
  delay,
  onOpen,
}: {
  drawer: DrawerView;
  index: number;
  open: boolean;
  accent: Accent;
  delay: number;
  onOpen: () => void;
}) {
  const status = drawer.quantity === 0 ? "empty" : drawer.quantity <= 5 ? "low" : "ok";
  const empty = status === "empty";
  const unit = pluralUnit(drawer.item.unit, drawer.quantity);
  const stock = stockMeter(drawer.quantity);

  return (
    <div className="smart-drawer-row">
      <div className="smart-cavity" />
      <button
        className="smart-drawer-box"
        onClick={onOpen}
        style={
          {
            transform: open ? "translateZ(72px)" : "translateZ(2.5px)",
            animationDelay: `${delay}ms`,
          } as React.CSSProperties
        }
      >
        <div className="smart-drawer-west" style={{ opacity: open ? 1 : 0 }} />
        <div
          className="smart-tray"
          style={{ opacity: open ? 1 : 0, animationDelay: `${delay}ms` }}
        >
          <span style={{ left: "20%" }} />
          <span style={{ left: "40%" }} />
          <span style={{ left: "60%" }} />
          <span style={{ left: "80%" }} />
        </div>
        <div
          className="smart-front"
          style={{
            background: fronts[index % fronts.length],
            borderColor: borders[index % borders.length],
            boxShadow: open
              ? "14px 18px 24px rgba(24,19,9,0.35)"
              : "0 1px 2px rgba(28,43,74,0.08)",
          }}
        >
          <div className="smart-scoop" />
          {drawer.locked && (
            <div className="smart-front-lock" aria-hidden>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <rect
                  x="5"
                  y="10"
                  width="14"
                  height="11"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M8 10V7.5a4 4 0 018 0V10"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="15" r="1.4" fill="currentColor" />
              </svg>
            </div>
          )}
          <div className="smart-front-top">
            <span>DRAWER {index + 1}</span>
            <span
              className="smart-stock-bar"
              title={`${drawer.quantity} in stock`}
              aria-hidden
            >
              <i style={{ width: `${stock.pct}%`, background: stock.color }} />
            </span>
          </div>
          <div className="smart-front-bottom">
            <span style={{ color: empty ? "#A89F8C" : "#4A4436" }}>
              {drawer.item.name}
            </span>
            <b style={{ color: empty ? "#A89F8C" : status === "low" ? accent : INK }}>
              {drawer.quantity}
            </b>
            <em>{unit}</em>
          </div>
        </div>
      </button>
    </div>
  );
}

function DrawerDetail({
  drawer,
  index,
  phase,
  accent,
  t,
  onClose,
  onUpdated,
  onLockChange,
}: {
  drawer: DrawerView | null;
  index: number | null;
  phase: DetailPhase;
  accent: Accent;
  t: ThemeTokens;
  onClose: () => void;
  onUpdated: (drawer: DrawerView) => void;
  onLockChange: (drawer: DrawerView, locked: boolean) => void;
}) {
  const [mode, setMode] = useState<Intent>("take");
  const [qty, setQty] = useState(1);
  const [working, setWorking] = useState(false);
  const [lockWorking, setLockWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slideX, setSlideX] = useState(0); // 0 = locked, 1 = open
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startSlide: number;
    currentSlide: number;
    dragging: boolean;
    moved: boolean;
  } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const idemKey = useRef(uuid());
  const lockIdemKey = useRef(uuid());
  const TRAVEL = 24; // thumb travel in px

  useEffect(() => {
    setMode("take");
    setQty(1);
    setWorking(false);
    setLockWorking(false);
    setError(null);
    setSlideX(drawer?.locked === false ? 1 : 0);
    idemKey.current = uuid();
    lockIdemKey.current = uuid();
  }, [drawer?.id]);

  // Keep detail panel in sync when sheet refresh updates qty / locked / name.
  useEffect(() => {
    if (!drawer) return;
    if (mode === "take") {
      setQty((q) => Math.min(q, Math.max(drawer.quantity, 1)));
    }
  }, [drawer?.quantity, drawer?.item.name, mode, drawer]);

  useEffect(() => {
    if (lockWorking || dragRef.current?.dragging) return;
    setSlideX(drawer?.locked === false ? 1 : 0);
  }, [drawer?.locked, lockWorking]);

  const max = drawer ? Math.max(drawer.quantity, 1) : 1;
  const clampedQty = Math.max(1, Math.min(qty, mode === "take" ? max : 99));
  const shown = phase === "shown";
  const status = drawer
    ? drawer.quantity === 0
      ? "empty"
      : drawer.quantity <= 5
        ? "low"
        : "ok"
    : "ok";
  const countColor = status === "empty" ? t.sub : status === "low" ? accent : t.ink;
  const isOpen = slideX >= 0.5;

  async function commitLock(wantOpen: boolean) {
    if (!drawer || lockWorking) return;
    const currentlyOpen = !drawer.locked;
    if (wantOpen === currentlyOpen) {
      setSlideX(wantOpen ? 1 : 0);
      return;
    }

    setLockWorking(true);
    setError(null);
    setSlideX(wantOpen ? 1 : 0);
    // Optimistic — don't wait for the sheet (or a stale refresh) to flip the label.
    onLockChange(drawer, !wantOpen);

    const path = wantOpen
      ? `/api/drawers/${encodeURIComponent(drawer.id)}/unlock`
      : `/api/drawers/${encodeURIComponent(drawer.id)}/lock`;
    const { ok, status: httpStatus, data } = await api<{
      error?: string;
      drawer?: DrawerView;
      locked?: boolean;
    }>(path, {
      method: "POST",
      body: wantOpen
        ? JSON.stringify({ idempotencyKey: lockIdemKey.current })
        : JSON.stringify({}),
    });

    setLockWorking(false);
    lockIdemKey.current = uuid();

    if (ok) {
      if (data.drawer) {
        onLockChange(data.drawer, data.drawer.locked);
        setSlideX(data.drawer.locked ? 0 : 1);
      } else {
        setSlideX(wantOpen ? 1 : 0);
      }
      return;
    }
    if (httpStatus === 401) {
      window.location.href = "/signin";
      return;
    }
    // revert slide + lock hold
    onLockChange(drawer, !currentlyOpen);
    setSlideX(currentlyOpen ? 1 : 0);
    if (data.drawer) onUpdated(data.drawer);
    const messages: Record<string, string> = {
      drawer_busy: "This drawer is open right now. Try again shortly.",
      cooldown: "This drawer just closed. Give it a moment.",
      rate_limited: "Lock limit reached. Try again later.",
      drawer_disabled: "This drawer is disabled.",
      lock_error: "The lock did not respond. Try again.",
      not_open: "Someone else has this drawer open.",
    };
    setError(
      messages[data.error ?? ""] ??
        (wantOpen ? "Could not unlock. Try again." : "Could not lock. Try again."),
    );
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (lockWorking || drawer?.status === "disabled") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    dragRef.current = {
      startX: event.clientX,
      startSlide: slideX,
      currentSlide: slideX,
      dragging: true,
      moved: false,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag?.dragging) return;
    const delta = (event.clientX - drag.startX) / TRAVEL;
    if (Math.abs(event.clientX - drag.startX) > 3) drag.moved = true;
    const next = Math.max(0, Math.min(1, drag.startSlide + delta));
    drag.currentSlide = next;
    setSlideX(next);
  }

  function onPointerUp() {
    const drag = dragRef.current;
    if (!drag) return;
    const start = drag.startSlide;
    const moved = drag.moved;
    const endSlide = drag.currentSlide;
    drag.dragging = false;
    dragRef.current = null;
    setDragging(false);
    if (!moved) {
      void commitLock(start < 0.5);
    } else {
      void commitLock(endSlide >= 0.5);
    }
  }

  async function confirm() {
    if (!drawer || working) return;
    if (lockWorking) {
      setError("Wait for unlock/lock to finish, then try again.");
      return;
    }
    if (drawer.locked) {
      setError("Unlock the drawer before taking or returning parts.");
      return;
    }
    setWorking(true);
    setError(null);

    async function postTx(stockVersion: number) {
      return api<TxResult & { error?: string; drawer?: DrawerView }>(
        `/api/drawers/${encodeURIComponent(drawer!.id)}/transaction`,
        {
          method: "POST",
          body: JSON.stringify({
            quantity: clampedQty,
            intent: mode,
            idempotencyKey: idemKey.current,
            stockVersion,
          }),
        },
      );
    }

    let { ok, status: httpStatus, data } = await postTx(drawer.stockVersion);

    // If another tab/isolate moved stock, adopt the latest and retry once.
    if (!ok && data.error === "stock_changed" && data.drawer) {
      onUpdated(data.drawer);
      idemKey.current = uuid();
      ({ ok, status: httpStatus, data } = await postTx(data.drawer.stockVersion));
    }

    setWorking(false);
    idemKey.current = uuid();

    if (ok) {
      onUpdated(data.drawer);
      onClose();
      return;
    }

    if (httpStatus === 401) {
      window.location.href = "/signin";
      return;
    }
    if (data.drawer) onUpdated(data.drawer);
    const messages: Record<string, string> = {
      stock_changed: "Stock changed. Review the latest count and try again.",
      insufficient_stock: "There is not enough stock for that quantity.",
      rate_limited: "Too many takes this hour. Wait a bit, or sign out and back in.",
      drawer_disabled: "This drawer is disabled.",
      drawer_locked: "Unlock the drawer before taking or returning parts.",
      not_open: "Someone else has this drawer open.",
    };
    setError(messages[data.error ?? ""] ?? "Could not record that. Try again.");
  }

  if (!drawer || index === null) return null;

  const sheetPhoto = drawer.item.photo?.trim() || "";
  const photoSrc = toDisplayPhotoUrl(sheetPhoto) || "/wire-placeholder.svg";
  const photoAlt = sheetPhoto ? drawer.item.name : "Assorted wire placeholder";

  return (
    <div
      className="smart-detail-overlay"
      style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? "auto" : "none" }}
    >
      <div className="smart-detail-backdrop" onClick={onClose} aria-hidden />
      <div
        className="smart-detail"
        style={{
          background: t.bg,
          color: t.ink,
          transform: shown ? "scale(1)" : "scale(0.96) translateY(12px)",
        }}
      >
      <header>
        <button onClick={onClose} aria-label="Back">
          <svg width="9" height="15" viewBox="0 0 9 15" fill="none" aria-hidden>
            <path d="M8 1 1.5 7.5 8 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div>Smart Cabinet · Drawer {index + 1}</div>
      </header>

      <div className="smart-detail-body">
        <div className="smart-lock-row">
          <div>
            <span />
            <b>{drawer.locked ? "Locked" : "Unlocked"}</b>
          </div>
          <p>NYC FIRST · Workshop</p>
        </div>

        <div className="smart-photo-pad">
          <div className="smart-photo-slot" aria-hidden={!sheetPhoto}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoSrc}
              alt={photoAlt}
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>

        <section className="smart-detail-copy">
          <div className="smart-detail-copy-main">
            <h2>{drawer.item.name}</h2>
            <div>
              <b style={{ color: countColor }}>{drawer.quantity}</b>
              <span>{pluralUnit(drawer.item.unit, drawer.quantity)} in stock</span>
            </div>
          </div>
          <div className="smart-lock-switch">
            <div
              ref={trackRef}
              role="switch"
              tabIndex={lockWorking || drawer.status === "disabled" ? -1 : 0}
              aria-checked={isOpen}
              aria-label={isOpen ? "Lock drawer" : "Unlock drawer"}
              className={isOpen ? "smart-lock-track is-open" : "smart-lock-track is-locked"}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={(event) => {
                if (lockWorking || drawer.status === "disabled") return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void commitLock(!isOpen);
                }
              }}
              style={{
                opacity: lockWorking || drawer.status === "disabled" ? 0.5 : 1,
                touchAction: "none",
              }}
            >
              <span
                className="smart-lock-thumb"
                aria-hidden
                style={{
                  transform: `translateX(${slideX * TRAVEL}px)`,
                  transition: dragging ? "none" : "transform 180ms ease",
                }}
              />
            </div>
            <span className="smart-lock-caption">
              {lockWorking ? "…" : isOpen ? "Open" : "Locked"}
            </span>
          </div>
        </section>

        <div className="smart-mode-row">
          <button
            onClick={() => {
              setMode("take");
              setQty(1);
            }}
            style={{
              background: mode === "take" ? accent : t.panelBg,
              color: mode === "take" ? "#FFFDF8" : t.sub,
              borderColor: mode === "take" ? accent : t.panelBorder,
            }}
          >
            Take
          </button>
          <button
            onClick={() => {
              setMode("return");
              setQty(1);
            }}
            style={{
              background: mode === "return" ? accent : t.panelBg,
              color: mode === "return" ? "#FFFDF8" : t.sub,
              borderColor: mode === "return" ? accent : t.panelBorder,
            }}
          >
            Return
          </button>
        </div>

        <div className="smart-stepper">
          <button
            onClick={() => setQty((value) => Math.max(1, value - 1))}
            disabled={clampedQty <= 1}
          >
            -
          </button>
          <div>
            <b>{clampedQty}</b>
            <span>
              max {mode === "take" ? max : 99} {pluralUnit(drawer.item.unit, max)}
            </span>
          </div>
          <button
            onClick={() => setQty((value) => Math.min(mode === "take" ? max : 99, value + 1))}
            disabled={clampedQty >= (mode === "take" ? max : 99)}
            style={{ background: accent, color: "#FFFDF8" }}
          >
            +
          </button>
        </div>

        {error && <p className="smart-error">{error}</p>}
      </div>

      <div className="smart-detail-actions">
        <button
          type="button"
          className="smart-cta w-full"
          onClick={confirm}
          disabled={
            working ||
            lockWorking ||
            drawer.locked ||
            drawer.status === "disabled" ||
            (mode === "take" && drawer.quantity === 0)
          }
          style={{ background: accent, opacity: drawer.locked ? 0.55 : 1 }}
        >
          {working
            ? "Saving…"
            : drawer.locked
              ? "Unlock to take"
              : mode === "take"
                ? `Take ${clampedQty}`
                : `Return ${clampedQty}`}
        </button>
      </div>
    </div>
    </div>
  );
}

function pluralUnit(unit: string, quantity: number) {
  if (unit.endsWith("s")) return unit;
  if (quantity === 1) return unit;
  if (unit === "lead") return "leads";
  if (unit === "cable") return "cables";
  return `${unit}s`;
}

/** Fill meter vs a soft full line (no capacity column in the sheet). */
const STOCK_BAR_FULL = 40;

function stockMeter(quantity: number): { pct: number; color: string } {
  const pct = Math.max(0, Math.min(100, Math.round((quantity / STOCK_BAR_FULL) * 100)));
  if (pct <= 0) return { pct: 0, color: "transparent" };
  if (pct >= 50) return { pct, color: "#3E8E5A" }; // healthy
  if (pct >= 20) return { pct, color: "#C4A035" }; // mid
  return { pct, color: "#CF2233" }; // low
}
