/**
 * Screen (+ audio) capture in the renderer: getDisplayMedia -> MediaRecorder -> chunks.
 *
 * Which screen or window is captured is decided in the main process (see the display-media
 * handler in main/index.ts); this module only asks for "a display stream" and records it.
 * It has no Electron dependency, so it is tested in a plain Chromium.
 */

/** Preference order. mp4 first if the browser can produce it; checked at runtime. */
export const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export function pickMimeType(isSupported: (type: string) => boolean, candidates: readonly string[] = MIME_CANDIDATES): string | null {
  return candidates.find((t) => isSupported(t)) ?? null;
}

export interface CaptureOptions {
  systemAudio: boolean;
  micDeviceId: string | null; // null = off, "" = default device
  onChunk(data: ArrayBuffer): void;
  onEnded(): void; // the captured window was closed or the user stopped sharing
  onError(message: string): void;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  frameRate?: number;
  timesliceMs?: number;
  candidates?: readonly string[];
}

export interface CaptureHandle {
  mimeType: string;
  warnings: string[];
  pause(): void;
  resume(): void;
  stop(): Promise<{ durationMs: number }>;
}

function describe(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t), opts.candidates);
  if (!mimeType) throw new Error("Webbläsarmotorn kan inte spela in video i något format som servern accepterar.");

  const warnings: string[] = [];
  const toStop: MediaStream[] = [];

  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: opts.frameRate ?? 30, max: 60 } },
    audio: opts.systemAudio,
  });
  toStop.push(display);
  const video = display.getVideoTracks()[0];
  if (!video) {
    toStop.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    throw new Error("Ingen bildström tillhandahölls.");
  }

  // Audio: system audio and/or microphone; both are mixed into one track.
  const audioSources: MediaStream[] = [];
  if (opts.systemAudio) {
    if (display.getAudioTracks().length) audioSources.push(new MediaStream(display.getAudioTracks()));
    else warnings.push("Systemljud är inte tillgängligt på den här datorn. Bara mikrofonen spelas in.");
  }
  if (opts.micDeviceId !== null) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      toStop.push(mic);
      audioSources.push(mic);
    } catch (e) {
      warnings.push(`Mikrofonen kunde inte startas (${describe(e)}).`);
    }
  }
  if (audioSources.length === 0) {
    toStop.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    throw new Error("Det finns inget ljud att spela in. Utan ljud finns inget tal att redigera.");
  }

  let audioContext: AudioContext | null = null;
  let audioTrack: MediaStreamTrack;
  if (audioSources.length === 1) {
    audioTrack = audioSources[0]!.getAudioTracks()[0]!;
  } else {
    audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.resume();
    const destination = audioContext.createMediaStreamDestination();
    for (const s of audioSources) audioContext.createMediaStreamSource(s).connect(destination);
    audioTrack = destination.stream.getAudioTracks()[0]!;
  }

  const recorder = new MediaRecorder(new MediaStream([video, audioTrack]), {
    mimeType,
    videoBitsPerSecond: opts.videoBitsPerSecond ?? 6_000_000,
    audioBitsPerSecond: opts.audioBitsPerSecond ?? 160_000,
  });

  // dataavailable events fire in order, but reading each Blob is async and could finish out of
  // order: chain the reads so chunks are always delivered in recording order.
  let queue: Promise<void> = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    queue = queue
      .then(async () => opts.onChunk(await e.data.arrayBuffer()))
      .catch((err) => opts.onError(`Kunde inte spara en bit av inspelningen: ${describe(err)}`));
  };
  recorder.onerror = (e) => opts.onError(describe((e as ErrorEvent & { error?: unknown }).error ?? "MediaRecorder-fel"));

  let ended = false;
  video.addEventListener("ended", () => {
    if (!ended) {
      ended = true;
      opts.onEnded();
    }
  });

  // Active time, excluding pauses.
  let activeMs = 0;
  let lastResume = performance.now();
  const bankActive = () => {
    activeMs += performance.now() - lastResume;
  };

  let stopped: Promise<{ durationMs: number }> | null = null;
  const cleanup = () => {
    toStop.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    audioTrack.stop();
    void audioContext?.close();
  };

  recorder.start(opts.timesliceMs ?? 1000);

  return {
    mimeType,
    warnings,
    pause() {
      if (recorder.state === "recording") {
        bankActive();
        recorder.pause();
      }
    },
    resume() {
      if (recorder.state === "paused") {
        lastResume = performance.now();
        recorder.resume();
      }
    },
    stop() {
      stopped ??= new Promise((resolve) => {
        const finish = async () => {
          await queue;
          cleanup();
          resolve({ durationMs: Math.round(activeMs) });
        };
        if (recorder.state === "inactive") return void finish();
        if (recorder.state === "recording") bankActive();
        recorder.onstop = () => void finish();
        recorder.stop();
      });
      return stopped;
    },
  };
}
