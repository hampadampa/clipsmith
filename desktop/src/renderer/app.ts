/**
 * Main window. Plain DOM, no framework: the shell (top bar + banners) is built once, and the
 * content area is rebuilt only when the "view key" changes (tab, phase, session). Within one view
 * the state snapshots from the main process update the live parts through `View.update`, so
 * form fields and video players are never thrown away by an unrelated state change.
 */
import { CONTRACT } from "../shared/contract.generated.ts";
import { buildCutStrip } from "../shared/cutstrip.ts";
import type { Manifest } from "../shared/api.ts";
import { ENGINE_STEPS, WHISPER_MODELS } from "../shared/engine.ts";
import type { WhisperModel } from "../shared/engine.ts";
import { formatBytes, formatClock, formatPercent } from "../shared/format.ts";
import type { AppState, Phase, Settings, SourceInfo } from "../shared/ipc.ts";
import { describeStage } from "../shared/jobs.ts";
import { defaultPreferences, validatePreferences } from "../shared/preferences.ts";
import type { Preferences } from "../shared/preferences.ts";
import type { SessionMeta } from "../shared/session.ts";
import { accelerator, cleanError, h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { CAPTION_LABELS, CUT_REASON_LABELS, LANGUAGE_LABELS, NICHE_LABELS, PACE_LABELS, SESSION_STATE_LABELS } from "./labels.ts";

type Tab = "record" | "profile" | "engine";

interface View {
  el: HTMLElement;
  update?(s: AppState): void;
  dispose?(): void;
}

const BUSY: ReadonlySet<Phase> = new Set(["starting", "recording", "paused", "finalizing", "uploading", "processing"]);

let state: AppState;
let tab: Tab = "record";
let localError: string | null = null;
const dismissed = new Set<string>();
let current: { key: string; view: View } | null = null;

const bridge = window.clipsmith;
const root = document.getElementById("app")!;

// ---- remembered choices (per viewer convenience only; every read is guarded) ------------------------------

interface Ui {
  sourceId: string | null;
  systemAudio: boolean;
  mic: boolean;
  micDeviceId: string;
  hideControls: boolean;
}
const UI_KEY = "clipsmith.ui.v1";
const ui: Ui = { sourceId: null, systemAudio: true, mic: true, micDeviceId: "", hideControls: true };
try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) ?? "{}") as Partial<Ui>;
  if (typeof saved.systemAudio === "boolean") ui.systemAudio = saved.systemAudio;
  if (typeof saved.mic === "boolean") ui.mic = saved.mic;
  if (typeof saved.micDeviceId === "string") ui.micDeviceId = saved.micDeviceId;
  if (typeof saved.hideControls === "boolean") ui.hideControls = saved.hideControls;
} catch {
  /* private mode or blocked storage: defaults are fine */
}
function saveUi(): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...ui, sourceId: null }));
  } catch {
    /* ignore */
  }
}

// ---- helpers --------------------------------------------------------------------------------------

async function act(fn: () => Promise<unknown>): Promise<void> {
  localError = null;
  try {
    await fn();
  } catch (e) {
    localError = cleanError(e);
  }
  renderBanners();
}

const dateFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function setWidth(el: HTMLElement, fraction: number): void {
  el.style.width = `${Math.min(Math.max(fraction, 0), 1) * 100}%`; // CSSOM, not a style attribute: the CSP forbids those
}

