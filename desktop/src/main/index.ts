/**
 * Electron entry point: wires the Electron-free Controller to real windows, IPC, global
 * shortcuts and OS permissions. Keep logic out of here; whatever can be tested without
 * Electron lives in controller.ts and friends.
 */
import { BrowserWindow, Menu, app, desktopCapturer, dialog, globalShortcut, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

import { PYTHON_DOWNLOAD_URL } from "../shared/engine.ts";
import { CHANNELS, SHORTCUTS } from "../shared/ipc.ts";
import type { RecorderConfig, SettingsPatch, SourceInfo, StartRequest } from "../shared/ipc.ts";
import { BackendManager } from "./backend-manager.ts";
import { ensureManagedPython } from "./python-fetch.ts";
import { Controller } from "./controller.ts";
import type { Host } from "./controller.ts";
import { ApiKeyStore } from "./secrets.ts";
import type { SecretCodec } from "./secrets.ts";
import { SessionStore } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { APP_ORIGIN, createMainWindow, createRecorderWindow, registerAppScheme, serveApp } from "./windows.ts";

registerAppScheme(); // before 'ready'

let mainWindow: BrowserWindow | null = null;
let recorderWindow: BrowserWindow | null = null;
let recorderConfig: RecorderConfig | null = null;
const closingWindows = new WeakSet<BrowserWindow>(); // recorder windows we closed on purpose
let pendingSource: { id: string; systemAudio: boolean } | null = null;
let shortcutsOk = false;
let controller: Controller;
let settingsStore: SettingsStore;

const log = (...args: unknown[]): void => console.error("[clipsmith]", ...args);
const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed();
const isOurs = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "clipsmith:" && u.host === "app";
  } catch {
    return false;
  }
};

/** Creates the main window. While a recording is running, closing it only minimises it, so the recording keeps its home. */
function openMain(): BrowserWindow {
  const win = createMainWindow();
  win.on("close", (e) => {
    const phase = controller?.getState().phase;
    if (phase === "starting" || phase === "recording" || phase === "paused") {
      e.preventDefault();
      win.minimize();
    }
  });
  return win;
}

// ---- host: what the controller needs from the OS ----------------------------------------------------

const host: Host = {
  async listSources(): Promise<SourceInfo[]> {
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
    return sources
      .filter((s) => !own.has(s.id) && s.name.trim() !== "")
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
        thumbnail: s.thumbnail.isEmpty() ? "" : `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}`,
      }))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "screen" ? -1 : 1));
  },

  selectSource(sourceId, systemAudio) {
    pendingSource = { id: sourceId, systemAudio };
  },

  openRecorder(config) {
    recorderConfig = config;
    shortcutsOk = false;
    const win = createRecorderWindow();
    recorderWindow = win;
    win.webContents.once("did-finish-load", () => win.webContents.send(CHANNELS.recorderCommand, { type: "start", config }));
    win.on("closed", () => {
      if (recorderWindow === win) recorderWindow = null;
      if (!closingWindows.has(win)) void controller.onRecorderError("inspelningsraden stängdes");
    });
  },

  commandRecorder(cmd) {
    if (alive(recorderWindow)) recorderWindow.webContents.send(CHANNELS.recorderCommand, { type: cmd });
  },

  closeRecorder() {
    pendingSource = null;
    recorderConfig = null;
    if (alive(recorderWindow)) {
      closingWindows.add(recorderWindow);
      recorderWindow.destroy();
    }
    recorderWindow = null;
  },

  setMainWindowVisible(visible) {
    if (visible) {
      if (!alive(mainWindow)) mainWindow = openMain();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (alive(mainWindow)) {
      mainWindow.minimize(); // minimised, not hidden: it stays reachable from the taskbar or dock
    }
  },

  registerShortcuts(shortcuts, handlers) {
    const stop = globalShortcut.register(shortcuts.stop, handlers.stop);
    const pause = globalShortcut.register(shortcuts.pause, handlers.pause);
    shortcutsOk = stop && pause;
    if (!shortcutsOk) log("could not register global shortcuts (taken by another app?)");
  },

  unregisterShortcuts() {
    globalShortcut.unregister(SHORTCUTS.stop);
    globalShortcut.unregister(SHORTCUTS.pause);
    shortcutsOk = false;
  },

  async chooseFolder() {
    const options = { title: "Välj mapp för resultaten", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const result = alive(mainWindow) ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },

  reveal(path) {
    shell.showItemInFolder(path);
  },

  screenPermission() {
    if (process.platform !== "darwin") return "granted";
    const status = systemPreferences.getMediaAccessStatus("screen");
    return status === "denied" || status === "restricted" ? "denied" : status === "granted" ? "granted" : "unknown";
  },

  async askMicrophone() {
    if (process.platform !== "darwin") return true;
    return systemPreferences.askForMediaAccess("microphone");
  },
};

// ---- IPC ------------------------------------------------------------------------------------------------

const fromApp = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => e.senderFrame?.url.startsWith(`${APP_ORIGIN}/renderer/`) ?? false;
const fromMain = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => alive(mainWindow) && e.sender === mainWindow.webContents && fromApp(e);
const fromRecorder = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => alive(recorderWindow) && e.sender === recorderWindow.webContents && fromApp(e);

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromMain(e)) throw new Error("Obehörig avsändare");
    return fn(...(args as A));
  });
}

