// @vitest-environment jsdom
//
// TemplateField (#1536): the menu, pills, typo help and counters. jsdom has no
// layout and no native undo stack, so backdrop alignment and undo are QA checks.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUEST_INVITE_VARIABLES } from "#/lib/guest-invite-template";
import {
	PROMO_VARIABLE_GROUPS,
	PROMO_VARIABLES,
	type PromoValues,
	toStoredText,
} from "#/lib/promo-template";
import {
	BRACE_CLASS,
	FIELD_BUTTON_CLASS,
	PILL_CLASS,
	TemplateField,
	UNKNOWN_CLASS,
} from "./template-field";
import { OPTION_ROW_HEIGHT } from "./variable-menu";

afterEach(cleanup);

const VALUES = Object.fromEntries(
	PROMO_VARIABLES.map((v) => [v.key, v.key === "theme" ? "" : `v-${v.key}`]),
) as PromoValues;

function Harness(
	props: Partial<React.ComponentProps<typeof TemplateField>> & {
		initial?: string;
		spy?: (v: string) => void;
	},
) {
	const [value, setValue] = useState(props.initial ?? "");
	return (
		<TemplateField
			id="f"
			label="Headline"
			limit={160}
			defaultValue="Default {Date}"
			values={null}
			{...props}
			value={value}
			onChange={(v) => {
				setValue(v);
				props.spy?.(v);
			}}
		/>
	);
}

function setup(props: React.ComponentProps<typeof Harness> = {}) {
	render(<Harness {...props} />);
	return {
		user: userEvent.setup(),
		ta: screen.getByLabelText("Headline") as HTMLTextAreaElement,
	};
}

const listbox = () => screen.queryByRole("listbox");

describe("opening the menu", () => {
	// protects=@ at a boundary lists every variable, in as many groups as the library has;
	// fails_when=a variable or group is missing from the list;
	// no_claim=popover placement or real layout.
	it("@ at the start lists every variable in its groups", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		const lb = screen.getByRole("listbox");
		expect(within(lb).getAllByRole("option")).toHaveLength(
			PROMO_VARIABLES.length,
		);
		expect(within(lb).getAllByRole("group")).toHaveLength(
			PROMO_VARIABLE_GROUPS.length,
		);
	});

	// protects=an email's @ stays literal; fails_when=@ after a letter, digit, _ or . opens the menu;
	// no_claim=other characters before @ (the logic test says any non-word char opens).
	it("@ directly after a letter, digit, _ or . does not open it", async () => {
		const { user, ta } = setup();
		for (const c of ["a", "7", "_", "."]) {
			await user.clear(ta);
			await user.type(ta, `${c}@`);
			expect(listbox()).toBeNull();
		}
	});

	// protects={ opens anywhere and filters by key prefix and label word, and a miss closes it;
	// fails_when=either match path breaks or a no-match filter keeps the menu open;
	// no_claim=the full filter grammar (unit tests).
	it("{wo and {day find Word of the Day; a miss closes the menu", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{wo");
		expect(screen.getAllByRole("option")).toHaveLength(1);
		await user.clear(ta);
		await user.type(ta, "{{day");
		expect(
			screen.getByRole("option", { name: /Word of the Day/ }),
		).toBeTruthy();
		await user.type(ta, "zzz");
		expect(listbox()).toBeNull();
	});

	// protects=Escape closes and the same span stays closed while typing continues;
	// fails_when=the next character reopens the menu;
	// no_claim=that a new trigger later reopens (unit-tested via isSuppressed).
	it("Escape closes and typing more in the same span does not reopen", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{da");
		expect(listbox()).not.toBeNull();
		await user.keyboard("{Escape}");
		expect(listbox()).toBeNull();
		await user.keyboard("t");
		expect(listbox()).toBeNull();
	});

	// protects=Escape closes `{Word of` (a span that already holds a space) and typing `the` keeps it
	// closed; fails_when=the space in the span lifts the suppression at once and the menu stays open;
	// no_claim=that a space typed after the dismissal lifts it (the isSuppressed unit test).
	it("Escape closes a span that already holds a space, and typing keeps it closed", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{Word of");
		expect(listbox()).not.toBeNull();
		await user.keyboard("{Escape}");
		expect(listbox()).toBeNull();
		await user.keyboard("the");
		expect(listbox()).toBeNull();
	});

	// protects=Escape on a menu opened with Insert variable closes it even when an @ trigger sits
	// underneath; fails_when=the @ keeps the menu open after Escape;
	// no_claim=Insert variable's pick position (the picking tests).
	it("Escape after @ then Insert variable closes the menu", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		await user.click(screen.getByRole("button", { name: "Add a detail" }));
		expect(listbox()).not.toBeNull();
		await user.keyboard("{Escape}");
		expect(listbox()).toBeNull();
		expect(document.activeElement).toBe(ta);
	});

	// protects=an @ filter keeps spaces so `@Word of` still lists Word of the Day, while "@ the" is prose;
	// fails_when=the menu closes at the space inside the filter, or opens for an @ followed by a space;
	// no_claim=the boundary rule (the other opening tests).
	it("@Word of keeps the menu open on one option; '@ the' does not open it", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@Word of");
		expect(screen.getAllByRole("option")).toHaveLength(1);
		await user.clear(ta);
		await user.type(ta, "@ the");
		expect(listbox()).toBeNull();
	});
});

