// The pure rules of TemplateField (#1536). Each test states its card.
import { describe, expect, it } from "vitest";
import { GUEST_INVITE_VARIABLES } from "#/lib/guest-invite-template";
import {
	caretRule,
	filterVariables,
	findTokens,
	flattenNewlines,
	isSuppressed,
	menuStateFromInput,
	snapCaret,
} from "./template-field-logic";

describe("menuStateFromInput", () => {
	// protects=an @ at a word boundary opens the menu; fails_when=it ignores the boundary;
	// no_claim=the DOM wiring.
	it("opens for @ at the start, after a space and after (", () => {
		expect(menuStateFromInput("@", 1)).toEqual({ triggerIndex: 0, filter: "" });
		expect(menuStateFromInput("hi @da", 6)).toEqual({
			triggerIndex: 3,
			filter: "da",
		});
		expect(menuStateFromInput("(@", 2)).toEqual({
			triggerIndex: 1,
			filter: "",
		});
	});

	// protects=an email address never opens the menu; fails_when=@ after [A-Za-z0-9_.] opens;
	// no_claim=other characters before @ (any non-word char opens).
	it("does not open for @ after a letter, digit, underscore or dot", () => {
		for (const t of ["a@", "7@", "_@", ".@", "me@x.co"]) {
			expect(menuStateFromInput(t, t.length)).toBeNull();
		}
	});

	// protects={ opens anywhere incl. mid-word and spans spaces; fails_when={ gets the @ rule;
	// no_claim=filtering.
	it("opens for { anywhere and keeps spaces in the filter", () => {
		expect(menuStateFromInput("a{", 2)).toEqual({
			triggerIndex: 1,
			filter: "",
		});
		expect(menuStateFromInput("{Word of", 8)).toEqual({
			triggerIndex: 0,
			filter: "Word of",
		});
	});

	// protects=a closed token or a new line ends the span; fails_when=a stale { far back reopens;
	// no_claim=an @ closing on space (separate test).
	it("is cut by } and by a newline", () => {
		expect(menuStateFromInput("{Date} x", 8)).toBeNull();
		expect(menuStateFromInput("{da\nte", 6)).toBeNull();
	});

	// protects=an @ filter may hold spaces (`@Word of` still lists Word of the Day) but an @ followed
	// at once by whitespace is prose; fails_when=`@Word of` closes at the space, or "Meet @ 7pm" /
	// "@ the" open the menu; no_claim=which variables match (filterVariables tests).
	it("keeps spaces inside an @ filter, but an @ followed by whitespace is prose", () => {
		expect(menuStateFromInput("@Word of", 8)).toEqual({
			triggerIndex: 0,
			filter: "Word of",
		});
		expect(filterVariables("Word of").map((v) => v.key)).toEqual([
			"wordOfTheDay",
		]);
		expect(menuStateFromInput("@ the", 5)).toBeNull();
		expect(menuStateFromInput("Meet @ 7pm", 10)).toBeNull();
		expect(menuStateFromInput("Meet @ ", 7)).toBeNull();
	});

	// protects=the filter is the text up to the CARET, not the end; fails_when=text after the caret leaks in;
	// no_claim=a caret inside an already closed token (the } cut-off test).
	it("takes the filter up to the caret only", () => {
		expect(menuStateFromInput("{dat more", 4)).toEqual({
			triggerIndex: 0,
			filter: "dat",
		});
	});
});

describe("filterVariables", () => {
	const keys = (f: string) => filterVariables(f).map((v) => v.key);

	// protects=empty filter lists everything; fails_when=an empty filter matches nothing.
	it("an empty filter matches every variable", () => {
		expect(keys("")).toHaveLength(14);
	});

	// protects=`wo` and `day` both find Word of the Day (key prefix and label-word prefix);
	// fails_when=only one of the two paths works.
	it("matches a key prefix and any label word's prefix", () => {
		expect(keys("wo")).toContain("wordOfTheDay");
		expect(keys("day")).toContain("wordOfTheDay");
		expect(keys("Word of")).toEqual(["wordOfTheDay"]);
	});

	// protects=a filter matching nothing returns [] (the menu closes); fails_when=it falls back to all.
	it("a filter matching nothing is empty", () => {
		expect(keys("zzz")).toEqual([]);
	});
});

describe("findTokens", () => {
	// protects=known vs unknown classification incl. a key, label and typo; fails_when=a typo is painted as a pill.
	it("marks keys and labels known and anything else unknown", () => {
		const t = findTokens("{Date} {date} {Datee} {word of the day}");
		expect(t.map((x) => x.known)).toEqual([true, true, false, true]);
	});
});

