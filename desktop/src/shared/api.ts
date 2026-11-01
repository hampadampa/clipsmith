/** Client for the Clipsmith backend (POST /jobs, GET /jobs/{id}, files, health). No Electron or Node imports. */
import type { JobStatus } from "./contract.generated.ts";
import { buildMultipart } from "./multipart.ts";
import type { FilePart } from "./multipart.ts";
import type { Preferences } from "./preferences.ts";

export interface ShortInfo {
  file: string;
  title: string;
  score: number;
  reason: string;
  duration: number;
  source_start: number;
  source_end: number;
  unit_range: [number, number];
}

export interface Manifest {
  preferences: Record<string, unknown>;
  source: { duration: number; width: number; height: number };
  storyline: string | null;
  main: {
    file: string;
    subtitles: string;
    edl: string;
    duration: number;
    target: number;
    segments: number;
    dropped_units: number;
    cuts: Array<{ from_id: number; to_id: number; reason: string; confidence: number }>;
  };
  shorts: ShortInfo[];
}

export interface JobView {
  id: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  created_at: number;
  preferences: Record<string, unknown>;
  outputs: string[];
  result: Manifest | null;
}

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export class NetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NetworkError";
  }
}

export const isAbortError = (e: unknown): boolean => e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

/** "localhost:8000" -> "http://localhost:8000"; rejects anything that is not http(s). */
export function normalizeBaseUrl(input: string): string {
  const t = input.trim();
  if (!t) throw new Error("Ange serverns adress.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error("Adressen är inte giltig. Exempel: http://localhost:8000");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Adressen måste börja med http:// eller https://");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

async function toApiError(res: Response): Promise<ApiError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
    else if (Array.isArray(body.detail)) detail = body.detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join("; ");
  } catch {
    /* body was not JSON; keep the status text */
  }
  return new ApiError(res.status, detail);
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  uploadRetries?: number;
}

export interface WaitOptions {
  onUpdate?: (job: JobView) => void;
  signal?: AbortSignal;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
}

export class ClipsmithApi {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private retries: number;

  constructor(opts: ApiOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.retries = opts.uploadRetries ?? 2;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new NetworkError(`Kan inte nå servern på ${this.baseUrl}`, e);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  fileUrl(jobId: string, name: string): string {
    return `${this.baseUrl}/jobs/${jobId}/files/${encodeURIComponent(name)}`;
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; version: string }> {
    const timeout = AbortSignal.timeout(5000);
    const res = await this.request("/health", { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return (await res.json()) as { ok: boolean; version: string };
  }

  async getJob(id: string, signal?: AbortSignal): Promise<JobView> {
    const res = await this.request(`/jobs/${id}`, { signal });
    return (await res.json()) as JobView;
  }

  async getJson<T>(jobId: string, name: string, signal?: AbortSignal): Promise<T> {
    const res = await this.request(`/jobs/${jobId}/files/${encodeURIComponent(name)}`, { signal });
    return (await res.json()) as T;
  }

  async deleteJob(id: string): Promise<void> {
    await this.request(`/jobs/${id}`, { method: "DELETE" });
  }

  /** Streams the file; retries only on network failures (never on 4xx, never on a failing file read). */
  async createJob(
    file: FilePart,
    prefs: Preferences,
    opts: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<JobView> {
    const fields = { preferences: JSON.stringify(prefs) };
    for (let attempt = 0; ; attempt++) {
      const mp = buildMultipart(fields, file);
      let sent = 0;
      let bodyError: unknown;
      const body = mp.stream(
        (n) => {
          sent += n;
          opts.onProgress?.(sent, file.size);
        },
        (e) => {
          bodyError = e;
        },
      );
      try {
        const res = await this.request("/jobs", {
          method: "POST",
          body,
          headers: { "content-type": mp.contentType, "content-length": String(mp.contentLength) },
          duplex: "half",
          signal: opts.signal,
        } as RequestInit);
        return (await res.json()) as JobView;
      } catch (e) {
        if (bodyError) throw bodyError; // the local file failed, not the network
        if (isAbortError(e) || !(e instanceof NetworkError) || attempt >= this.retries) throw e;
        opts.onProgress?.(0, file.size);
        await this.sleep(1000 * 2 ** attempt, opts.signal);
      } finally {
        await mp.dispose().catch(() => {}); // always release the file, whatever happened
      }
    }
  }

  /** Polls until the job is done or failed. Survives short network blips. */
  async waitForJob(id: string, opts: WaitOptions = {}): Promise<JobView> {
    const interval = opts.intervalMs ?? 2000;
    const maxErrors = opts.maxConsecutiveErrors ?? 15;
    let errors = 0;
    for (;;) {
      try {
        const job = await this.getJob(id, opts.signal);
        errors = 0;
        opts.onUpdate?.(job);
        if (job.status === "done" || job.status === "failed") return job;
      } catch (e) {
        if (isAbortError(e) || (e instanceof ApiError && e.status < 500)) throw e; // 404 etc: the job is gone
        if (++errors > maxErrors) throw e;
      }
      await this.sleep(interval * Math.min(errors + 1, 5), opts.signal);
    }
  }
}
