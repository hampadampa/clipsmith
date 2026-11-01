/**
 * Turns "something in the setup went wrong" into words a person can act on. Pure functions over the
 * output we captured, so they can be tested with real-looking pip / venv / ffmpeg messages.
 */
import type { EngineProblem } from "../shared/engine.ts";
import { PYTHON_DOWNLOAD_URL } from "../shared/engine.ts";
import type { FetchErrorKind } from "./python-fetch.ts";

export interface CheckEntry {
  id: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

const OFFLINE =
  /Failed to resolve|Name or service not known|Temporary failure in name resolution|getaddrinfo failed|Network is unreachable|ProxyError|SSLError|Connection (?:refused|reset|aborted)|ConnectTimeout|ReadTimeout|Max retries exceeded|timed out|nodename nor servname|urlopen error/i;
const DISK_FULL = /No space left on device|Errno 28|not enough space on the disk/i;
const NO_PERMISSION = /Permission denied|EACCES|Access is denied|PermissionError/i;
const NEEDS_BUILD = /Failed building wheel|error: Microsoft Visual C\+\+|unable to execute 'gcc'|command 'gcc' failed|command 'cc' failed|Could not build wheels|no such file or directory: 'cmake'/i;
const NO_DISTRIBUTION = /No matching distribution found|Could not find a version that satisfies|ResolutionImpossible|no matching distributions? available/i;
const NO_VENV = /ensurepip is not available|No module named ensurepip|python3-venv|The virtual environment was not created successfully/i;

const joined = (lines: string[]) => lines.join("\n");

export function pythonMissing(tooOld: string[]): EngineProblem {
  if (tooOld.length) {
    return {
      code: "python-too-old",
      title: "Din Python är för gammal",
      hint: `Clipsmith behöver Python 3.11 eller nyare, men hittade bara ${tooOld.join(", ")}. Installera Python 3.12 och starta om Clipsmith.`,
      pythonDownload: true,
    };
  }
  return {
    code: "python-missing",
    title: "Python saknas",
    hint: `Redigeringsmotorn körs med Python 3.11 eller nyare. Installera Python 3.12 från ${PYTHON_DOWNLOAD_URL.replace("https://", "")} (på Windows: kryssa i "Add python.exe to PATH") och starta om Clipsmith. Resten sköter appen själv.`,
    pythonDownload: true,
  };
}

/** The app tried to fetch a Python of its own and could not. The way out is always "install one yourself" (the button), plus a retry where a retry can help. */
export function pythonFetchFailure(kind: FetchErrorKind, detail: string): EngineProblem {
  const own = `Du kan också installera Python 3.12 själv från ${PYTHON_DOWNLOAD_URL.replace("https://", "")} (på Windows: kryssa i "Add python.exe to PATH") och starta om Clipsmith.`;
  switch (kind) {
    case "network":
      return { code: "python-download-failed", title: "Kunde inte hämta Python", hint: `Clipsmith hittade ingen Python på datorn och försökte hämta en egen, men fick ingen kontakt med github.com (${detail}). Kontrollera internetanslutningen, proxy och brandvägg och försök igen. ${own}`, pythonDownload: true };
    case "unsupported":
      return { code: "python-download-failed", title: "Python kan inte hämtas automatiskt till den här datorn", hint: `Det finns ingen färdig Python för just den här kombinationen av system och processor (${detail}). Installera Python 3.12 själv från ${PYTHON_DOWNLOAD_URL.replace("https://", "")} och starta om Clipsmith.`, pythonDownload: true };
    case "checksum":
      return { code: "python-download-failed", title: "Den hämtade Python-filen kunde inte verifieras", hint: `Filen hämtades men kontrollsumman stämde inte (${detail}), så den används inte. Försök igen. ${own}`, pythonDownload: true };
    case "disk":
      return { code: "python-download-failed", title: "Disken är full", hint: "Frigör några gigabyte och försök igen. Python, paketen och taligenkänningen tar flera gigabyte tillsammans." };
    default:
      return { code: "python-download-failed", title: "Den hämtade Python-kopian fungerar inte", hint: `Se loggen nedan (${detail}). Välj Försök igen. ${own}`, pythonDownload: true };
  }
}

export function venvFailure(output: string[]): EngineProblem {
  if (NO_VENV.test(joined(output))) {
    return {
      code: "venv-failed",
      title: "Python kan inte skapa en egen miljö",
      hint: 'På Ubuntu och Debian saknas ofta paketet python3-venv. Installera det (sudo apt install python3-venv) och välj "Försök igen".',
    };
  }
  if (DISK_FULL.test(joined(output))) return diskFull("venv-failed");
  return { code: "venv-failed", title: "Kunde inte skapa Pythons egen miljö", hint: "Se loggen nedan. Försök igen, eller välj Reparera installationen." };
}

function diskFull(code: "venv-failed" | "install-failed" | "model-failed"): EngineProblem {
  return { code, title: "Disken är full", hint: "Frigör några gigabyte och försök igen. Taligenkänningen och Pythons paket tar flera gigabyte." };
}

export function installFailure(output: string[]): EngineProblem {
  const text = joined(output);
  if (DISK_FULL.test(text)) return diskFull("install-failed");
  if (OFFLINE.test(text)) {
    return {
      code: "install-failed",
      title: "Kunde inte hämta Python-paketen",
      hint: "Det gick inte att nå paketservern (pypi.org). Kontrollera internetanslutningen, proxy och brandvägg och försök igen. Det behövs bara första gången.",
    };
  }
  if (NEEDS_BUILD.test(text) || NO_DISTRIBUTION.test(text)) {
    return {
      code: "install-failed",
      title: "Det finns inget färdigt paket för din Python-version",
      hint: "Något av paketen har ingen färdigbyggd version för just din Python eller dator, oftast för att Python är för ny. Installera Python 3.12 från python.org och välj Försök igen, så använder Clipsmith den.",
      pythonDownload: true,
    };
  }
  if (NO_PERMISSION.test(text)) {
    return { code: "install-failed", title: "Saknar behörighet att installera", hint: "Appen får inte skriva i sin egen datamapp. Kontrollera rättigheterna och försök igen." };
  }
  return { code: "install-failed", title: "Installationen av Python-paketen misslyckades", hint: "Se loggen nedan. Försök igen, eller välj Reparera installationen." };
}

const CHECK_TEXT: Record<string, { title: string; hint: string }> = {
  python: { title: "Pythons version är för gammal", hint: "Installera Python 3.11 eller nyare." },
  ffmpeg: { title: "ffmpeg hittades inte", hint: "Appen levererar normalt sin egen ffmpeg. Installera ffmpeg på datorn och starta om om den inte följde med." },
  ffprobe: { title: "ffprobe hittades inte", hint: "Hör ihop med ffmpeg. Installera ffmpeg (som innehåller ffprobe) på datorn." },
  libass: { title: "Din ffmpeg saknar stöd för undertexter", hint: "Undertexterna i shorts ritas med ffmpegs libass. Installera en ffmpeg-version som har det (de flesta färdiga byggen har det)." },
  libx264: { title: "Din ffmpeg saknar H.264-kodaren", hint: "Videorna skrivs med libx264. Installera en ffmpeg-version som har den." },
  fastapi: { title: "Python-paketet fastapi saknas", hint: "Välj Reparera installationen." },
  uvicorn: { title: "Python-paketet uvicorn saknas", hint: "Välj Reparera installationen." },
  multipart: { title: "Python-paketet python-multipart saknas", hint: "Välj Reparera installationen." },
  faster_whisper: { title: "Taligenkänningen (faster-whisper) saknas", hint: "Välj Reparera installationen." },
};

export function checkFailure(failed: CheckEntry[]): EngineProblem {
  const first = failed[0];
  const known = first ? CHECK_TEXT[first.id] : undefined;
  const more = failed.length > 1 ? ` (och ${failed.length - 1} till)` : "";
  return {
    code: "check-failed",
    title: `${known?.title ?? "Datorn klarar inte motorns krav"}${more}`,
    hint: known?.hint ?? "Se loggen nedan.",
  };
}

export function modelFailure(model: string, output: string[]): EngineProblem {
  const text = joined(output);
  if (DISK_FULL.test(text)) return diskFull("model-failed");
  if (OFFLINE.test(text)) {
    return { code: "model-failed", title: "Kunde inte hämta taligenkänningsmodellen", hint: `Modellen "${model}" hämtas från huggingface.co. Kontrollera internetanslutningen och försök igen. Det behövs bara en gång per modell.` };
  }
  return { code: "model-failed", title: "Modellen kunde inte hämtas", hint: "Se loggen nedan. Försök igen, eller välj en mindre modell under Motor." };
}

export function startFailure(exitCode: number | null, output: string[]): EngineProblem {
  const text = joined(output);
  if (exitCode === 3 || /Missing Python package/.test(text)) {
    return { code: "start-failed", title: "Ett Python-paket saknas", hint: "Välj Reparera installationen så installeras paketen om." };
  }
  if (/address already in use|Errno 98|Errno 48|WinError 10048/i.test(text)) {
    return { code: "start-failed", title: "Porten var upptagen", hint: "Försök igen. Appen väljer en ny port." };
  }
  return { code: "start-failed", title: "Motorn startade inte", hint: "Se loggen nedan. Försök igen, eller välj Reparera installationen." };
}

export function crashLoop(): EngineProblem {
  return { code: "crash-loop", title: "Motorn fortsätter stanna", hint: "Appen har startat om den flera gånger utan att det hjälpt. Se loggen nedan. Välj Försök igen eller Reparera installationen." };
}