describe("picking", () => {
	// protects=ArrowDown+Enter inserts the second option (Time: the first is active on open) at the trigger,
	// caret after, and the draft the parent stores reads {time};
	// fails_when=the trigger text stays, the caret is misplaced or the stored form is the label;
	// no_claim=native undo of the edit (jsdom has no undo stack).
	it("ArrowDown then Enter replaces the trigger and filter with the pill", async () => {
		const spy = vi.fn();
		const { user, ta } = setup({ spy });
		await user.type(ta, "Hi @");
		await user.keyboard("{ArrowDown}{Enter}");
		expect(ta.value).toBe("Hi {Time}");
		expect(ta.selectionStart).toBe(ta.value.length);
		expect(listbox()).toBeNull();
		expect(toStoredText(spy.mock.calls.at(-1)?.[0] as string)).toBe(
			"Hi {time}",
		);
	});

	// protects=Tab picks like Enter; fails_when=Tab moves focus instead of inserting;
	// no_claim=Shift+Tab.
	it("Tab inserts the first match", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{da");
		await user.keyboard("{Tab}");
		expect(ta.value).toBe("{Date}");
		expect(document.activeElement).toBe(ta);
	});

	// protects=ArrowUp wraps to the last option; fails_when=it stops at the top;
	// no_claim=ArrowDown wrapping past the last option.
	it("ArrowUp from the first option wraps to the last", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		await user.keyboard("{ArrowUp}");
		const last = PROMO_VARIABLES[PROMO_VARIABLES.length - 1];
		expect(
			ta.getAttribute("aria-activedescendant")?.endsWith(`-${last.key}`),
		).toBe(true);
	});

	// protects=a mouse pick inserts and keeps focus in the textarea; fails_when=focus moves to the row;
	// no_claim=a real pointer (user-event dispatches the events, not hit-testing).
	it("clicking an option inserts it with focus still in the textarea", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		await user.click(screen.getByRole("option", { name: /Club name/ }));
		expect(ta.value).toBe("{Club name}");
		expect(document.activeElement).toBe(ta);
	});

	// protects=Insert variable opens the same listbox, focus in the textarea, pick at the last caret;
	// fails_when=it inserts at the end or steals focus;
	// no_claim=the phone keyboard staying up.
	it("Insert variable inserts at the last caret position", async () => {
		const { user, ta } = setup({ initial: "ab cd" });
		await user.click(ta);
		ta.setSelectionRange(2, 2);
		await user.keyboard("{ArrowRight}{ArrowLeft}");
		await user.click(screen.getByRole("button", { name: "Add a detail" }));
		expect(listbox()).not.toBeNull();
		expect(document.activeElement).toBe(ta);
		await user.click(screen.getByRole("option", { name: /^Date/ }));
		expect(ta.value).toBe("ab{Date} cd");
	});

	// protects=a never-focused field gets the variable at its end; fails_when=it is lost or put at the start;
	// no_claim=a replaced selection (the last-caret test covers a collapsed caret only).
	it("Insert variable on a never-focused field appends", async () => {
		const { user, ta } = setup({ initial: "Hello " });
		await user.click(screen.getByRole("button", { name: "Add a detail" }));
		await user.click(screen.getByRole("option", { name: /^Date/ }));
		expect(ta.value).toBe("Hello {Date}");
	});
});