describe("caretRule", () => {
	const text = "a {Date} b";
	// Token spans [2,8).

	// protects=Backspace at a token's end removes it whole; fails_when=it deletes one character.
	it("Backspace at the end deletes the whole token", () => {
		expect(caretRule(text, 8, 8, "Backspace")).toEqual({
			text: "a  b",
			selStart: 2,
			selEnd: 2,
		});
	});

	// protects=Delete at the start removes it whole; fails_when=Delete removes one character or the token
	// before the caret; no_claim=Backspace (its own test) or a caret mid-token (snapCaret).
	it("Delete at the start deletes the whole token", () => {
		expect(caretRule(text, 2, 2, "Delete")).toEqual({
			text: "a  b",
			selStart: 2,
			selEnd: 2,
		});
	});

	// protects=arrow jumps over a pill; fails_when=the caret steps into it.
	it("ArrowLeft at the end jumps to the start, ArrowRight at the start to the end", () => {
		expect(caretRule(text, 8, 8, "ArrowLeft")).toEqual({
			text,
			selStart: 2,
			selEnd: 2,
		});
		expect(caretRule(text, 2, 2, "ArrowRight")).toEqual({
			text,
			selStart: 8,
			selEnd: 8,
		});
	});

	// protects=a typo stays editable character by character; fails_when=unknown tokens are atomic.
	it("leaves an unknown token alone", () => {
		expect(caretRule("{Datee}", 7, 7, "Backspace")).toBeNull();
		expect(caretRule("{Datee}", 7, 7, "ArrowLeft")).toBeNull();
	});

	// protects=selections and mid-token carets are the browser's; fails_when=a range selection deletes a token.
	it("does nothing for a range selection or away from an edge", () => {
		expect(caretRule(text, 8, 9, "Backspace")).toBeNull();
		expect(caretRule(text, 5, 5, "Backspace")).toBeNull();
		expect(caretRule(text, 8, 8, "a")).toBeNull();
	});
});

describe("snapCaret", () => {
	// protects=a caret inside a pill goes to the nearer edge; fails_when=it stays inside or always picks one side.
	it("snaps to the nearer edge, only strictly inside a known token", () => {
		const t = "a {Date} b";
		expect(snapCaret(t, 3)).toBe(2);
		expect(snapCaret(t, 7)).toBe(8);
		expect(snapCaret(t, 2)).toBeNull();
		expect(snapCaret(t, 8)).toBeNull();
		expect(snapCaret("{Datee}", 3)).toBeNull();
	});
});

describe("isSuppressed and flattenNewlines", () => {
	// Dismissed with the caret at 3 in "{da".
	const sup = { index: 0, char: "{", caret: 3 };

	// protects=Escape holds while typing more of the same span, lifts on a space or } typed AFTER the
	// dismissal, on caret <= trigger or a changed trigger char, and NOT on a space already in the span;
	// fails_when=any lift is missing, or `{Word of` + Escape lifts at once (the old whole-span test);
	// no_claim=the DOM reopening (template-field.test.tsx).
	it("holds inside the span and lifts on each documented exit", () => {
		expect(isSuppressed("{da", 3, sup)).toBe(true);
		expect(isSuppressed("{dat", 4, sup)).toBe(true);
		expect(isSuppressed("{da ", 4, sup)).toBe(false);
		expect(isSuppressed("{da}", 4, sup)).toBe(false);
		expect(isSuppressed("{da", 0, sup)).toBe(false);
		expect(isSuppressed("(da", 3, sup)).toBe(false);
		const spaced = { index: 0, char: "{", caret: 8 };
		expect(isSuppressed("{Word of", 8, spaced)).toBe(true);
		expect(isSuppressed("{Word ofthe", 11, spaced)).toBe(true);
		expect(isSuppressed("{Word of the", 12, spaced)).toBe(false);
	});

	// protects=a single-line paste has no line breaks; fails_when=a CRLF or LF survives, or CRLF turns into two
	// spaces; no_claim=where the paste lands in the field.
	it("turns newlines into spaces", () => {
		expect(flattenNewlines("a\r\nb\nc")).toBe("a b c");
	});
});

describe("filterVariables with a registry argument (#1547)", () => {
	// protects=the guest list drives the filter, including guest-only keys;
	// fails_when=the filter still reads PROMO_VARIABLES (a guest key is missing, or a Promote-only one appears);
	// no_claim=the menu rendering.
	it("filters the guest list when given it", () => {
		const keys = (f: string) =>
			filterVariables(f, GUEST_INVITE_VARIABLES).map((v) => v.key);
		expect(keys("")).toHaveLength(10);
		expect(keys("last")).toEqual(["lastVisit"]);
		expect(keys("guest")).toEqual(["guestName"]);
		expect(keys("theme")).toEqual([]);
	});

	// protects=Promote does not change; fails_when=the default stops being PROMO_VARIABLES;
	// no_claim=none beyond protects.
	it("defaults to Promote's list", () => {
		expect(filterVariables("")).toHaveLength(14);
		expect(filterVariables("last")).toEqual([]);
		expect(filterVariables("theme").map((v) => v.key)).toEqual(["theme"]);
	});
});
