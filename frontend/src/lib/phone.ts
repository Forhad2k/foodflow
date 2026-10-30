/** Accepts "01712345678", "+8801712345678" or "8801712345678" and returns E.164 (what the API requires), or null if it is not a valid number. */
export function normalizePhone(input: string): string | null {
  const s = input.replace(/[\s()-]/g, '');
  if (/^01\d{9}$/.test(s)) return `+88${s}`;
  if (/^8801\d{9}$/.test(s)) return `+${s}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