describe("accessibility", () => {
	// protects=the combobox attributes exist only while open, and no explicit role;
	// fails_when=they linger when closed or the textarea gets role=combobox;
	// no_claim=how a screen reader voices them.
	it("sets aria-autocomplete, -controls and -activedescendant only while open", async () => {
		const { user, ta } = setup();
		const attrs = () =>
			["aria-autocomplete", "aria-controls", "aria-activedescendant"].map((a) =>
				ta.getAttribute(a),
			);
		expect(attrs()).toEqual([null, null, null]);
		await user.type(ta, "@");
		const lb = screen.getByRole("listbox");
		expect(ta.getAttribute("aria-autocomplete")).toBe("list");
		expect(ta.getAttribute("aria-controls")).toBe(lb.id);
		const active = document.getElementById(
			ta.getAttribute("aria-activedescendant") ?? "",
		);
		expect(active?.getAttribute("aria-selected")).toBe("true");
		expect(ta.hasAttribute("role")).toBe(false);
		await user.keyboard("{Escape}");
		expect(attrs()).toEqual([null, null, null]);
	});

	// protects=a polite announcement on open and on pick; fails_when=the live region stays empty;
	// no_claim=that a screen reader speaks it.
	it("announces the count on open and the pick after", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		expect(document.querySelector("[aria-live=polite]")?.textContent).toBe(
			`${PROMO_VARIABLES.length} details, use up and down then Enter`,
		);
		await user.keyboard("{Enter}");
		expect(document.querySelector("[aria-live=polite]")?.textContent).toBe(
			"Added Date",
		);
	});

	// protects=rows are 44px below md, read from the component's own constant;
	// fails_when=the height class is dropped; no_claim=real rendered height (QA pass).
	it("option rows carry the 44px class", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		for (const o of screen.getAllByRole("option")) {
			for (const c of OPTION_ROW_HEIGHT.split(" "))
				expect(o.classList.contains(c)).toBe(true);
		}
		expect(OPTION_ROW_HEIGHT.split(" ")[0]).toBe("h-11");
	});

	// protects=the value column: value, "not set", and nothing while unknown;
	// fails_when=an empty value shows blank or null values print "not set";
	// no_claim=truncation of a long value.
	it("shows values, 'not set', or nothing", async () => {
		const first = setup({ values: VALUES });
		await first.user.type(first.ta, "@");
		expect(screen.getByRole("option", { name: /Date/ }).textContent).toContain(
			"v-date",
		);
		expect(screen.getByRole("option", { name: /Theme/ }).textContent).toContain(
			"not set",
		);
		cleanup();
		const second = setup({ values: null });
		await second.user.type(second.ta, "@");
		expect(
			screen.getByRole("option", { name: /Date/ }).textContent,
		).not.toContain("not set");
	});
});

