// One field of the promo template editor (#1536): a native textarea whose
// `{variables}` are painted as pills, with an `@` / `{` menu that inserts them,
// near-atomic pill deletion, inline "did you mean" help and a per-field "Use
// default". The text IS the editor form (`{Word of the Day}`); the parent turns
// it into the stored form (`{wordOfTheDay}`) with `toStoredText`.
//
// Why a native textarea (decision 1 of #1532): undo, IME, the phone keyboard,
// screen readers and jsdom all stay native. The pills are a transparent copy of
// the text painted BEHIND the textarea; `field-sizing-content` makes the
// textarea grow with its text, so the two never scroll against each other
// (where it is unsupported the copy mirrors `scrollTop`).

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	PROMO_VARIABLES,
	suggestPlaceholder,
	type TemplateVariable,
	toEditorText,
	toStoredText,
	unknownPlaceholders,
} from "#/lib/promo-template";
import { cn } from "#/lib/utils";
import {
	caretRule,
	filterVariables,
	findTokens,
	flattenNewlines,
	isSuppressed,
	menuStateFromInput,
	type Suppression,
	snapCaret,
} from "./template-field-logic";
import { VariableMenu } from "./variable-menu";

/** A known variable behind the text. Nothing here may change the text's width.
 *  `rounded-md`, not DESIGN.md's `full` chip radius: it sits inside running text
 *  behind a textarea, where a pill-shaped end would clip the neighbouring glyphs. */
export const PILL_CLASS = "rounded-md bg-primary/10";
/** An unknown `{token}`: a typo flag, not a pill. */
export const UNKNOWN_CLASS =
	"underline decoration-wavy decoration-warning underline-offset-2";
/** The controls row's buttons are 44px below `md`. */
export const FIELD_BUTTON_CLASS = "h-11 md:h-8";

/** Edit the textarea so native undo can reverse it as one step; fall back to
 *  `setRangeText` plus a synthetic `input` event where `execCommand` is missing
 *  (jsdom) or refuses. */
