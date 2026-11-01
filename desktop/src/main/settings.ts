import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_WHISPER_MODEL, isWhisperModel } from "../shared/engine.ts";
import type { EngineMode, WhisperModel } from "../shared/engine.ts";
import { normalizeBaseUrl } from "../shared/api.ts";
import type { Settings, SettingsPatch } from "../shared/ipc.ts";
import { normalizePreferences, validatePreferences } from "../shared/preferences.ts";
import type { ApiKeyStore } from "./secrets.ts";

export const DEFAULT_SERVER_URL = "http://localhost:8000";

/** What goes into settings.json. The API key is deliberately not part of it (see secrets.ts). */
interface Persisted {
  serverUrl: string;
  preferences: Settings["preferences"];
  engine: { mode: EngineMode; whisperModel: WhisperModel };
}

const DEFAULTS = (): Persisted => ({ serverUrl: DEFAULT_SERVER_URL, preferences: null, engine: { mode: "managed", whisperModel: DEFAULT_WHISPER_MODEL } });

export class SettingsStore {
  private path: string;
  private keys: ApiKeyStore | null;
  private value: Persisted = DEFAULTS();

  constructor(path: string, keys: ApiKeyStore | null = null) {
    this.path = path;
    this.keys = keys;
  }

  get current(): Settings {
    return {
      serverUrl: this.value.serverUrl,
      preferences: structuredClone(this.value.preferences),
      engine: {
        mode: this.value.engine.mode,
        whisperModel: this.value.engine.whisperModel,
        hasApiKey: this.keys?.key != null,
        keyStorage: this.keys?.storage ?? "none",
      },
    };
  }

  /** What the engine manager needs. The key stays inside the main process. */
  get engineConfig(): { whisperModel: WhisperModel; apiKey: string | null } {
    return { whisperModel: this.value.engine.whisperModel, apiKey: this.keys?.key ?? null };
  }

  /** Never throws: a missing or corrupt file just means defaults (and onboarding again). */
  async load(): Promise<Settings> {
    await this.keys?.load();
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      const next = DEFAULTS();
      try {
        if (typeof raw.serverUrl === "string") next.serverUrl = normalizeBaseUrl(raw.serverUrl);
      } catch {
        /* keep default */
      }
      next.preferences = raw.preferences ? normalizePreferences(raw.preferences) : null;
      const eng = (raw.engine ?? null) as { mode?: unknown; whisperModel?: unknown } | null;
      if (eng && (eng.mode === "managed" || eng.mode === "external")) next.engine.mode = eng.mode;
      // Settings written before the built-in engine existed: someone who had pointed the app at their own server keeps doing so.
      else if (next.serverUrl !== DEFAULT_SERVER_URL) next.engine.mode = "external";
      if (eng && isWhisperModel(eng.whisperModel)) next.engine.whisperModel = eng.whisperModel;
      this.value = next;
    } catch {
      this.value = DEFAULTS();
    }
    return this.current;
  }

  async save(patch: SettingsPatch): Promise<Settings> {
    const next: Persisted = structuredClone(this.value);
    if (patch.serverUrl !== undefined) next.serverUrl = normalizeBaseUrl(patch.serverUrl); // throws a Swedish message
    if (patch.preferences !== undefined) {
      if (patch.preferences !== null) {
        const errors = validatePreferences(patch.preferences);
        if (errors.length) throw new Error(errors.join(" "));
      }
      next.preferences = patch.preferences;
    }
    if (patch.engine?.mode !== undefined) {
      if (patch.engine.mode !== "managed" && patch.engine.mode !== "external") throw new Error("Okänt motorläge.");
      next.engine.mode = patch.engine.mode;
    }
    if (patch.engine?.whisperModel !== undefined) {
      if (!isWhisperModel(patch.engine.whisperModel)) throw new Error("Okänd taligenkänningsmodell.");
      next.engine.whisperModel = patch.engine.whisperModel;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, this.path);
    this.value = next;
    return this.current;
  }

  async setApiKey(key: string | null): Promise<Settings> {
    if (!this.keys) throw new Error("Det går inte att spara nyckeln på den här datorn.");
    await this.keys.set(key);
    return this.current;
  }
}
