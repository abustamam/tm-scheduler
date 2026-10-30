/**
 * True when a key press is aimed at somewhere the user is typing, so a bare
 * single-key shortcut (`/`) must leave it alone. Inputs, textareas, selects and
 * contenteditable regions count; buttons, links and the body do not (#1421).
 * Pure and client-safe: it reads only the target's tag and attributes.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).tagName !== "string") return false;
	const el = target as Element;
	const tag = el.tagName.toLowerCase();
	if (tag === "input" || tag === "textarea" || tag === "select") return true;
	// `closest` rather than `isContentEditable`: jsdom does not implement the
	// latter, and an editable region's descendants inherit editability.
	return (
		el.closest?.('[contenteditable]:not([contenteditable="false"])') != null
	);
}