function progressBar(): { el: HTMLElement; set(fraction: number | null, label: string): void } {
  const fill = h("span");
  const el = h("div", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  return {
    el,
    set(fraction, label) {
      el.classList.toggle("indeterminate", fraction === null);
      if (fraction === null) el.removeAttribute("aria-valuenow");
      else {
        setWidth(fill, fraction);
        el.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      }
      el.setAttribute("aria-valuetext", label);
    },
  };
}

function facts(rows: Array<[string, string]>): HTMLElement {
  return h("dl", { class: "facts" }, rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
}

function twoStep(label: string, confirmLabel: string, onConfirm: () => void, className = "btn link"): HTMLElement {
  const wrap = h("span", { class: "btns" });
  const show = (asking: boolean): void => {
    wrap.replaceChildren(
      ...(asking
        ? [h("button", { class: "btn danger", type: "button", onClick: onConfirm }, confirmLabel), h("button", { class: "btn link", type: "button", onClick: () => show(false) }, "Behåll")]
        : [h("button", { class: className, type: "button", onClick: () => show(true) }, label)]),
    );
  };
  show(false);
  return wrap;
}

// ---- shell -----------------------------------------------------------------------------------------

const navButtons = new Map<Tab, HTMLButtonElement>();
const engineDot = h("span", { class: "dot" });
const engineText = h("span");
const bannerSlot = h("div");
const viewSlot = h("div");

function buildShell(): void {
  const nav = h("nav", { "aria-label": "Huvudmeny" });
  for (const [t, label] of [["record", "Spela in"], ["profile", "Profil"], ["engine", "Motor"]] as const) {
    const b = h("button", { class: "btn link", type: "button", onClick: () => { tab = t; render(); } }, label);
    navButtons.set(t, b);
    nav.append(b);
  }
  const engineBtn = h("button", { class: "btn link server", type: "button", onClick: () => { tab = "engine"; render(); } }, engineDot, engineText);
  root.replaceChildren(
    h("header", { class: "top" }, h("span", { class: "brand" }, "Clipsmith"), nav, engineBtn),
    h("main", null, bannerSlot, viewSlot),
  );
}

function effectiveTab(): Tab {
  if (BUSY.has(state.phase)) return "record";
  if (state.needsProfile && tab === "record") return "profile";
  return tab;
}

function renderShell(active: Tab): void {
  const locked = BUSY.has(state.phase);
  for (const [t, b] of navButtons) {
    b.classList.toggle("active", t === active);
    if (t === active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
    b.disabled = locked || (t === "record" && state.needsProfile);
  }
  const st = engineStatus(state);
  engineDot.className = `dot ${st.dot}`;
  engineText.textContent = st.text;
}

/** One line for the top bar and the Motor tab. */
function engineStatus(s: AppState): { dot: "ok" | "bad" | ""; text: string } {
  const e = s.engine;
  if (e.mode === "external") {
    const sv = s.server;
    return { dot: sv.ok === true ? "ok" : sv.ok === false ? "bad" : "", text: sv.ok === null ? "Kontrollerar servern" : sv.ok ? `Servern svarar${sv.version ? ` (v${sv.version})` : ""}` : "Servern svarar inte" };
  }
  switch (e.phase) {
    case "ready":
      return { dot: "ok", text: `Motorn är redo${e.version ? ` (v${e.version})` : ""}` };
    case "failed":
      return { dot: "bad", text: "Motorn fungerar inte" };
    case "off":
      return { dot: "", text: "Motorn är avstängd" };
    case "starting":
      return { dot: "", text: e.restarts > 0 ? "Startar om motorn" : "Startar motorn" };
    default:
      return { dot: "", text: `Förbereder motorn (steg ${e.step} av ${ENGINE_STEPS})` };
  }
}

/** Why the recording cannot be sent right now, or null. Only the built-in engine blocks: a server of your own is simply tried. */
function sendBlock(s: AppState): string | null {
  const e = s.engine;
  if (e.mode !== "managed" || e.phase === "ready") return null;
  if (e.phase === "failed") return `Redigeringsmotorn fungerar inte${e.problem ? `: ${e.problem.title.toLowerCase()}` : ""}. Öppna fliken Motor.`;
  return "Redigeringsmotorn görs i ordning. Du kan skicka inspelningen så fort den är klar.";
}

function renderBanners(): void {
  const t = effectiveTab();
  const items: Node[] = [];
  const add = (kind: "error" | "notice", text: string | null): void => {
    if (!text || dismissed.has(text)) return;
    items.push(
      h("div", { class: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, h("div", null, text), h("button", { class: "btn link", type: "button", onClick: () => { dismissed.add(text); renderBanners(); } }, "Stäng")),
    );
  };
  if (t === "record") {
    add("error", localError ?? state.error);
    add("notice", state.notice);
    const e = state.engine;
    const open = (): void => { tab = "engine"; render(); };
    // Only on the start screen: the ready and failed views say the same thing next to their own buttons, and one alarm is enough.
    if (state.phase !== "idle") {
      /* no engine banner */
    } else if (e.mode === "managed" && e.phase === "failed") {
      items.push(h("div", { class: "banner error", role: "alert" }, h("div", null, h("strong", null, "Redigeringsmotorn fungerar inte"), e.problem?.title ?? "Se fliken Motor."), h("button", { class: "btn", type: "button", onClick: open }, "Visa hur du löser det")));
    } else if (e.mode === "managed" && e.phase !== "ready" && e.phase !== "off") {
      items.push(h("div", { class: "banner notice", role: "status" }, h("div", null, h("strong", null, "Redigeringsmotorn görs i ordning"), `${e.detail ?? "Startar"} Du kan spela in under tiden.`), h("button", { class: "btn link", type: "button", onClick: open }, "Visa")));
    }
  }
  bannerSlot.replaceChildren(...items);
}

function render(): void {
  const t = effectiveTab();
  const key = `${t}:${t === "record" ? state.phase : ""}:${t === "record" ? state.session?.id ?? "" : ""}:${state.phase === "done" ? state.job?.id ?? "" : ""}`;
  renderShell(t);
  if (!current || current.key !== key) {
    const view = t === "profile" ? profileView() : t === "engine" ? engineView() : recordView(state.phase);
    current?.view.dispose?.();
    current = { key, view };
    viewSlot.replaceChildren(view.el);
    window.scrollTo(0, 0);
  } else {
    current.view.update?.(state);
  }
  renderBanners();
}

function recordView(phase: Phase): View {
  switch (phase) {
    case "idle":
      return homeView();
    case "starting":
    case "recording":
    case "paused":
    case "finalizing":
      return recordingView(phase);
    case "ready":
      return readyView();
    case "uploading":
      return uploadView();
    case "processing":
      return processingView();
    case "done":
      return resultsView();
    case "failed":
      return failedView();
  }
}

// ---- home: pick a source, audio, start; history ---------------------------------------------------------

function homeView(): View {
  let sources: SourceInfo[] | null = null;
  let sourcesError: string | null = null;
  let mics: Array<{ id: string; label: string }> = [];

  const grid = h("div", { class: "sources" });
  const startBtn = h("button", { class: "btn primary", type: "button" }, "Starta inspelning");
  const micSelect = h("select", { "aria-label": "Välj mikrofon" });
  const historySlot = h("div");

  const canStart = (): boolean => !!ui.sourceId && (ui.systemAudio || ui.mic);
  const refreshStart = (): void => {
    startBtn.disabled = !canStart();
  };

  const renderGrid = (): void => {
    if (sourcesError) {
      grid.replaceChildren(h("p", { class: "empty" }, sourcesError));
      return;
    }
    if (sources === null) {
      grid.replaceChildren(h("p", { class: "empty" }, "Hämtar skärmar och fönster"));
      return;
    }
    if (sources.length === 0) {
      grid.replaceChildren(h("p", { class: "empty" }, "Inga skärmar eller fönster hittades. Om du använder macOS: ge Clipsmith tillåtelse att spela in skärmen under Systeminställningar, Integritet och säkerhet."));
      return;
    }
    grid.replaceChildren(
      ...sources.map((src) =>
        h(
          "button",
          { class: "source", type: "button", "aria-pressed": ui.sourceId === src.id ? "true" : "false", onClick: () => { ui.sourceId = src.id; renderGrid(); refreshStart(); } },
          src.thumbnail ? h("img", { src: src.thumbnail, alt: "" }) : h("span", { class: "blank" }),
          h("span", { class: "name" }, src.name),
          h("span", { class: "kind" }, src.kind === "screen" ? "Hel skärm" : "Fönster"),
        ),
      ),
    );
  };

  const loadSources = async (): Promise<void> => {
    sources = null;
    sourcesError = null;
    renderGrid();
    try {
      sources = await bridge.listSources();
      if (!sources.some((s) => s.id === ui.sourceId)) ui.sourceId = sources.find((s) => s.kind === "screen")?.id ?? sources[0]?.id ?? null;
    } catch (e) {
      sourcesError = `Kunde inte lista skärmar och fönster: ${cleanError(e)}`;
    }
    renderGrid();
    refreshStart();
  };

  const renderMics = (): void => {
    micSelect.replaceChildren(h("option", { value: "" }, "Standardmikrofon"), ...mics.map((m) => h("option", { value: m.id }, m.label)));
    micSelect.value = mics.some((m) => m.id === ui.micDeviceId) ? ui.micDeviceId : "";
    micSelect.disabled = !ui.mic;
  };
  const loadMics = async (): Promise<void> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      mics = all
        .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }));
    } catch {
      mics = [];
    }
    renderMics();
  };

  micSelect.addEventListener("change", () => { ui.micDeviceId = micSelect.value; saveUi(); });

  startBtn.addEventListener("click", () => {
    const src = sources?.find((s) => s.id === ui.sourceId);
    if (!src) return;
    startBtn.disabled = true;
    void act(() => bridge.startRecording({ sourceId: src.id, sourceName: src.name, systemAudio: ui.systemAudio, micDeviceId: ui.mic ? ui.micDeviceId : null, hideControls: ui.hideControls })).finally(refreshStart);
  });

  const checkbox = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string, extra?: Child): HTMLElement =>
    h(
      "div",
      null,
      h("div", { class: "toggle" }, h("label", null, h("input", { type: "checkbox", checked, onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), h("span", null, label)), extra),
      hint && h("p", { class: "hint sub" }, hint),
    );

  // Rebuilt only when it would look different: engine progress pushes state many times a second, and a rebuild
  // would throw away a half-finished "Ta bort -> Ta bort filen" confirmation.
  let historySig = "";
  const historyView = (s: AppState): void => {
    const blocked = sendBlock(s) !== null;
    const sig = JSON.stringify([s.sessions, blocked]);
    if (sig === historySig) return;
    historySig = sig;
    if (s.sessions.length === 0) {
      historySlot.replaceChildren(h("p", { class: "empty" }, "Inga inspelningar ännu."));
      return;
    }
    historySlot.replaceChildren(h("div", { class: "history" }, s.sessions.map((m) => historyRow(m, blocked))));
  };

  const keyNote = h("div");
  const noKeyNotice = (s: AppState): void => {
    const show = s.engine.mode === "managed" && !s.hasApiKey;
    keyNote.replaceChildren(show ? h("div", { class: "banner notice" }, h("div", null, h("strong", null, "Ingen AI-nyckel än"), "Utan nyckel tar Clipsmith bara bort tystnad, utfyllnadsord och tydliga omtagningar, och videon blir inte kortare än så. För att få den nedkortad mot ditt mål och bättre shorts, lägg in en nyckel under Motor."), h("button", { class: "btn", type: "button", onClick: () => { tab = "engine"; render(); } }, "Öppna Motor")) : "");
  };

  const sc = state.shortcuts;
  const el = h(
    "div",
    null,
    h("h1", null, "Spela in"),
    h("p", { class: "lead" }, "Välj vad som ska spelas in. Prata på som vanligt, tagningar och tystnad klipps bort efteråt."),
    keyNote,
    h("div", { class: "row" }, h("h2", { class: "tight" }, "Vad ska spelas in?"), h("button", { class: "btn link", type: "button", onClick: () => void loadSources() }, "Uppdatera")),
    grid,
    h("h2", null, "Ljud"),
    h("div", { class: "toggles" },
      checkbox("Mikrofon", ui.mic, (v) => { ui.mic = v; saveUi(); micSelect.disabled = !v; refreshStart(); }, undefined, micSelect),
      checkbox("Systemljud", ui.systemAudio, (v) => { ui.systemAudio = v; saveUi(); refreshStart(); }, "Fungerar på Windows och nyare macOS. Går det inte att fånga systemljud spelas bara mikrofonen in och du får veta det."),
    ),
    h("h2", null, "Under inspelningen"),
    h("div", { class: "toggles" },
      checkbox("Göm inspelningsraden", ui.hideControls, (v) => { ui.hideControls = v; saveUi(); },
        `Raden döljs när nedräkningen är klar. Stoppa med ${accelerator(sc.stop)} och pausa med ${accelerator(sc.pause)}. Välj det här när du spelar in en hel skärm, annars kan raden hamna i videon. Vid fönsterinspelning syns den aldrig.`),
    ),
    h("div", { class: "actions sticky" }, startBtn, h("span", { class: "hint flush" }, "Det räknas ned tre sekunder innan inspelningen börjar.")),
    h("h2", null, "Tidigare inspelningar"),
    h("p", { class: "hint flush" }, state.engine.mode === "managed"
      ? "Att ta bort en inspelning raderar filen på den här datorn och, om den redan är redigerad, resultaten i motorn. Spara resultaten först om du vill behålla dem."
      : "Att ta bort en inspelning raderar bara filen på den här datorn. Färdiga resultat ligger kvar på servern."),
    historySlot,
  );

  renderGrid();
  renderMics();
  refreshStart();
  historyView(state);
  noKeyNotice(state);
  void loadSources();
  void loadMics();
  const onDevices = (): void => void loadMics();
  navigator.mediaDevices?.addEventListener("devicechange", onDevices);

  return {
    el,
    update: (s) => { historyView(s); noKeyNotice(s); },
    dispose: () => navigator.mediaDevices?.removeEventListener("devicechange", onDevices),
  };
}

