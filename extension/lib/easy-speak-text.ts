/** Collapse every run of whitespace (a non-breaking space included) to one space, and trim. */
export const norm = (s: string | null | undefined): string =>
	(s ?? "").replace(/[\s\u00a0]+/g, " ").trim();
