/** A tiny hyperscript helper: enough for this UI, no framework. */
export type Child = Node | string | number | null | undefined | false | Child[];
export type Props = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  let value: string | undefined;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (k === "value") value = String(v); // set after the children exist (matters for <select>)
    else if (k === "checked" || k === "disabled" || k === "selected") (el as unknown as Record<string, unknown>)[k] = true;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  const append = (c: Child): void => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(append);
    el.append(c instanceof Node ? c : String(c));
  };
  children.forEach(append);
  if (value !== undefined) (el as unknown as { value: string }).value = value;
  return el;
}

/** "Error invoking remote method 'x': Error: message" -> "message" */
export function cleanError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function accelerator(accel: string): string {
  const mac = /Mac/i.test(navigator.userAgent);
  const map: Record<string, string> = mac
    ? { CommandOrControl: "⌘", Shift: "⇧", Alt: "⌥" }
    : { CommandOrControl: "Ctrl", Shift: "Skift", Alt: "Alt" };
  const parts = accel.split("+").map((p) => map[p] ?? p);
  return mac ? parts.join("") : parts.join("+");
}
