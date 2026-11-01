/** Onboarding preferences. Option lists and limits come from the backend via contract.generated.ts. */
import { CONTRACT } from "./contract.generated.ts";
import type { CaptionStyle, Niche, Pace, SourceType } from "./contract.generated.ts";

export interface Preferences {
  niche: Niche;
  niche_notes: string;
  pace: Pace;
  caption_style: CaptionStyle;
  source_type: SourceType;
  language: string;
  target_minutes: number;
  num_shorts: number;
  remove_fillers: boolean | null;
}

export function defaultPreferences(): Preferences {
  const d: Preferences = CONTRACT.defaults;
  return { ...d, source_type: "screen" }; // the desktop app records screens
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** Human-readable problems (Swedish, shown in the form). Empty array = valid. */
export function validatePreferences(p: Preferences): string[] {
  const errors: string[] = [];
  const [minT, maxT] = CONTRACT.limits.target_minutes;
  const [minS, maxS] = CONTRACT.limits.num_shorts;
  if (!oneOf(CONTRACT.niches, p.niche)) errors.push("Välj en nisch.");
  if (!oneOf(CONTRACT.paces, p.pace)) errors.push("Välj ett klipptempo.");
  if (!oneOf(CONTRACT.caption_styles, p.caption_style)) errors.push("Välj en undertextstil.");
  if (!oneOf(CONTRACT.source_types, p.source_type)) errors.push("Ogiltig källtyp.");
  if (!(typeof p.target_minutes === "number" && p.target_minutes >= minT && p.target_minutes <= maxT)) {
    errors.push(`Målet för huvudvideon måste vara mellan ${minT} och ${maxT} minuter.`);
  }
  if (!(Number.isInteger(p.num_shorts) && p.num_shorts >= minS && p.num_shorts <= maxS)) {
    errors.push(`Antal shorts måste vara ett heltal mellan ${minS} och ${maxS}.`);
  }
  if (p.niche_notes.length > CONTRACT.limits.niche_notes_max_chars) {
    errors.push(`Anteckningarna får vara högst ${CONTRACT.limits.niche_notes_max_chars} tecken.`);
  }
  if (!p.language.trim()) errors.push("Välj språk.");
  return errors;
}

/** Tolerant loader for data read from disk: keep what is valid, fall back to defaults for the rest. */
export function normalizePreferences(raw: unknown): Preferences {
  const base = defaultPreferences();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const [minT, maxT] = CONTRACT.limits.target_minutes;
  const [minS, maxS] = CONTRACT.limits.num_shorts;
  return {
    niche: oneOf(CONTRACT.niches, r.niche) ? r.niche : base.niche,
    niche_notes: typeof r.niche_notes === "string" ? r.niche_notes.slice(0, CONTRACT.limits.niche_notes_max_chars) : base.niche_notes,
    pace: oneOf(CONTRACT.paces, r.pace) ? r.pace : base.pace,
    caption_style: oneOf(CONTRACT.caption_styles, r.caption_style) ? r.caption_style : base.caption_style,
    source_type: "screen",
    language: typeof r.language === "string" && r.language.trim() ? r.language : base.language,
    target_minutes: typeof r.target_minutes === "number" && r.target_minutes >= minT && r.target_minutes <= maxT ? r.target_minutes : base.target_minutes,
    num_shorts: Number.isInteger(r.num_shorts) && (r.num_shorts as number) >= minS && (r.num_shorts as number) <= maxS ? (r.num_shorts as number) : base.num_shorts,
    remove_fillers: typeof r.remove_fillers === "boolean" ? r.remove_fillers : null,
  };
}
