/**
 * The floating recording bar: countdown, timer, pause and stop. It also owns the capture
 * itself (getDisplayMedia + MediaRecorder), because a stream lives in the window that opened it.
 * Everything it learns is reported to the main process through the bridge; it keeps no state
 * the main process could disagree with, apart from the timer.
 */
import { formatClock } from "../shared/format.ts";
import { RECORDER_CANCELLED } from "../shared/ipc.ts";
import type { RecorderConfig } from "../shared/ipc.ts";
import { startCapture } from "./capture.ts";
import type { CaptureHandle } from "./capture.ts";
import { h } from "./dom.ts";

type Mode = "waiting" | "countdown" | "starting" | "recording" | "paused" | "stopping" | "done";

const bridge = window.clipsmith;
const bar = document.getElementById("bar")!;

let mode: Mode = "waiting";
let handle: CaptureHandle | null = null;
let countdownLeft = 0;

// Timer: active time only (pauses excluded).
let bankedMs = 0;
let resumedAt = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
const timeEl = h("span", { class: "time" }, "0:00");

const elapsedMs = (): number => bankedMs + (mode === "recording" ? performance.now() - resumedAt : 0);
const showTime = (): void => {
  timeEl.textContent = formatClock(elapsedMs() / 1000);
};

const describe = (e: unknown): string => (e instanceof Error ? (e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message) : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function render(): void {
  switch (mode) {
    case "countdown":
      bar.replaceChildren(
        h("div", { class: "status" }, h("span", { class: "count", "aria-live": "assertive" }, String(countdownLeft)), h("span", { class: "label" }, "Inspelningen börjar strax")),
        h("button", { type: "button", onClick: cancelCountdown }, "Avbryt"),
      );
      break;
    case "starting":
      bar.replaceChildren(h("div", { class: "status" }, h("span", { class: "label" }, "Startar inspelningen")));
      break;
    case "recording":
    case "paused": {
      const paused = mode === "paused";
      bar.replaceChildren(
        h("div", { class: "status" }, h("span", { class: `dot${paused ? " paused" : ""}` }), timeEl, h("span", { class: "label" }, paused ? "Pausad" : "")),
        h("button", { type: "button", onClick: paused ? resume : pause }, paused ? "Fortsätt" : "Pausa"),
        h("button", { type: "button", class: "stop", onClick: () => void stop() }, "Stoppa"),
      );
      showTime();
      break;
    }
    case "stopping":
      bar.replaceChildren(h("div", { class: "status" }, h("span", { class: "label" }, "Sparar inspelningen")));
      break;
    default:
      bar.replaceChildren();
  }
}

function cancelCountdown(): void {
  if (mode !== "countdown") return;
  mode = "done";
  bridge.recorderError(RECORDER_CANCELLED);
}

async function begin(cfg: RecorderConfig): Promise<void> {
  if (mode !== "waiting") return;
  mode = "countdown";
  for (countdownLeft = Math.max(0, Math.round(cfg.countdownSeconds)); countdownLeft > 0; countdownLeft--) {
    render();
    await sleep(1000);
    if (mode !== "countdown") return; // cancelled
  }
  mode = "starting";
  render();
  try {
    handle = await startCapture({
      systemAudio: cfg.systemAudio,
      micDeviceId: cfg.micDeviceId,
      onChunk: (data) => bridge.recorderChunk(data),
      onEnded: () => void stop(), // the captured window was closed: keep what we have
      onError: (message) => bridge.recorderError(message),
    });
  } catch (e) {
    mode = "done";
    bridge.recorderError(describe(e));
    return;
  }
  bankedMs = 0;
  resumedAt = performance.now();
  mode = "recording";
  ticker = setInterval(showTime, 250);
  render();
  bridge.recorderStarted({ mimeType: handle.mimeType, warnings: handle.warnings });
}

function pause(): void {
  if (mode !== "recording" || !handle) return;
  bankedMs += performance.now() - resumedAt;
  handle.pause();
  mode = "paused";
  render();
  bridge.recorderState("paused");
}

function resume(): void {
  if (mode !== "paused" || !handle) return;
  resumedAt = performance.now();
  handle.resume();
  mode = "recording";
  render();
  bridge.recorderState("recording");
}

async function stop(): Promise<void> {
  if ((mode !== "recording" && mode !== "paused") || !handle) return;
  mode = "stopping";
  if (ticker) clearInterval(ticker);
  render();
  try {
    const { durationMs } = await handle.stop();
    mode = "done";
    bridge.recorderStopped({ durationMs });
  } catch (e) {
    mode = "done";
    bridge.recorderError(describe(e));
  }
}

if (!bridge) {
  bar.textContent = "Förbindelsen till huvudprocessen saknas.";
} else {
  bridge.onRecorderCommand((cmd) => {
    switch (cmd.type) {
      case "start":
        void begin(cmd.config);
        break;
      case "pause":
        pause();
        break;
      case "resume":
        resume();
        break;
      case "stop":
        void stop();
        break;
    }
  });
}
