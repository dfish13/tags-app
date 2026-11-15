// Small input checks shared by the calendar and banner routes.

// A real calendar date in YYYY-MM-DD form. The regex alone would take
// 2026-02-31; round-tripping through Date catches that.
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// "HH:MM", 24-hour.
export function isClockTime(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

// Somewhere an href may safely point: an http(s) URL, or a path inside this
// app ("/..." or "#/..."). Anything else — javascript:, data:, a bare word —
// is refused, because the value is rendered into a link every visitor sees.
export function isSafeLink(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.startsWith("#/")) return true;
  if (v.startsWith("/") && !v.startsWith("//")) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// Optional free text: trims, turns "" into null, and caps the length.
// Returns undefined when the field was absent (so a PATCH can tell "leave it"
// from "clear it"), or an error string when it is too long or not a string.
export function optionalText(
  v: unknown,
  max: number,
  field: string
): { value: string | null | undefined } | { error: string } {
  if (v === undefined) return { value: undefined };
  if (v === null) return { value: null };
  if (typeof v !== "string") return { error: `${field} must be text` };
  const t = v.trim();
  if (t.length > max) return { error: `${field} must be ${max} characters or fewer` };
  return { value: t || null };
}

// Today's date on the server as YYYY-MM-DD, shifted by `days`.
export function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