function applyEdit(
	ta: HTMLTextAreaElement,
	start: number,
	end: number,
	insert: string,
) {
	ta.focus();
	ta.setSelectionRange(start, end);
	let done = false;
	try {
		if (typeof document.execCommand === "function") {
			done =
				insert === ""
					? document.execCommand("delete")
					: document.execCommand("insertText", false, insert);
		}
	} catch {
		done = false;
	}
	if (done) return;
	ta.setRangeText(insert, start, end, insert === "" ? "start" : "end");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function Backdrop({
	value,
	variables,
	innerRef,
}: {
	value: string;
	variables: readonly TemplateVariable[];
	innerRef: React.Ref<HTMLDivElement>;
}) {
	const parts: React.ReactNode[] = [];
	let pos = 0;
	for (const t of findTokens(value, variables)) {
		if (t.start > pos) parts.push(value.slice(pos, t.start));
		parts.push(
			<span key={t.start} className={t.known ? PILL_CLASS : UNKNOWN_CLASS}>
				{value.slice(t.start, t.end)}
			</span>,
		);
		pos = t.end;
	}
	parts.push(value.slice(pos));
	return (
		<div
			ref={innerRef}
			aria-hidden
			data-slot="template-field-backdrop"
			className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 text-base break-words whitespace-pre-wrap text-transparent md:text-sm"
		>
			{parts}
			{"\u200b"}
		</div>
	);
}

export function TemplateField({
	id,
	label,
	value,
	onChange,
	multiline = true,
	rows,
	limit,
	bullets,
	defaultValue,
	values,
	hint,
	variables = PROMO_VARIABLES,
}: {
	id: string;
	label: string;
	/** EDITOR form (friendly labels). */
	value: string;
	onChange: (editor: string) => void;
	/** false: Enter is swallowed and the field wraps instead of adding lines. */
	multiline?: boolean;
	rows?: number;
	/** Applied to the STORED form's length. Exactly one of `limit` or `bullets`. */
	limit?: number;
	bullets?: { perLine: number; max: number };
	/** Editor form of the default, for "Use default". */
	defaultValue: string;
	/** This meeting's values for the menu's value column; null while unknown. */
	values: Readonly<Record<string, string>> | null;
	hint?: string;
	/** The variables this field offers. Defaults to Promote's. */
	variables?: readonly TemplateVariable[];
}) {
	const uid = useId();
	const listboxId = `${id}-listbox-${uid.replace(/:/g, "")}`;
	const hintId = `${id}-hint`;
	const typosId = `${id}-typos`;
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const backdropRef = useRef<HTMLDivElement | null>(null);
	const lastSel = useRef<{ start: number; end: number } | null>(null);

	const [caret, setCaret] = useState<number | null>(null);
	const [focused, setFocused] = useState(false);
	const [composing, setComposing] = useState(false);
	const [manualOpen, setManualOpen] = useState(false);
	const [suppression, setSuppression] = useState<Suppression | null>(null);
	const [activeIdx, setActiveIdx] = useState(0);
	const [announce, setAnnounce] = useState("");

	// --- the menu -----------------------------------------------------------
	const trigger =
		!focused || composing || caret === null
			? null
			: menuStateFromInput(value, caret);
	const suppressed =
		suppression !== null &&
		trigger !== null &&
		caret !== null &&
		trigger.triggerIndex === suppression.index &&
		isSuppressed(value, caret, suppression);
	const triggerMenu = trigger && !suppressed ? trigger : null;
	const options = manualOpen
		? [...variables]
		: triggerMenu
			? filterVariables(triggerMenu.filter, variables)
			: [];
	const open = options.length > 0;
	const active = options[Math.min(activeIdx, options.length - 1)] ?? null;
	const filterKey = manualOpen
		? "manual"
		: triggerMenu
			? `${triggerMenu.triggerIndex}:${triggerMenu.filter}`
			: "";

	// biome-ignore lint/correctness/useExhaustiveDependencies: the filter is the trigger
	useEffect(() => {
		setActiveIdx(0);
	}, [filterKey]);

	useEffect(() => {
		if (
			suppression &&
			!(caret !== null && isSuppressed(value, caret, suppression))
		)
			setSuppression(null);
	}, [suppression, caret, value]);

	// The opening announcement is cleared on close, so reopening changes the
	// live region's text again and is read out. A just-set "Inserted X" stays.
	const openingText = `${variables.length} variables, use up and down then Enter`;
	useEffect(() => {
		if (open) setAnnounce(openingText);
		else setAnnounce((a) => (a === openingText ? "" : a));
	}, [open, openingText]);

	// Where a pick or Insert variable lands: the last known selection, or the
	// end of the text when the field was never focused, clamped to the text.
	function savedSelection(length: number) {
		const sel = lastSel.current ?? { start: length, end: length };
		return {
			start: Math.min(sel.start, length),
			end: Math.min(sel.end, length),
		};
	}

	// A native scrollbar takes width from the textarea's text column; the
	// backdrop (absolutely positioned) must lose the same width, or text and
	// pills wrap on different lines. 0 with no scrollbar or an overlay one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change
	useLayoutEffect(() => {
		const ta = taRef.current;
		const backdrop = backdropRef.current;
		if (!ta || !backdrop) return;
		const measure = () => {
			const cs = getComputedStyle(ta);
			const borders =
				(Number.parseFloat(cs.borderLeftWidth) || 0) +
				(Number.parseFloat(cs.borderRightWidth) || 0);
			backdrop.style.right = `${Math.max(0, ta.offsetWidth - ta.clientWidth - borders)}px`;
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [value]);

	function remember(ta: HTMLTextAreaElement) {
		lastSel.current = { start: ta.selectionStart, end: ta.selectionEnd };
		setCaret(ta.selectionStart);
	}

	/** Track the caret; a collapsed caret strictly inside a pill snaps to the
	 *  nearer edge (which is not "strictly inside", so it cannot loop). */
	function syncCaret(ta: HTMLTextAreaElement) {
		if (composing) return;
		if (ta.selectionStart === ta.selectionEnd) {
			const snapped = snapCaret(ta.value, ta.selectionStart, variables);
			if (snapped !== null) ta.setSelectionRange(snapped, snapped);
		}
		remember(ta);
	}

	function pick(key: string) {
		const ta = taRef.current;
		if (!ta) return;
		const label = variables.find((v) => v.key === key)?.label ?? key;
		const text = `{${label}}`;
		let start: number;
		let end: number;
		if (manualOpen) {
			({ start, end } = savedSelection(value.length));
		} else if (triggerMenu && caret !== null) {
			start = triggerMenu.triggerIndex;
			end = caret;
		} else return;
		setManualOpen(false);
		applyEdit(ta, start, end, text);
		setAnnounce(`Inserted ${label}`);
	}

	function openManually() {
		const ta = taRef.current;
		if (!ta) return;
		if (document.activeElement !== ta) {
			ta.focus();
			const sel = savedSelection(ta.value.length);
			ta.setSelectionRange(sel.start, sel.end);
		}
		remember(ta);
		setSuppression(null);
		setManualOpen(true);
	}

	function closeMenu() {
		if (manualOpen) setManualOpen(false);
		// An `@` or `{` underneath a manually opened menu would reopen it at once.
		if (triggerMenu && caret !== null)
			setSuppression({
				index: triggerMenu.triggerIndex,
				char: value[triggerMenu.triggerIndex],
				caret,
			});
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (composing || e.nativeEvent.isComposing) return;
		if (open) {
			const n = options.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIdx((Math.min(activeIdx, n - 1) + 1) % n);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIdx((Math.min(activeIdx, n - 1) - 1 + n) % n);
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && active) {
				e.preventDefault();
				pick(active.key);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				closeMenu();
				return;
			}
		}
		if (e.key === "Enter" && !multiline) {
			e.preventDefault();
			return;
		}
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const ta = e.currentTarget;
		const edit = caretRule(
			ta.value,
			ta.selectionStart,
			ta.selectionEnd,
			e.key,
			variables,
		);
		if (!edit) return;
		e.preventDefault();
		if (edit.text === ta.value) {
			ta.setSelectionRange(edit.selStart, edit.selEnd);
			remember(ta);
		} else {
			applyEdit(
				ta,
				edit.selStart,
				edit.selStart + (ta.value.length - edit.text.length),
				"",
			);
		}
	}

	function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
		const raw = e.clipboardData?.getData("text");
		if (!raw) return;
		e.preventDefault();
		const ta = e.currentTarget;
		let segment = toEditorText(raw, variables);
		if (!multiline) segment = flattenNewlines(segment);
		let start = ta.selectionStart;
		let end = ta.selectionEnd;
		if (start === end) {
			// A paste never lands inside a pill, which would break it.
			const snapped = snapCaret(ta.value, start, variables);
			if (snapped !== null) start = end = snapped;
		}
		applyEdit(ta, start, end, segment);
	}

	function fixTypo(name: string, to: string) {
		const ta = taRef.current;
		if (!ta) return;
		applyEdit(
			ta,
			0,
			ta.value.length,
			ta.value.split(`{${name}}`).join(`{${to}}`),
		);
	}

	// --- counters and typo help ---------------------------------------------
	const stored = toStoredText(value, variables);
	const storedLines = stored
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const typos = unknownPlaceholders(stored, variables).map((name) => ({
		name,
		suggestion: suggestPlaceholder(name, variables),
	}));
	const dirty = stored !== toStoredText(defaultValue, variables);
	const longest = Math.max(0, ...storedLines.map((l) => l.length));
	const over = bullets
		? storedLines.length > bullets.max || longest > bullets.perLine
		: limit !== undefined && stored.length > limit;

	const describedBy =
		[hint ? hintId : null, typos.length > 0 ? typosId : null]
			.filter(Boolean)
			.join(" ") || undefined;

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Label htmlFor={id}>{label}</Label>
				<div className="flex items-center gap-1">
					{dirty ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className={FIELD_BUTTON_CLASS}
							onClick={() => onChange(defaultValue)}
						>
							Use default
						</Button>
					) : null}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={FIELD_BUTTON_CLASS}
						// Keep the textarea's focus (and caret) when the button is pressed.
						onMouseDown={(e) => e.preventDefault()}
						onClick={openManually}
					>
						Insert variable
					</Button>
				</div>
			</div>

			<VariableMenu
				open={open}
				onDismiss={closeMenu}
				listboxId={listboxId}
				options={options}
				activeKey={active?.key ?? null}
				onPick={pick}
				values={values}
			>
				<div
					data-slot="template-field"
					className="relative rounded-md border border-input shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
				>
					<Backdrop
						value={value}
						variables={variables}
						innerRef={backdropRef}
					/>
					<Textarea
						id={id}
						ref={taRef}
						rows={rows ?? (multiline ? 3 : 1)}
						value={value}
						aria-describedby={describedBy}
						aria-autocomplete={open ? "list" : undefined}
						aria-controls={open ? listboxId : undefined}
						aria-activedescendant={
							open && active ? `${listboxId}-${active.key}` : undefined
						}
						className={cn(
							"relative border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
							!multiline && "min-h-0",
						)}
						onChange={(e) => {
							const ta = e.currentTarget;
							remember(ta);
							if (manualOpen) setManualOpen(false);
							onChange(multiline ? ta.value : flattenNewlines(ta.value));
						}}
						onKeyDown={onKeyDown}
						onKeyUp={(e) => syncCaret(e.currentTarget)}
						onClick={(e) => syncCaret(e.currentTarget)}
						onSelect={(e) => syncCaret(e.currentTarget)}
						onPaste={onPaste}
						onScroll={(e) => {
							if (backdropRef.current)
								backdropRef.current.scrollTop = e.currentTarget.scrollTop;
						}}
						onFocus={() => setFocused(true)}
						onBlur={() => {
							setFocused(false);
							setManualOpen(false);
							const normal = toEditorText(
								multiline ? value : flattenNewlines(value),
								variables,
							);
							if (normal !== value) onChange(normal);
						}}
						onCompositionStart={() => setComposing(true)}
						onCompositionEnd={(e) => {
							setComposing(false);
							remember(e.currentTarget);
						}}
					/>
				</div>
			</VariableMenu>

			<div aria-live="polite" className="sr-only">
				{announce}
			</div>

			{hint ? (
				<p id={hintId} className="text-xs text-muted-foreground">
					{hint}
				</p>
			) : null}

			<p
				className={cn(
					"text-xs",
					over ? "text-warning-foreground" : "text-muted-foreground",
				)}
			>
				{bullets
					? `${storedLines.length} of ${bullets.max} bullets, longest line ${longest} / ${bullets.perLine}`
					: `${stored.length} / ${limit}`}
			</p>

			{typos.length > 0 ? (
				<ul id={typosId} className="space-y-1 text-sm">
					{typos.map(({ name, suggestion }) => (
						<li key={name} className="flex flex-wrap items-center gap-2">
							{suggestion ? (
								<>
									<span>{`Not a variable: {${name}}. Did you mean ${suggestion.label}?`}</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className={FIELD_BUTTON_CLASS}
										onClick={() => fixTypo(name, suggestion.label)}
									>
										Fix
									</Button>
								</>
							) : (
								<span>
									Not a variable: {`{${name}}`}. It will show exactly as typed.
								</span>
							)}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