describe("controls and announcements", () => {
	// protects=the Insert variable button carries the 44px-below-md class, read from the component's
	// constant; fails_when=the class is dropped from the button; no_claim=real rendered height (QA pass).
	it("Insert variable carries FIELD_BUTTON_CLASS", () => {
		setup();
		const button = screen.getByRole("button", { name: "Add a detail" });
		for (const c of FIELD_BUTTON_CLASS.split(" "))
			expect(button.classList.contains(c)).toBe(true);
		expect(FIELD_BUTTON_CLASS.split(" ")[0]).toBe("h-11");
	});

	// protects=a reopened menu is announced again: the opening text is cleared on close;
	// fails_when=open, Escape, reopen leaves the same live-region text and so says nothing;
	// no_claim=that a screen reader speaks it, or that an "Inserted X" survives (the announce test).
	it("empties the opening announcement while the menu is closed", async () => {
		const { user, ta } = setup();
		const live = () =>
			document.querySelector("[aria-live=polite]")?.textContent;
		await user.type(ta, "@");
		expect(live()).toBe(
			`${PROMO_VARIABLES.length} details, use up and down then Enter`,
		);
		await user.keyboard("{Escape}");
		expect(live()).toBe("");
		await user.clear(ta);
		await user.type(ta, "@");
		expect(live()).toBe(
			`${PROMO_VARIABLES.length} details, use up and down then Enter`,
		);
	});

	// protects=the backdrop's width compensation runs on mount, on a value change and on resize without
	// throwing, and leaves 0px where nothing measures a scrollbar; fails_when=the effect throws or leaves
	// a non-numeric right; no_claim=any real scrollbar width: jsdom measures nothing (QA pass).
	it("the scrollbar compensation effect runs and settles at 0px in jsdom", async () => {
		const { user, ta } = setup({ multiline: true, rows: 2 });
		const backdrop = () =>
			document.querySelector<HTMLElement>(
				"[data-slot=template-field-backdrop]",
			);
		expect(backdrop()?.style.right).toBe("0px");
		await user.type(ta, "some text");
		window.dispatchEvent(new Event("resize"));
		expect(backdrop()?.style.right).toBe("0px");
	});
});

describe("pills and Enter", () => {
	// protects=Backspace and ArrowLeft rules reach the DOM, and a typo is plain text;
	// fails_when=the key deletes one char, or an unknown token is atomic;
	// no_claim=Delete/ArrowRight in the DOM (logic tests) or a click snapping the caret.
	it("Backspace after a pill removes it whole; ArrowLeft jumps; a typo is plain text", async () => {
		const { user, ta } = setup({ initial: "x{Date}" });
		await user.click(ta);
		ta.setSelectionRange(7, 7);
		await user.keyboard("{ArrowLeft}");
		expect(ta.selectionStart).toBe(1);
		ta.setSelectionRange(7, 7);
		await user.keyboard("{Backspace}");
		expect(ta.value).toBe("x");
		cleanup();
		const typo = setup({ initial: "{Datee}" });
		typo.ta.focus();
		typo.ta.setSelectionRange(7, 7);
		await typo.user.keyboard("{Backspace}");
		expect(typo.ta.value).toBe("{Datee");
	});

	// protects=single-line fields swallow Enter, multi-line accept it; fails_when=either flips;
	// no_claim=Enter while the menu is open (it picks, see the picking tests).
	it("Enter is swallowed when single-line and kept when multi-line", async () => {
		const single = setup({ multiline: false, initial: "ab" });
		await single.user.type(single.ta, "{Enter}c");
		expect(single.ta.value).toBe("abc");
		cleanup();
		const multi = setup({ initial: "ab" });
		await multi.user.type(multi.ta, "{Enter}c");
		expect(multi.ta.value).toBe("ab\nc");
	});
});