function listen<A extends unknown[]>(channel: string, fn: (...args: A) => void | Promise<void>): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!fromRecorder(e)) return;
    Promise.resolve(fn(...(args as A))).catch(log);
  });
}

const background = (p: Promise<unknown>): void => void p.catch(log);

function wireIpc(): void {
  handle(CHANNELS.getState, () => controller.getState());
  handle(CHANNELS.getSettings, () => settingsStore.current);
  handle(CHANNELS.saveSettings, (patch: SettingsPatch) => controller.saveSettings(patch));
  handle(CHANNELS.setApiKey, (key: string | null) => controller.setApiKey(key === null ? null : String(key)));
  handle(CHANNELS.retryEngine, (repair: boolean) => controller.retryEngine(repair === true));
  handle(CHANNELS.openPythonDownload, () => shell.openExternal(PYTHON_DOWNLOAD_URL)); // a fixed address: the window cannot choose what to open
  handle(CHANNELS.checkServer, (url: string) => controller.checkServer(String(url)));
  handle(CHANNELS.listSources, () => controller.listSources());

  handle(CHANNELS.startRecording, (req: StartRequest) =>
    controller.startRecording({
      sourceId: String(req.sourceId),
      sourceName: String(req.sourceName),
      systemAudio: req.systemAudio === true,
      micDeviceId: req.micDeviceId === null ? null : String(req.micDeviceId ?? ""),
      hideControls: req.hideControls === true,
    }),
  );
  handle(CHANNELS.pauseRecording, () => controller.pause());
  handle(CHANNELS.resumeRecording, () => controller.resume());
  handle(CHANNELS.stopRecording, () => controller.stop());

  handle(CHANNELS.discardSession, (id: string) => controller.discardSession(String(id)));
  // Upload and job-following run for minutes; progress arrives as state pushes, so these return at once.
  handle(CHANNELS.uploadSession, (id: string) => background(controller.uploadSession(String(id))));
  handle(CHANNELS.openJob, (id: string) => background(controller.openJob(String(id))));
  handle(CHANNELS.revealSession, (id: string) => controller.revealSession(String(id)));
  handle(CHANNELS.cancel, () => controller.cancel());
  handle(CHANNELS.saveResults, () => controller.saveResults());
  handle(CHANNELS.newRecording, () => controller.newRecording());

  listen(CHANNELS.recorderStarted, async (info: { mimeType: string; warnings?: string[] }) => {
    await controller.onRecorderStarted({ mimeType: String(info.mimeType), warnings: Array.isArray(info.warnings) ? info.warnings.map(String) : undefined });
    // Hide the bar only if the stop shortcut really works, otherwise the user would have no way to stop.
    if (recorderConfig?.hideControls && shortcutsOk && controller.getState().phase === "recording" && alive(recorderWindow)) recorderWindow.hide();
  });
  listen(CHANNELS.recorderState, (state: "recording" | "paused") => controller.onRecorderState(state === "paused" ? "paused" : "recording"));
  listen(CHANNELS.recorderChunk, (data: ArrayBuffer) => controller.onRecorderChunk(new Uint8Array(data)));
  listen(CHANNELS.recorderStopped, (info: { durationMs: number }) => controller.onRecorderStopped({ durationMs: Number(info.durationMs) || 0 }));
  listen(CHANNELS.recorderError, (message: string) => controller.onRecorderError(String(message)));
}

// ---- security ------------------------------------------------------------------------------------------------

