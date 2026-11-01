/**
 * Window factories and the app:// protocol. The only module (besides index.ts) that touches Electron.
 *
 * The UI is served from a custom `clipsmith://app/` scheme instead of file:// so that the
 * Content-Security-Policy in the HTML can use 'self', ES modules load with the right MIME
 * type, and getDisplayMedia runs in a secure context.
 */
import { BrowserWindow, nativeTheme, net, protocol, screen } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_SCHEME = "clipsmith";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

// compiled layout: dist/main/main/windows.js, dist/main/preload/preload.cjs, dist/renderer/{renderer,shared}/
const here = import.meta.dirname;
const RENDERER_ROOT = normalize(join(here, "..", "..", "renderer"));
const PRELOAD = join(here, "..", "preload", "preload.cjs");

const SERVED = /\.(html|js|css)$/;

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

export function serveApp(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const file = normalize(join(RENDERER_ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(RENDERER_ROOT + sep) || !SERVED.test(file)) return new Response("Not found", { status: 404 });
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
} as const;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Clipsmith",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141917" : "#e8ebe6",
    webPreferences,
  });
  win.once("ready-to-show", () => win.show());
  void win.loadURL(`${APP_ORIGIN}/renderer/index.html`);
  return win;
}

/** The floating control bar: small, frameless, above everything, centred at the top of the primary display. */
export function createRecorderWindow(): BrowserWindow {
  const width = 400;
  const height = 56;
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 12,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "Clipsmith inspelning",
    backgroundColor: "#1b201e",
    // The window is hidden while recording when the user asked for it; a throttled hidden renderer
    // would starve MediaRecorder, so throttling is off.
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  try {
    win.setContentProtection(true); // best effort: not reliable for full-screen captures (see StartRequest.hideControls)
  } catch {
    /* unsupported platform */
  }
  win.once("ready-to-show", () => win.showInactive());
  void win.loadURL(`${APP_ORIGIN}/renderer/recorder.html`);
  return win;
}