describe("counter, typos and defaults", () => {
	// protects=the counter counts the STORED length ({Word of the Day} = 14 not 17) and is silent under 80%;
	// fails_when=it counts the friendly text or shows while comfortably under the limit;
	// no_claim=the over-limit styling.
	it("counts the stored form and is silent under 80%", () => {
		setup({ initial: "{Word of the Day}", limit: 17 });
		// stored 14 of 17 = 82%: shows, counting 3 left (not 0 left for the 17 friendly chars)
		expect(screen.getByText("3 characters left")).toBeTruthy();
		cleanup();
		setup({ initial: "{Word of the Day}", limit: 160 });
		expect(screen.queryByText(/characters/)).toBeNull();
	});

	// protects=the counter appears from 80% and says "too long" over the limit;
	// fails_when=either message is missing or wrong; no_claim=the colour.
	it("counts characters left from 80% and too long over the limit", () => {
		setup({ initial: "x".repeat(128), limit: 160 });
		expect(screen.getByText("32 characters left")).toBeTruthy();
		cleanup();
		setup({ initial: "x".repeat(127), limit: 160 });
		expect(screen.queryByText(/characters/)).toBeNull();
		cleanup();
		setup({ initial: "x".repeat(165), limit: 160 });
		expect(screen.getByText("5 characters too long")).toBeTruthy();
	});

	// protects=bullets are silent while fine, then name the line count or the long line;
	// fails_when=blank lines are counted or a message is missing; no_claim=colour.
	it("bullets: silent when fine, too many lines, an over-long line", () => {
		const base = { label: "Headline", limit: undefined } as const;
		setup({ ...base, bullets: { perLine: 10, max: 2 }, initial: "one\n\ntwo" });
		expect(screen.queryByText(/Keep it to|too long/)).toBeNull();
		cleanup();
		setup({ ...base, bullets: { perLine: 10, max: 2 }, initial: "a\nb\nc" });
		expect(screen.getByText("Keep it to 2 reasons (you have 3)")).toBeTruthy();
		cleanup();
		setup({
			...base,
			bullets: { perLine: 10, max: 5 },
			initial: "ok\n\nfine\nabcdefghijkl",
		});
		expect(screen.getByText("Line 3 is 2 characters too long")).toBeTruthy();
	});

	// protects=a known variable paints as a pill with invisible braces and a visible label; an unknown token keeps visible braces;
	// fails_when=the pill loses PILL_CLASS, a brace is visible, or the typo has no flag; no_claim=painted pixels.
	it("paints a known variable as a pill and an unknown one with braces", () => {
		setup({ initial: "a {Date} b {foo}" });
		const pill = document.querySelector("[data-slot=template-pill]");
		expect(pill?.className).toBe(PILL_CLASS);
		const braces = pill?.querySelectorAll(`.${BRACE_CLASS}`);
		expect(braces?.length).toBe(2);
		expect(braces?.[0].textContent).toBe("{");
		expect(braces?.[1].textContent).toBe("}");
		expect(pill?.textContent).toBe("{Date}");
		const label = [...(pill?.childNodes ?? [])].find(
			(n) => n.nodeType === Node.TEXT_NODE,
		);
		expect(label?.textContent).toBe("Date");
		const unknown = document.querySelector(`.${UNKNOWN_CLASS.split(" ")[0]}`);
		expect(unknown?.textContent).toBe("{foo}");
		expect(unknown?.querySelector(`.${BRACE_CLASS}`)).toBeNull();
	});

	// protects=typo line, wavy underline and Fix; fails_when=Fix leaves the typo or the line stays;
	// no_claim=painted pixel alignment.
	it("flags {Word of Day}, paints it unknown, and Fix rewrites every occurrence", async () => {
		const { user, ta } = setup({ initial: "a {Word of Day} b {Word of Day}" });
		expect(
			screen.getByText(
				"GavelUp doesn't recognize {Word of Day}. Did you mean Word of the Day?",
			),
		).toBeTruthy();
		const unknown = document.querySelector(
			`[data-slot=template-field-backdrop] span`,
		);
		expect(unknown?.className).toBe(UNKNOWN_CLASS);
		await user.click(screen.getByRole("button", { name: "Fix" }));
		expect(ta.value).toBe("a {Word of the Day} b {Word of the Day}");
		expect(screen.queryByText(/recognize/)).toBeNull();
	});

	// protects=no-suggestion typos say "exactly as typed" with no Fix; fails_when=a Fix is offered;
	// no_claim=the suggestion thresholds (#1535's suggestPlaceholder).
	it("{foo} has no Fix", () => {
		setup({ initial: "{foo}" });
		expect(
			screen.getByText(
				"GavelUp doesn't recognize {foo}, so it will show exactly as typed.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
	});

	// protects=Use default only when changed, restores the default;
	// fails_when=it shows on an unchanged field or does not restore;
	// no_claim=the absence of a server call (this component has none to call).
	it("Use default appears after an edit and restores the default", async () => {
		const { user, ta } = setup({ initial: "Default {Date}" });
		expect(
			screen.queryByRole("button", { name: "Restore original" }),
		).toBeNull();
		await user.type(ta, "!");
		await user.click(screen.getByRole("button", { name: "Restore original" }));
		expect(ta.value).toBe("Default {Date}");
		expect(
			screen.queryByRole("button", { name: "Restore original" }),
		).toBeNull();
	});
});

describe("a stored {DATE}", () => {
	// protects=a stored {DATE} loads left as typed, painted as unknown, with a suggestion and a Fix;
	// fails_when=it is silently read as the Date variable (painted as a pill, no help);
	// no_claim=the editor's Discard state (promo-template-editor.test.tsx).
	it("is left as typed, underlined, with Did you mean Date? and Fix", () => {
		const { ta } = setup({ initial: "Join {DATE}" });
		expect(ta.value).toBe("Join {DATE}");
		const span = document.querySelector(
			"[data-slot=template-field-backdrop] span",
		);
		expect(span?.className).toBe(UNKNOWN_CLASS);
		expect(screen.getByText(/Did you mean Date\?/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Fix" })).toBeTruthy();
	});
});

describe("paste", () => {
	// protects=a pasted stored key reads as its friendly pill immediately; fails_when=the raw key lands;
	// no_claim=paste of rich text or files.
	it("converts a pasted {wordOfTheDay}", async () => {
		const { user, ta } = setup();
		await user.click(ta);
		await user.paste("{wordOfTheDay}");
		expect(ta.value).toBe("{Word of the Day}");
	});

	// protects=single-line fields flatten pasted newlines; fails_when=a newline lands;
	// no_claim=typed Enter (the Enter test).
	it("turns a newline pasted into a single-line field into a space", async () => {
		const { user, ta } = setup({ multiline: false });
		await user.click(ta);
		await user.paste("a\nb");
		expect(ta.value).toBe("a b");
	});

	// protects=a paste landing inside a pill leaves a valid pill; fails_when=the pill is split;
	// no_claim=which edge the paste lands on (either is accepted).
	it("a paste at a caret inside a pill does not split it", async () => {
		const { user, ta } = setup({ initial: "{Date}" });
		await user.click(ta);
		ta.setSelectionRange(3, 3);
		await user.paste("x");
		expect(ta.value).toMatch(/^(x\{Date\}|\{Date\}x)$/);
	});
});

describe("the variables prop (#1547)", () => {
	// protects=acceptance 9: @ offers exactly the ten guest variables, and the pill inserts the guest label;
	// fails_when=the menu still lists Promote's fourteen, or a guest-only key has no row;
	// no_claim=popover placement.
	it("@ lists exactly the registry it is given", async () => {
		const { user, ta } = setup({ variables: GUEST_INVITE_VARIABLES });
		await user.type(ta, "@");
		const lb = screen.getByRole("listbox");
		expect(within(lb).getAllByRole("option")).toHaveLength(10);
		expect(within(lb).getByText("Guest first name")).toBeTruthy();
		expect(within(lb).queryByText("Theme")).toBeNull();
		expect(within(lb).getAllByRole("group")).toHaveLength(4);
		await user.click(within(lb).getByText("Last visit"));
		expect(ta.value).toBe("{Last visit}");
	});
});