function lockDown(): void {
  const ses = session.defaultSession;
  const allowed = ["media", "display-capture"];
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed.includes(permission) && isOurs(details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.includes(permission) && isOurs(requestingOrigin));

  // Which screen or window is captured was decided in the app UI; the recorder window just asks for "a display".
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const choice = pendingSource;
      if (!choice || !alive(recorderWindow) || !request.frame?.url.startsWith(`${APP_ORIGIN}/renderer/recorder.html`)) return callback({});
      desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const video = sources.find((s) => s.id === choice.id);
          if (!video) return callback({});
          callback(choice.systemAudio ? { video, audio: "loopback" } : { video });
        })
        .catch((e: unknown) => {
          log("display media request failed", e);
          callback({});
        });
    },
    { useSystemPicker: false },
  );

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (e) => e.preventDefault());
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });
}

// ---- lifecycle -----------------------------------------------------------------------------------------------

function buildMenu(): void {
  if (process.platform === "darwin") {
    // macOS needs an Edit menu for copy/paste shortcuts to reach text fields.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---- the built-in editing engine --------------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);

/** Inside an asar archive a binary cannot be executed; electron-builder unpacks it next to the archive. */
const unpacked = (path: string): string => path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

/** Folders with the ffmpeg / ffprobe that ship with the app (npm packages ffmpeg-static and ffprobe-static). */
function bundledToolDirs(): string[] {
  const dirs: string[] = [];
  try {
    const ffmpeg = nodeRequire("ffmpeg-static") as string | null;
    if (ffmpeg) dirs.push(dirname(unpacked(ffmpeg)));
  } catch (e) {
    log("ffmpeg-static is not available, the system's ffmpeg will be used:", e instanceof Error ? e.message : e);
  }
  try {
    const probe = nodeRequire("ffprobe-static") as { path?: string };
    if (probe.path) dirs.push(dirname(unpacked(probe.path)));
  } catch (e) {
    log("ffprobe-static is not available, the system's ffprobe will be used:", e instanceof Error ? e.message : e);
  }
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

/** The OS keychain via Electron's safeStorage. On Linux without a real keyring Electron falls back to a fixed password, which is no protection. */
const secretCodec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
  encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, "base64")),
};

function createEngine(settings: SettingsStore): BackendManager {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "..");
  const bundled = bundledToolDirs();
  const fonts = [join(root, "fonts"), join(app.getAppPath(), "assets", "fonts")].find((d) => existsSync(d)) ?? null;
  return new BackendManager({
    backendDir: join(root, "backend"),
    engineDir: join(app.getPath("userData"), "engine"),
    getConfig: () => settings.engineConfig,
    // The bundled ffmpeg first; if it turns out to lack libass or libx264, the one on the system's PATH gets its chance.
    toolDirs: bundled.length ? [bundled, []] : [[]],
    fontsDir: fonts,
    // No Python on the computer (or an old one): the app fetches its own, so nobody has to install anything.
    fetchPython: (log, signal) => ensureManagedPython({ destDir: join(app.getPath("userData"), "engine", "runtime"), log, signal }),
  });
}

async function start(): Promise<void> {
  await app.whenReady();
  serveApp();
  lockDown();
  buildMenu();

  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(join(userData, "settings.json"), new ApiKeyStore(join(userData, "api-key.json"), secretCodec));
  const sessions = new SessionStore(join(app.getPath("videos"), "Clipsmith"));
  controller = new Controller({ sessions, settings: settingsStore, host, engine: createEngine(settingsStore) });
  controller.onState((s) => {
    if (alive(mainWindow)) mainWindow.webContents.send(CHANNELS.state, s);
  });
  wireIpc();
  await controller.init();

  mainWindow = openMain();
  if (process.env.CLIPSMITH_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });

  app.on("activate", () => {
    if (!alive(mainWindow)) mainWindow = openMain();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!alive(mainWindow)) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Give an in-progress recording the chance to close its file properly, and stop the engine, before the app exits.
  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting || !controller) return;
    quitting = true;
    e.preventDefault();
    controller
      .shutdown()
      .catch(log)
      .finally(() => {
        globalShortcut.unregisterAll();
        app.quit();
      });
  });

  process.on("unhandledRejection", log);
  start().catch((e: unknown) => {
    log("startup failed", e);
    dialog.showErrorBox("Clipsmith kunde inte starta", e instanceof Error ? e.message : String(e));
    app.exit(1);
  });
}
