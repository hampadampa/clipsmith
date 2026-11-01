/**
 * Keeps the Anthropic API key on disk, encrypted with the operating system's keychain when there is one.
 *
 * The key never goes into settings.json (which the renderer can read a summary of) and never into the
 * AppState: the windows only learn whether a key exists. The codec is injected (Electron's `safeStorage`
 * in index.ts) so this file stays testable without Electron.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SecretCodec {
  /** False when the OS offers no secure storage (e.g. a Linux desktop without a keyring). */
  available(): boolean;
  encrypt(plain: string): string; // opaque text (base64)
  decrypt(blob: string): string; // throws if the blob cannot be decrypted by this user/machine
}

export type KeyStorage = "encrypted" | "plain" | "none";

interface KeyFile {
  v: 1;
  mode: "encrypted" | "plain";
  data: string;
}

/** Returns the cleaned key, or throws a Swedish message. An empty value is not valid here: use `set(null)` to remove. */
export function normalizeApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 20) throw new Error("Nyckeln är för kort. Kopiera hela nyckeln från console.anthropic.com.");
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error("Nyckeln får inte innehålla mellanslag, radbrytningar eller specialtecken. Kopiera den en gång till.");
  return key;
}

export class ApiKeyStore {
  private path: string;
  private codec: SecretCodec;
  private value: string | null = null;
  private mode: KeyStorage = "none";

  constructor(path: string, codec: SecretCodec) {
    this.path = path;
    this.codec = codec;
  }

  get key(): string | null {
    return this.value;
  }

  get storage(): KeyStorage {
    return this.value ? this.mode : "none";
  }

  /** Never throws: a missing, corrupt or undecryptable file just means "no key" (the person enters it again). */
  async load(): Promise<void> {
    this.value = null;
    this.mode = "none";
    try {
      const file = JSON.parse(await readFile(this.path, "utf8")) as Partial<KeyFile>;
      if (file.v !== 1 || typeof file.data !== "string") return;
      if (file.mode === "encrypted") {
        this.value = this.codec.decrypt(file.data);
        this.mode = "encrypted";
      } else if (file.mode === "plain") {
        this.value = file.data;
        this.mode = "plain";
      }
    } catch {
      this.value = null;
      this.mode = "none";
    }
  }

  async set(key: string | null): Promise<void> {
    if (key === null) {
      await rm(this.path, { force: true });
      this.value = null;
      this.mode = "none";
      return;
    }
    const clean = normalizeApiKey(key);
    const encrypted = this.codec.available();
    const file: KeyFile = { v: 1, mode: encrypted ? "encrypted" : "plain", data: encrypted ? this.codec.encrypt(clean) : clean };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {}); // no-op on Windows
    await rename(tmp, this.path);
    this.value = clean;
    this.mode = file.mode;
  }
}