function historyRow(m: SessionMeta, blocked: boolean): HTMLElement {
  const label = m.jobId ? "Uppladdad" : SESSION_STATE_LABELS[m.state] ?? m.state;
  const buttons: Child[] = [];
  const why = blocked ? "Redigeringsmotorn är inte redo än. Se fliken Motor." : null;
  if (m.jobId) buttons.push(h("button", { class: "btn", type: "button", disabled: blocked, title: why, onClick: () => void act(() => bridge.openJob(m.id)) }, "Visa resultat"));
  else if (m.ext && m.bytes > 0) buttons.push(h("button", { class: "btn", type: "button", disabled: blocked, title: why, onClick: () => void act(() => bridge.uploadSession(m.id)) }, "Skicka till redigering"));
  if (m.ext) buttons.push(h("button", { class: "btn link", type: "button", onClick: () => void act(() => bridge.revealSession(m.id)) }, "Visa fil"));
  buttons.push(twoStep("Ta bort", "Ta bort filen", () => void act(() => bridge.discardSession(m.id))));
  return h(
    "div",
    { class: "hrow" },
    h("div", { class: "what" },
      h("div", { class: "when" }, dateFmt.format(m.createdAt)),
      h("div", { class: "meta num" }, h("span", null, m.sourceName), h("span", null, m.durationMs != null ? formatClock(m.durationMs / 1000) : "okänd längd"), h("span", null, formatBytes(m.bytes)), h("span", null, label)),
    ),
    h("div", { class: "btns" }, buttons),
  );
}

