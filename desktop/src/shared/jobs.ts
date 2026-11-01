/** User-facing (Swedish) wording for backend stages and failures. */
import { ApiError, NetworkError } from "./api.ts";

const STAGES: Record<string, string> = {
  analysing: "Analyserar inspelningen",
  transcribing: "Skriver ut vad du säger",
  planning_main: "Väljer vad som ska bort",
  rendering_main: "Klipper huvudvideon",
  planning_shorts: "Letar efter de bästa klippen till shorts",
  done: "Klart",
};

export function describeStage(stage: string | null, status: string): string {
  if (status === "queued") return "Väntar på sin tur hos servern";
  if (status === "uploading") return "Servern tar emot filen";
  if (!stage) return "Startar";
  const short = /^rendering_short_(\d+)$/.exec(stage);
  if (short) return `Renderar short ${short[1]}`;
  return STAGES[stage] ?? stage;
}

/** Backend ValueErrors are English; map the known ones to something actionable. */
export function describeJobError(message: string | null): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("no audio track")) return "Inspelningen saknar ljud, så det finns inget tal att redigera. Slå på mikrofon eller systemljud och spela in igen.";
  if (m.includes("no speech")) return "Inget tal hittades i inspelningen. Kontrollera att rätt mikrofon var på och att språket i profilen stämmer.";
  if (m.includes("removed everything")) return "Redigeringen skulle ha tagit bort allt. Prova ett lugnare klipptempo i profilen.";
  if (m.includes("interrupted because the engine stopped")) return "Bearbetningen avbröts när redigeringsmotorn stannade. Skicka inspelningen igen.";
  if (m.includes("processing failed")) return "Motorn kunde inte bearbeta inspelningen. Försök igen, eller titta i loggen under fliken Motor.";
  return message || "Bearbetningen misslyckades.";
}

export function describeFailure(e: unknown): string {
  if (e instanceof NetworkError) return `${e.message}. Kontrollera fliken Motor: den visar om redigeringsmotorn körs.`;
  if (e instanceof ApiError) {
    if (e.status === 413) return "Filen är större än serverns gräns för uppladdning.";
    if (e.status === 415) return "Servern accepterar inte filformatet.";
    if (e.status === 422) return `Servern godtog inte inställningarna: ${e.detail}`;
    return `Servern svarade med ett fel: ${e.detail}`;
  }
  return e instanceof Error ? e.message : "Något gick fel.";
}
