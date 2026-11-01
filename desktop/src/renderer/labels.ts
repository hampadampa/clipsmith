/** Swedish wording for the backend's option lists. Keys come from the generated contract. */
import type { CaptionStyle, Niche, Pace } from "../shared/contract.generated.ts";

export const NICHE_LABELS: Record<Niche, { title: string; desc: string }> = {
  garage: { title: "Mekanik och garage", desc: "Felsökning, reparationer och verkstadsarbete." },
  tech: { title: "Teknik", desc: "Recensioner, förklaringar och jämförelser." },
  vlog: { title: "Vlogg", desc: "Personlighet, berättande och spontana ögonblick." },
  tutorial: { title: "Tutorial och kodning", desc: "Steg för steg: skärminspelning, scheman och kod." },
  presentation: { title: "Presentation", desc: "Föredrag och genomgångar med tydlig röd tråd." },
  other: { title: "Annat", desc: "Allmän redigering av tal." },
};

export const PACE_LABELS: Record<Pace, { title: string; desc: string }> = {
  calm: { title: "Lugnt", desc: "Klipper försiktigt och låter förklaringar landa. Bara tydlig tomgång och omtagningar försvinner." },
  balanced: { title: "Balanserat", desc: "Tar bort tomgång och upprepningar men behåller en naturlig rytm." },
  fast: { title: "Snabbt", desc: "Tätt och energiskt. Det som inte driver framåt klipps bort." },
};

export const CAPTION_LABELS: Record<CaptionStyle, { title: string; desc: string }> = {
  pop: { title: "Pop", desc: "Ett ord i taget, det som sägs just nu är markerat." },
  karaoke: { title: "Karaoke", desc: "Orden fylls i medan du pratar." },
  minimal: { title: "Minimal", desc: "Diskret text längst ned." },
  none: { title: "Ingen text", desc: "Shorts utan undertexter." },
};

export const LANGUAGE_LABELS: Record<string, string> = { sv: "Svenska", en: "Engelska", no: "Norska", da: "Danska", fi: "Finska", de: "Tyska" };

export const CUT_REASON_LABELS: Record<string, [string, string]> = {
  retake: ["omtagning", "omtagningar"],
  false_start: ["felstart", "felstarter"],
  dead_air: ["tomgång", "tomgångar"],
  repetition: ["upprepning", "upprepningar"],
  off_topic: ["sidospår", "sidospår"],
  meta_talk: ["prat om inspelningen", "pratstunder om inspelningen"],
  low_value: ["mindre viktig del", "mindre viktiga delar"],
};

export const SESSION_STATE_LABELS: Record<string, string> = {
  stopped: "Inte uppladdad",
  recovered: "Återställd efter avbrott",
  uploaded: "Uppladdad",
  recording: "Spelas in",
  starting: "Startar",
};