// ---- recording / finalizing --------------------------------------------------------------------------

function recordingView(phase: Phase): View {
  const sc = state.shortcuts;
  if (phase === "starting" || phase === "finalizing") {
    const bar = progressBar();
    bar.set(null, "Vänta");
    return {
      el: h("div", null, h("h1", null, phase === "starting" ? "Förbereder inspelningen" : "Sparar inspelningen"), h("p", { class: "lead" }, phase === "starting" ? "Fönstret med inspelningsknappar öppnas strax." : "Filen skrivs klart. Det tar några sekunder."), bar.el),
    };
  }
  const paused = phase === "paused";
  return {
    el: h(
      "div",
      null,
      h("h1", null, h("span", { class: `rec-dot${paused ? " paused" : ""}` }), paused ? "Pausad" : "Spelar in"),
      h("p", { class: "lead" }, `Källa: ${state.session?.sourceName ?? ""}. Stoppa med ${accelerator(sc.stop)}, pausa med ${accelerator(sc.pause)}.`),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", onClick: () => void act(() => bridge.stopRecording()) }, "Stoppa"),
        h("button", { class: "btn", type: "button", onClick: () => void act(() => (paused ? bridge.resumeRecording() : bridge.pauseRecording())) }, paused ? "Fortsätt" : "Pausa"),
      ),
    ),
  };
}

// ---- ready: a finished recording waiting to be sent ---------------------------------------------------

function readyView(): View {
  const m = state.session!;
  const hint = h("p", { class: "hint", role: "status" });
  const send = h("button", { class: "btn primary", type: "button", onClick: () => void act(() => bridge.uploadSession(m.id)) }, "Skicka till redigering");
  const openEngine = h("button", { class: "btn", type: "button", onClick: () => { tab = "engine"; render(); } }, "Öppna Motor");
  const update = (s: AppState): void => {
    const block = sendBlock(s);
    send.disabled = block !== null;
    openEngine.hidden = block === null;
    hint.hidden = false;
    hint.textContent = block ?? (s.engine.mode === "external" && s.server.ok === false ? "Servern svarar inte just nu. Kontrollera fliken Motor innan du skickar." : "");
    hint.hidden = hint.textContent === "";
  };
  update(state);
  return {
    el: h(
      "div",
      null,
      h("h1", null, "Inspelningen är sparad"),
      h("p", { class: "lead" }, "Skicka den till redigering när du är redo. Filen ligger kvar på datorn även om något går fel."),
      facts([
        ["Källa", m.sourceName],
        ["Längd", m.durationMs != null ? formatClock(m.durationMs / 1000) : "okänd"],
        ["Storlek", formatBytes(m.bytes)],
      ]),
      hint,
      h("div", { class: "actions" },
        send,
        openEngine,
        h("button", { class: "btn", type: "button", onClick: () => void act(() => bridge.revealSession(m.id)) }, "Visa filen"),
        twoStep("Ta bort", "Ta bort filen", () => void act(() => bridge.discardSession(m.id))),
        h("button", { class: "btn link", type: "button", onClick: () => void act(() => bridge.newRecording()) }, "Tillbaka"),
      ),
    ),
    update,
  };
}

// ---- uploading & processing ----------------------------------------------------------------------------

function uploadView(): View {
  const bar = progressBar();
  const left = h("span");
  const right = h("span", { class: "num" });
  const update = (s: AppState): void => {
    const u = s.upload;
    if (!u || u.total === 0) {
      bar.set(null, "Förbereder");
      left.textContent = "Förbereder";
      right.textContent = "";
      return;
    }
    const f = u.sent / u.total;
    const finished = u.sent >= u.total;
    bar.set(finished ? null : f, formatPercent(f));
    left.textContent = finished ? "Motorn tar emot filen" : `${formatBytes(u.sent)} av ${formatBytes(u.total)}`;
    right.textContent = finished ? "" : formatPercent(f);
  };
  update(state);
  return {
    el: h(
      "div",
      null,
      h("h1", null, "Skickar inspelningen"),
      h("p", { class: "lead" }, "Filen skickas till redigeringsmotorn. Lämna appen öppen tills det är klart."),
      bar.el,
      h("div", { class: "progress-meta" }, left, right),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => void act(() => bridge.cancel()) }, "Avbryt")),
    ),
    update,
  };
}

