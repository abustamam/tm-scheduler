// The pure rules behind `TemplateField` (#1536): when the variable menu opens,
// which variables it lists, and how the caret treats a variable "pill".
// No DOM here, so every rule is a plain unit test.

import {
	isPromoPlaceholder,
	normalizePromoName,
	PROMO_VARIABLES,
	type PromoVariable,
	toStoredText,
} from "#/lib/promo-template";

/** One `{name}` in editor text. `known` means it resolves to a variable. */
export interface FieldToken {
	start: number;
	end: number;
	inner: string;
	known: boolean;
}

/** Every `{name}` token in `text`, known or not, in order. */
export function findTokens(text: string): FieldToken[] {
	const out: FieldToken[] = [];
	for (const m of text.matchAll(/\{([^{}\n]+)\}/g)) {
		const whole = m[0];
		const inner = m[1];
		const start = m.index ?? 0;
		const stored = toStoredText(whole);
		const known =
			isPromoPlaceholder(inner) ||
			(stored !== whole && isPromoPlaceholder(stored.slice(1, -1)));
		out.push({ start, end: start + whole.length, inner, known });
	}
	return out;
}

export interface MenuState {
	/** Index of the `@` or `{` that opened the menu. */
	triggerIndex: number;
	/** The text between the trigger and the caret. */
	filter: string;
}

const WORD_CHAR = /[A-Za-z0-9_.]/;

/**
 * The menu a caret position asks for, or null. Scans back from the caret for
 * the nearest `@` or `{` with no `}` or newline in between. `@` counts only at
 * a word boundary (so an email address never opens it) and closes at the first
 * whitespace; `{` counts anywhere and may span spaces (`{Word of`).
 */
export function menuStateFromInput(
	text: string,
	caret: number,
): MenuState | null {
	for (let i = caret - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === "}" || ch === "\n") return null;
		if (ch === "{")
			return { triggerIndex: i, filter: text.slice(i + 1, caret) };
		if (ch === "@") {
			if (i > 0 && WORD_CHAR.test(text[i - 1])) return null;
			const filter = text.slice(i + 1, caret);
			if (/\s/.test(filter)) return null;
			return { triggerIndex: i, filter };
		}
	}
	return null;
}

/** The variables a filter keeps, in table order. */
export function filterVariables(filter: string): PromoVariable[] {
	const norm = normalizePromoName(filter);
	const lower = filter.trim().toLowerCase();
	if (!norm && !lower) return [...PROMO_VARIABLES];
	return PROMO_VARIABLES.filter(
		(v) =>
			(norm && normalizePromoName(v.key).startsWith(norm)) ||
			(lower &&
				v.label
					.toLowerCase()
					.split(/\s+/)
					.some((w) => w.startsWith(lower))),
	);
}

/**
 * Whether an Escape-suppression still holds. It lifts when the caret moves to
 * or before the trigger, a space, newline or `}` is typed in the span, or the
 * character at the trigger is no longer the one that was suppressed.
 */
export function isSuppressed(
	text: string,
	caret: number,
	sup: { index: number; char: string },
): boolean {
	if (text[sup.index] !== sup.char) return false;
	if (caret <= sup.index) return false;
	return !/[\s}]/.test(text.slice(sup.index + 1, caret));
}

export interface CaretEdit {
	text: string;
	selStart: number;
	selEnd: number;
}

/**
 * Near-atomic pills. Applies to a collapsed selection and KNOWN tokens only:
 * Backspace at a token's end and Delete at its start remove it whole; ArrowLeft
 * at its end jumps to its start, ArrowRight at its start to its end. Anything
 * else is null (let the browser act). Callers hold back when a modifier is down.
 */
export function caretRule(
	text: string,
	selStart: number,
	selEnd: number,
	key: string,
): CaretEdit | null {
	if (selStart !== selEnd) return null;
	const tokens = findTokens(text).filter((t) => t.known);
	if (key === "Backspace") {
		const t = tokens.find((x) => x.end === selStart);
		if (t) return remove(text, t);
	} else if (key === "Delete") {
		const t = tokens.find((x) => x.start === selStart);
		if (t) return remove(text, t);
	} else if (key === "ArrowLeft") {
		const t = tokens.find((x) => x.end === selStart);
		if (t) return { text, selStart: t.start, selEnd: t.start };
	} else if (key === "ArrowRight") {
		const t = tokens.find((x) => x.start === selStart);
		if (t) return { text, selStart: t.end, selEnd: t.end };
	}
	return null;
}

function remove(text: string, t: FieldToken): CaretEdit {
	return {
		text: text.slice(0, t.start) + text.slice(t.end),
		selStart: t.start,
		selEnd: t.start,
	};
}

/** Where a collapsed caret strictly inside a known token should sit instead
 *  (the nearer edge), or null when it is not strictly inside one. */
export function snapCaret(text: string, pos: number): number | null {
	const t = findTokens(text).find(
		(x) => x.known && pos > x.start && pos < x.end,
	);
	if (!t) return null;
	return pos - t.start < t.end - pos ? t.start : t.end;
}

/** The text with a pasted/typed segment made fit for a single-line field. */
export function flattenNewlines(text: string): string {
	return text.replace(/\r?\n/g, " ");
}
