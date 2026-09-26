/**
 * The pure half of `capture-marketing-screenshots.ts` (#901): which base URLs
 * the script may sign in against, the dev-login URL it points Chrome at, and
 * the DOM checks each signed-in capture must pass before it is shot. No `#/db`
 * and no Chrome, so the refusals are unit-testable
 * (`marketing-screenshot-checks.test.ts`); the script itself only wires them
 * to the database, `fetch` and the browser.
 */

/**
 * Dev-login is inert in production already (`src/lib/dev-login.ts`). This makes
 * the script refuse up front rather than 404 against a deployed app, and keeps
 * it from ever signing in anywhere but the developer's own machine.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	return host === "localhost" || host === "127.0.0.1";
}

/**
 * `path` may carry a fragment. `encodeURIComponent` sends its `#` as `%23`, so
 * it reaches dev-login inside `redirect` instead of being dev-login's own
 * fragment, rides through the magic link's `callbackURL`, and lands on the
 * final redirect, where the browser scrolls the section to the top.
 */
export function devLoginUrl(
	baseUrl: string,
	email: string,
	path: string,
): string {
	return `${baseUrl}/api/dev-login?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(path)}`;
}

/** What a dev-login preflight's status means, or null when it is the 302 we want. */
export function devLoginPreflightError(
	status: number,
	body: string,
): string | null {
	if (status === 302) return null;
	if (status === 404) {
		return "dev-login answered 404: start the dev server with ENABLE_DEV_LOGIN=1 (it is off unless that is set, and always off in production).";
	}
	if (status === 500) {
		return `dev-login answered 500: ${body.trim() || "(empty body)"}`;
	}
	return `dev-login answered ${status}, not 302.`;
}

/**
 * The outer HTML of the element carrying `id="…"`, from its open tag to the
 * matching close tag, or null when the id is absent or the element never
 * closes. Counts nested tags of the same name, which is all a dumped React
 * tree needs; it is not a general HTML parser.
 */
export function sliceById(html: string, id: string): string | null {
	const attr = html.indexOf(`id="${id}"`);
	if (attr === -1) return null;
	const start = html.lastIndexOf("<", attr);
	if (start === -1) return null;
	const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(start))?.[1];
	if (!tag) return null;
	const token = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, "gi");
	token.lastIndex = start;
	let depth = 0;
	for (let m = token.exec(html); m; m = token.exec(html)) {
		if (m[1] === "/") depth--;
		else if (!m[0].endsWith("/>")) depth++;
		if (depth === 0) return html.slice(start, token.lastIndex);
	}
	return null;
}

/**
 * Better Auth's rate limiter answers the magic-link verify with a bare JSON
 * 429 once this IP has made 20 auth requests in 60s (`src/lib/auth.ts`).
 * Each signed-in capture spends one verify plus the page's own session reads,
 * so a few back-to-back runs trip it — and without this the DOM check would
 * report a missing section, which sends you looking in the wrong place.
 */
function rateLimited(html: string): string | null {
	return html.includes("Too many requests")
		? "Better Auth rate-limited the sign-in (20 auth requests per 60s from one IP). Wait a minute and re-run."
		: null;
}

export const VPE_SECTION_ID = "close-to-a-level";
export const VPM_SECTION_ID = "guest-pipeline";

/**
 * The VPE shot: the "Close to a level" section with at least one row that
 * NAMES what is left ("1 left: Evaluation and Feedback"), not a bare count.
 * Returns the failure, or null.
 */
export function checkVpeDom(html: string): string | null {
	const limited = rateLimited(html);
	if (limited) return limited;
	const section = sliceById(html, VPE_SECTION_ID);
	if (section === null) {
		return `no element with id="${VPE_SECTION_ID}" on the VPE dashboard.`;
	}
	if (!section.includes("Close to a level")) {
		return `#${VPE_SECTION_ID} does not say "Close to a level".`;
	}
	if (!/\d+ left: /.test(section)) {
		return `#${VPE_SECTION_ID} has no row naming what is left ("N left: …"). Re-seed (bun run db:seed).`;
	}
	return null;
}

/**
 * The VPM shot: an "Invite to …" control, an "Invited to … · by …" line, and a
 * WhatsApp or email draft link. `NudgeButtons` renders those links only after
 * mount, so the link is the evidence the page hydrated before Chrome dumped
 * it — and the screenshot run uses the same flags and timing. Returns the
 * failure, or null.
 */
export function checkVpmDom(html: string): string | null {
	const limited = rateLimited(html);
	if (limited) return limited;
	const section = sliceById(html, VPM_SECTION_ID);
	if (section === null) {
		return `no element with id="${VPM_SECTION_ID}" on the VP Membership page.`;
	}
	if (!section.includes("Invite to")) {
		return `#${VPM_SECTION_ID} has no "Invite to" control. Re-seed: no upcoming meeting, or no invitable guest.`;
	}
	if (!section.includes("Invited to")) {
		return `#${VPM_SECTION_ID} has no "Invited to" line. Re-seed (bun run db:seed).`;
	}
	if (!/href="(https:\/\/wa\.me\/|mailto:)/.test(section)) {
		return `#${VPM_SECTION_ID} has no WhatsApp or email draft link: the page had not hydrated when Chrome dumped it.`;
	}
	return null;
}

/** Where the target section landed in the viewport, measured in the page. */
export interface SectionFrame {
	/** `getBoundingClientRect().top` of the section root, in CSS px. */
	top: number;
	viewportHeight: number;
	/** Whether the point just inside the section's top-left corner hits the
	 *  section itself, i.e. no sticky header is drawn over its heading. */
	headingVisible: boolean;
}

/**
 * #901's framing rule for the officer shots, measured rather than eyeballed:
 * the section's top edge — its heading — sits in the top quarter of the image
 * and is not covered. Returns the failure, or null.
 */
export function framingProblem(id: string, frame: SectionFrame | null): string | null {
	if (frame === null) return `no element with id="${id}" to frame.`;
	const limit = frame.viewportHeight / 4;
	if (frame.top < 0 || frame.top > limit) {
		return `#${id} starts ${Math.round(frame.top)}px down a ${frame.viewportHeight}px viewport, outside the top quarter (0–${limit}px): the fragment did not scroll it into place.`;
	}
	if (!frame.headingVisible) {
		return `#${id} is at the top, but something (the sticky header?) is drawn over its heading.`;
	}
	return null;
}