function processingView(): View {
  const bar = progressBar();
  const stage = h("span");
  const pct = h("span", { class: "num" });
  const update = (s: AppState): void => {
    const job = s.job;
    if (!job) {
      bar.set(null, "Hämtar status");
      stage.textContent = "Hämtar status";
      pct.textContent = "";
      return;
    }
    stage.textContent = describeStage(job.stage, job.status);
    const waiting = job.progress <= 0 && job.status !== "processing";
    bar.set(waiting ? null : job.progress, formatPercent(job.progress));
    pct.textContent = waiting ? "" : formatPercent(job.progress);
  };
  update(state);
  return {
    el: h(
      "div",
      null,
      h("h1", null, "Redigerar"),
      h("p", { class: "lead" }, "Motorn skriver ut talet, väljer vad som ska bort och klipper videorna. Det kan ta en stund för långa inspelningar."),
      bar.el,
      h("div", { class: "progress-meta" }, stage, pct),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: () => void act(() => bridge.cancel()) }, "Sluta vänta"),
        h("span", { class: "hint flush" }, state.engine.mode === "managed" ? "Motorn fortsätter så länge appen är öppen. Du hittar jobbet under Tidigare inspelningar." : "Servern fortsätter ändå. Du hittar jobbet under Tidigare inspelningar."),
      ),
    ),
    update,
  };
}

// ---- results -----------------------------------------------------------------------------------------

function describeCuts(cuts: Manifest["main"]["cuts"]): string {
  const counts = new Map<string, number>();
  for (const c of cuts) counts.set(c.reason, (counts.get(c.reason) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => {
      const [one, many] = CUT_REASON_LABELS[reason] ?? [reason, reason];
      return `${n} ${n === 1 ? one : many}`;
    })
    .join(", ");
}

function resultsView(): View {
  const job = state.job;
  const manifest = job?.result ?? null;
  if (!job || !manifest) {
    return { el: h("div", null, h("h1", null, "Klart"), h("p", { class: "lead" }, "Servern returnerade inget resultat att visa."), h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => void act(() => bridge.newRecording()) }, "Tillbaka"))) };
  }
  // "#t=0.1" makes the browser paint the first frame, so the players are not black boxes before they are played.
  const url = (name: string, base = state.server.url): string => `${base}/jobs/${job.id}/files/${encodeURIComponent(name)}#t=0.1`;
  const players: Array<{ el: HTMLVideoElement; name: string }> = [];
  const player = (name: string, props: Record<string, string | boolean>): HTMLVideoElement => {
    const el = h("video", { ...props, controls: true, preload: "metadata", src: url(name) });
    players.push({ el, name });
    return el;
  };
  let playersBase = state.server.url;
  const { main, source } = manifest;
  const strip = state.edl ? buildCutStrip(state.edl, source.duration) : null;

  const stripEl = strip && strip.segments.length > 0 ? h("div", { class: "strip", role: "img", "aria-label": `Klippkarta: ${formatPercent(strip.removedShare)} av inspelningen klipptes bort` }) : null;
  if (stripEl && strip) {
    for (const sg of strip.segments) {
      const seg = h("div", { class: `seg ${sg.kept ? "kept" : "cut"}` });
      seg.style.left = `${sg.from * 100}%`;
      seg.style.width = `${(sg.to - sg.from) * 100}%`;
      stripEl.append(seg);
    }
  }

  const saved = h("p", { class: "saved", role: "status" });
  const reasons = describeCuts(main.cuts);

  return {
    el: h(
      "div",
      null,
      h("h1", null, "Klart"),
      h("p", { class: "lead num" },
        `Huvudvideon blev ${formatClock(main.duration)} av ${formatClock(source.duration)} inspelat material`,
        strip ? `, ${formatPercent(strip.removedShare)} klipptes bort.` : ".",
        manifest.shorts.length ? ` ${manifest.shorts.length}\u00a0${manifest.shorts.length === 1 ? "short" : "shorts"} i stående format.` : ""),
      stripEl ?? h("p", { class: "hint" }, "Klippkartan kunde inte hämtas."),
      stripEl && h("div", { class: "strip-scale" }, h("span", null, "0:00"), h("span", null, formatClock(source.duration))),
      stripEl && strip && h("div", { class: "legend num" }, h("span", { class: "k" }, `Behållet ${formatClock(strip.keptSeconds)}`), h("span", { class: "c" }, `Borttaget ${formatClock(strip.removedSeconds)}`)),
      reasons && h("p", { class: "reasons" }, `Borttaget: ${reasons}.`),
      manifest.storyline && h("p", { class: "reasons" }, `Röd tråd: ${manifest.storyline}`),
      h("h2", null, "Huvudvideo"),
      player(main.file, { class: "main-video" }),
      manifest.shorts.length > 0 && h("h2", null, "Shorts"),
      manifest.shorts.length > 0 &&
        h("div", { class: "shorts" },
          manifest.shorts.map((sh) =>
            h("figure", null,
              player(sh.file, {}),
              h("figcaption", null, h("strong", null, sh.title), h("span", { class: "num" }, formatClock(sh.duration)), h("span", { class: "hint" }, sh.reason)),
            ),
          ),
        ),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", onClick: () => void act(async () => { const p = await bridge.saveResults(); if (p) saved.textContent = `Sparat i ${p}`; }) }, "Spara alla filer"),
        h("button", { class: "btn", type: "button", onClick: () => void act(() => bridge.newRecording()) }, "Spela in något nytt"),
      ),
      saved,
    ),
    // The built-in engine can restart on another port; point the players at wherever the files are now.
    update: (s) => {
      if (!s.server.url || s.server.url === playersBase) return;
      playersBase = s.server.url;
      for (const p of players) p.el.src = url(p.name, playersBase);
    },
  };
}

// ---- failed ------------------------------------------------------------------------------------------

function failedView(): View {
  const m = state.session;
  const buttons: Child[] = [];
  if (m?.jobId) buttons.push(h("button", { class: "btn primary", type: "button", onClick: () => void act(() => bridge.openJob(m.id)) }, "Försök hämta resultatet igen"));
  else if (m && m.ext && m.bytes > 0) buttons.push(h("button", { class: "btn primary", type: "button", onClick: () => void act(() => bridge.uploadSession(m.id)) }, "Skicka till redigering igen"));
  const engineDown = state.engine.mode === "managed" ? state.engine.phase !== "ready" : state.server.ok === false;
  if (engineDown) buttons.push(h("button", { class: "btn", type: "button", onClick: () => { tab = "engine"; render(); } }, "Öppna Motor"));
  buttons.push(h("button", { class: buttons.length ? "btn link" : "btn primary", type: "button", onClick: () => void act(() => bridge.newRecording()) }, "Tillbaka"));
  return {
    el: h("div", null, h("h1", null, "Det gick inte"), h("p", { class: "lead" }, m && m.bytes > 0 ? "Inspelningen finns kvar på datorn." : "Ingen inspelning sparades."), h("div", { class: "actions" }, buttons)),
  };
}

// ---- profile -------------------------------------------------------------------------------------------

function radioGroup<T extends string>(opts: { name: string; legend: string; intro: string; options: readonly T[]; labels: Record<T, { title: string; desc: string }>; value: T; onPick(v: T): void; sample?(v: T): Child }): HTMLElement {
  return h(
    "fieldset",
    null,
    h("legend", null, opts.legend),
    h("p", { class: "hint first" }, opts.intro),
    h(
      "div",
      { class: "choices", role: "radiogroup" },
      opts.options.map((o) =>
        h("label", { class: "choice" },
          h("input", { type: "radio", name: opts.name, value: o, checked: o === opts.value, onChange: () => opts.onPick(o) }),
          h("span", { class: "title" }, opts.labels[o].title),
          h("span", { class: "desc" }, opts.labels[o].desc),
          opts.sample?.(o),
        ),
      ),
    ),
  );
}

function captionSample(style: string): Child {
  if (style === "none") return null;
  if (style === "karaoke") return h("span", { class: "caption-sample karaoke" }, "Det här ", h("span", { class: "rest" }, "funkar bra"));
  if (style === "minimal") return h("span", { class: "caption-sample minimal" }, "Det här funkar bra");
  return h("span", { class: "caption-sample" }, "Det här ", h("span", { class: "on" }, "FUNKAR"), " bra");
}

function profileView(): View {
  const el = h("div", null, h("p", { class: "lead" }, "Hämtar profilen"));
  const first = state.needsProfile;
  void bridge.getSettings().then((settings) => {
    const draft: Preferences = { ...(settings.preferences ?? defaultPreferences()) };
    const [minT, maxT] = CONTRACT.limits.target_minutes;
    const [minS, maxS] = CONTRACT.limits.num_shorts;
    const maxNotes = CONTRACT.limits.niche_notes_max_chars;

    const minutesOut = h("output", null, `${draft.target_minutes} min`);
    const shortsOut = h("output", null, `${draft.num_shorts} st`);
    const counter = h("div", { class: "counter" }, `${draft.niche_notes.length} / ${maxNotes}`);
    const errorsSlot = h("div");
    const savedNote = h("span", { class: "saved", role: "status" });

    const fillers = h("select", { id: "fillers", value: draft.remove_fillers === null ? "auto" : draft.remove_fillers ? "yes" : "no" },
      h("option", { value: "auto" }, "Låt tempot avgöra"), h("option", { value: "yes" }, "Ta bort utfyllnadsord som eh och öh"), h("option", { value: "no" }, "Behåll utfyllnadsord"));
    fillers.addEventListener("change", () => { draft.remove_fillers = fillers.value === "auto" ? null : fillers.value === "yes"; });

    const language = h("select", { id: "language", value: draft.language }, CONTRACT.languages.map((l) => h("option", { value: l }, LANGUAGE_LABELS[l] ?? l)));
    language.addEventListener("change", () => { draft.language = language.value; });

    const form = h(
      "form",
      { novalidate: true },
      radioGroup({ name: "niche", legend: "Vad gör du för videor?", intro: "Styr vad AI:n räknar som onödigt och vad den vill behålla.", options: CONTRACT.niches, labels: NICHE_LABELS, value: draft.niche, onPick: (v) => { draft.niche = v; } }),
      h("div", { class: "field" },
        h("label", { for: "notes" }, "Något AI:n bör veta om dig? (valfritt)"),
        h("textarea", { id: "notes", maxlength: maxNotes, value: draft.niche_notes, placeholder: "Till exempel: jag lagar Volvo från 90-talet, nämn aldrig sponsorer, behåll alltid skämten.", onInput: (e: Event) => { draft.niche_notes = (e.target as HTMLTextAreaElement).value; counter.textContent = `${draft.niche_notes.length} / ${maxNotes}`; } }),
        counter,
      ),
      h("div", { class: "spacer" }),
      radioGroup({ name: "pace", legend: "Hur hårt ska det klippas?", intro: "Du kan alltid ändra det här senare.", options: CONTRACT.paces, labels: PACE_LABELS, value: draft.pace, onPick: (v) => { draft.pace = v; } }),
      h("div", { class: "field" }, h("label", { for: "fillers" }, "Utfyllnadsord"), fillers),
      h("div", { class: "spacer" }),
      radioGroup({ name: "caption", legend: "Undertexter på shorts", intro: "Exemplen visar ungefär hur texten ser ut.", options: CONTRACT.caption_styles, labels: CAPTION_LABELS, value: draft.caption_style, onPick: (v) => { draft.caption_style = v; }, sample: captionSample }),
      h("h2", null, "Längd och språk"),
      h("div", { class: "field" }, h("label", { for: "language" }, "Språk i inspelningen"), language),
      h("div", { class: "field" }, h("label", { for: "minutes" }, "Mål för huvudvideon"),
        h("div", { class: "row" }, h("input", { id: "minutes", type: "range", min: minT, max: maxT, step: 1, value: draft.target_minutes, onInput: (e: Event) => { draft.target_minutes = Number((e.target as HTMLInputElement).value); minutesOut.textContent = `${draft.target_minutes} min`; } }), minutesOut),
        h("p", { class: "hint" }, "AI:n siktar på ungefär den här längden men klipper aldrig bort bra innehåll bara för att nå den.")),
      h("div", { class: "field" }, h("label", { for: "shorts" }, "Antal shorts"),
        h("div", { class: "row" }, h("input", { id: "shorts", type: "range", min: minS, max: maxS, step: 1, value: draft.num_shorts, onInput: (e: Event) => { draft.num_shorts = Number((e.target as HTMLInputElement).value); shortsOut.textContent = `${draft.num_shorts} st`; } }), shortsOut)),
      errorsSlot,
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit" }, first ? "Spara och fortsätt" : "Spara profil"), savedNote),
    );

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      savedNote.textContent = "";
      const errors = validatePreferences(draft);
      errorsSlot.replaceChildren(errors.length ? h("ul", { class: "errors", role: "alert" }, errors.map((m) => h("li", null, m))) : "");
      if (errors.length) return;
      void bridge
        .saveSettings({ preferences: draft })
        .then(() => {
          if (first) { tab = "record"; render(); }
          else savedNote.textContent = "Profilen är sparad. Den gäller nästa gång du skickar en inspelning.";
        })
        .catch((err: unknown) => { errorsSlot.replaceChildren(h("ul", { class: "errors", role: "alert" }, h("li", null, cleanError(err)))); });
    });

    el.replaceChildren(
      h("h1", null, first ? "Berätta hur du vill ha dina videor" : "Profil"),
      h("p", { class: "lead" }, first ? "AI:n använder det här när den väljer vad som klipps bort och hur undertexterna ser ut. Det tar en minut och går att ändra när som helst." : "Så här redigerar AI:n dina inspelningar."),
      form,
    );
  }).catch((e: unknown) => { el.replaceChildren(h("p", { class: "lead" }, `Kunde inte läsa profilen: ${cleanError(e)}`)); });
  return { el };
}

// ---- engine ("Motor") -----------------------------------------------------------------------------------

const ENGINE_STEP_LABELS = ["Letar efter Python", "Installerar Python och paketen", "Hämtar taligenkänning", "Startar motorn"] as const;
const SETUP_PHASES: ReadonlySet<string> = new Set(["preparing", "installing", "model", "starting"]);
const MODEL_LABELS: Record<WhisperModel, { title: string; desc: string }> = Object.fromEntries(
  WHISPER_MODELS.map((m) => [m.id, { title: `${m.label} (${m.size})`, desc: m.note }]),
) as Record<WhisperModel, { title: string; desc: string }>;

function engineView(): View {
  const dot = h("span", { class: "dot" });
  const statusText = h("span");
  const steps = h("ol", { class: "steps", "aria-label": "Steg i förberedelsen" });
  const detail = h("p", { class: "hint flush", role: "status" });
  const problemSlot = h("div");
  const logPre = h("pre", { class: "logbox", tabindex: 0, "aria-label": "Logg från motorn" });
  const logBox = h("details", { class: "log" }, h("summary", null, "Visa logg"), logPre);
  const feedback = h("p", { class: "hint feedback", role: "status" });
  const settingsSlot = h("div");
  const restart = h("button", { class: "btn link", type: "button", onClick: () => void run(() => bridge.retryEngine(false), "Motorn startar om.") }, "Starta om motorn");

  let problemSig = "";
  let logOpened = false;

  /** Runs a settings action and reports the outcome here: banners are not shown on this tab. */
  async function run(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    feedback.textContent = "";
    try {
      await fn();
      feedback.textContent = done;
      return true;
    } catch (e) {
      feedback.textContent = cleanError(e);
      return false;
    }
  }

  const update = (s: AppState): void => {
    const e = s.engine;
    const st = engineStatus(s);
    dot.className = `dot ${st.dot}`;
    statusText.textContent = st.text;
    const setup = e.mode === "managed" && SETUP_PHASES.has(e.phase) && e.step > 0;

    steps.hidden = !setup;
    if (setup) {
      steps.replaceChildren(...ENGINE_STEP_LABELS.map((label, i) => h("li", { "data-state": i + 1 < e.step ? "done" : i + 1 === e.step ? "active" : "todo" }, label)));
    }
    detail.textContent = setup ? (e.detail ?? "") : "";
    restart.hidden = !(e.mode === "managed" && e.phase === "ready");

    const sig = e.mode === "managed" ? `${e.phase}|${JSON.stringify(e.problem)}` : "external";
    if (sig !== problemSig) {
      problemSig = sig;
      const p = e.mode === "managed" ? e.problem : null;
      problemSlot.replaceChildren(
        p
          ? h("div", { class: "problem", role: "alert" },
              h("strong", null, p.title),
              h("p", { class: "flush" }, p.hint),
              h("div", { class: "actions tight" },
                p.pythonDownload && h("button", { class: "btn primary", type: "button", onClick: () => void run(() => bridge.openPythonDownload(), "") }, "Öppna python.org"),
                h("button", { class: p.pythonDownload ? "btn" : "btn primary", type: "button", onClick: () => void run(() => bridge.retryEngine(false), "Försöker igen.") }, "Försök igen"),
                h("button", { class: "btn", type: "button", onClick: () => void run(() => bridge.retryEngine(true), "Installerar om från början.") }, "Reparera installationen"),
              ))
          : "",
      );
      if (p && !logOpened) {
        logBox.open = true;
        logOpened = true;
      }
    }

    const text = e.mode === "managed" ? e.log.join("\n") : "";
    logBox.hidden = e.mode !== "managed" || e.log.length === 0;
    if (logPre.textContent !== text) {
      const atBottom = logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight < 24;
      logPre.textContent = text;
      if (atBottom) logPre.scrollTop = logPre.scrollHeight;
    }
  };

  // ---- settings: rebuilt only after the person changes something, never by progress pushes ----------------
  const buildSettings = (cfg: Settings): void => {
    const external = cfg.engine.mode === "external";
    const parts: Child[] = [];

    if (!external) {
      parts.push(
        radioGroup({
          name: "model",
          legend: "Taligenkänning",
          intro: "Modellen som skriver ut vad du säger. Den hämtas en gång och sparas i appens egen mapp. Att byta modell startar om motorn.",
          options: WHISPER_MODELS.map((m) => m.id),
          labels: MODEL_LABELS,
          value: cfg.engine.whisperModel,
          onPick: (v) => void run(() => bridge.saveSettings({ engine: { whisperModel: v } }), "Modellen byts. Motorn startar om och hämtar den vid behov.").then(() => refresh()),
        }),
      );

      const keyInput = h("input", { id: "apikey", type: "password", autocomplete: "off", spellcheck: "false", placeholder: cfg.engine.hasApiKey ? "Klistra in en ny nyckel för att byta" : "sk-ant-…" });
      const form = h("form", { novalidate: true },
        h("div", { class: "field" }, h("label", { for: "apikey" }, "API-nyckel från Anthropic"), keyInput),
        h("div", { class: "actions tight" },
          h("button", { class: "btn", type: "submit" }, cfg.engine.hasApiKey ? "Byt nyckel" : "Spara nyckeln"),
          cfg.engine.hasApiKey && twoStep("Ta bort nyckeln", "Ta bort nyckeln", () => void run(() => bridge.setApiKey(null), "Nyckeln är borttagen. Motorn startar om.").then(() => refresh())),
        ),
      );
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const value = keyInput.value;
        if (!value.trim()) {
          feedback.textContent = "Klistra in nyckeln först.";
          return;
        }
        void run(() => bridge.setApiKey(value), "Nyckeln är sparad. Motorn startar om för att använda den.").then((ok) => {
          if (!ok) return; // keep what was typed so the person can fix it instead of pasting again
          keyInput.value = "";
          return refresh();
        });
      });
      parts.push(
        h("h2", null, "AI-redigering"),
        h("p", { class: "hint first" }, "Med en API-nyckel från Anthropic (console.anthropic.com) bestämmer AI:n vad som är onödigt, kortar huvudvideon mot ditt mål och väljer de bästa klippen till shorts. Utan nyckel används en enklare regelbaserad redigering: tystnad, utfyllnadsord och tydliga omtagningar tas bort, men videon blir inte kortare än så."),
        h("p", { class: "hint" },
          cfg.engine.hasApiKey ? "En nyckel är sparad." : "Ingen nyckel är sparad.",
          cfg.engine.keyStorage === "encrypted" && " Den är krypterad med datorns nyckelring.",
          cfg.engine.keyStorage === "plain" && " Datorn har ingen säker nyckelring, så nyckeln ligger i en fil som bara ditt konto kan läsa.",
          " Nyckeln skickas bara till Anthropic, aldrig någon annanstans.",
        ),
        form,
      );
    } else {
      parts.push(h("p", { class: "hint first" }, "Du använder en egen server. Taligenkänning och nyckel ställs in på den servern."));
    }

    // Advanced: point the app at a backend of your own instead.
    const urlInput = h("input", { id: "url", type: "text", spellcheck: "false", autocomplete: "off", value: cfg.serverUrl });
    const result = h("p", { class: "hint", role: "status" });
    const test = h("button", { class: "btn", type: "button" }, "Testa anslutningen");
    test.addEventListener("click", () => {
      test.disabled = true;
      result.textContent = "Testar";
      void bridge
        .checkServer(urlInput.value)
        .then((r) => { result.textContent = r.ok ? `Servern svarar${r.version ? ` (version ${r.version})` : ""}.` : r.error ?? "Servern svarar inte."; })
        .catch((err: unknown) => { result.textContent = cleanError(err); })
        .finally(() => { test.disabled = false; });
    });
    const useOwn = h("input", { type: "checkbox", id: "own-server", checked: external });
    useOwn.addEventListener("change", () => {
      void run(() => bridge.saveSettings({ engine: { mode: useOwn.checked ? "external" : "managed" } }), useOwn.checked ? "Clipsmith använder nu din egen server." : "Clipsmith använder nu den inbyggda motorn.").then(() => refresh());
    });
    const urlForm = h("form", { novalidate: true },
      h("div", { class: "field" }, h("label", { for: "url" }, "Serverns adress"), urlInput),
      h("div", { class: "actions tight" }, h("button", { class: "btn", type: "submit" }, "Spara adressen"), test),
      result,
    );
    urlForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      result.textContent = "";
      void bridge.saveSettings({ serverUrl: urlInput.value }).then((saved) => { urlInput.value = saved.serverUrl; result.textContent = "Adressen är sparad."; }).catch((err: unknown) => { result.textContent = cleanError(err); });
    });
    const advanced = h("details", { class: "advanced" },
      h("summary", null, "Avancerat: använd en egen server"),
      h("div", { class: "toggle" }, h("label", null, useOwn, h("span", null, "Använd min egen server i stället för den inbyggda motorn"))),
      h("p", { class: "hint sub" }, "Starta den med ", h("code", null, "uvicorn clipsmith.api.app:app --factory"), " (se backend/README.md). Standardadressen är ", h("code", null, "http://localhost:8000"), "."),
      external && urlForm,
    );
    advanced.open = external;
    parts.push(advanced);
    settingsSlot.replaceChildren(h("div", null, parts)); // h() drops the `false` entries
  };

  const refresh = async (): Promise<void> => {
    try {
      buildSettings(await bridge.getSettings());
    } catch (e) {
      settingsSlot.replaceChildren(h("p", { class: "hint" }, `Kunde inte läsa inställningarna: ${cleanError(e)}`));
    }
  };

  update(state);
  void refresh();
  return {
    el: h("div", null,
      h("h1", null, "Motor"),
      h("p", { class: "lead" }, "Motorn skriver ut vad du säger och klipper videorna. Den körs inne i Clipsmith på din dator, så du behöver inte starta något separat."),
      h("div", { class: "engine-status" }, dot, statusText, restart),
      steps,
      detail,
      problemSlot,
      logBox,
      feedback,
      settingsSlot,
    ),
    update,
  };
}

// ---- boot ---------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!bridge) throw new Error("Förbindelsen till huvudprocessen saknas (preload laddades inte).");
  state = await bridge.getState();
  buildShell();
  bridge.onState((s) => {
    state = s;
    render();
  });
  render();
}

main().catch((e: unknown) => {
  root.replaceChildren(h("main", null, h("h1", null, "Appen kunde inte starta"), h("p", { class: "lead" }, cleanError(e))));
});
