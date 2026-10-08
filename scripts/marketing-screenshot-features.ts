/**
 * What each `/tour` capture must SHOW, beyond being the right page (#1122): the
 * features the screenshots were re-taken for. `marketing-screenshot-checks.ts`
 * says a section exists and has its rows; this says the newer controls and
 * captions are drawn on them, so a seed that stops exercising a feature fails
 * the capture instead of producing an image that no longer matches the product.
 *
 * Pure, like its sibling: strings in, a failure or null out
 * (`marketing-screenshot-features.test.ts`). Two kinds of check, because the
 * script reads each page twice:
 *
 *   - `…Features`: drawn by the server, so present in `--dump-dom` and in the
 *     fetched HTML. The script runs these before it writes anything.
 *   - `…Hydrated`: drawn only after mount, so present only in the live page
 *     the screenshot is taken from. `NudgeButtons` renders nothing until it
 *     has mounted and the dashboard knows the browser's origin.
 */
import { GUEST_KIND_LABELS } from "#/lib/guest-profile";
import {
	sliceById,
	VPE_SECTION_ID,
	VPM_SECTION_ID,
} from "./marketing-screenshot-checks";

/** The `aria-label` of every element in `html` that has one. */
function ariaLabels(html: string): string[] {
	return [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1] ?? "");
}

/**
 * The contact method an icon-only nudge link's label names, or null when the
 * label is not one. These are `NudgeButtons`' own phrasings, which its tests
 * pin; a changed label reads here as "no nudge", which is the failure wanted.
 */
function nudgeMethod(label: string): string | null {
	if (/^Message .+ on WhatsApp, opens in a new tab/.test(label))
		return "whatsapp";
	if (/^Text .+ by SMS/.test(label)) return "sms";
	if (/^Call /.test(label)) return "call";
	if (/^Email /.test(label)) return "email";
	return null;
}

/**
 * The VPE shot: the "Close to a level" rows carry the nudge draft (#1034), and
 * it leads with each member's preferred contact (#1105) across more than one
 * method. Hydrated only. A row shows no nudge while its member has a speaker
 * slot ahead, so this also fails when the seed books everyone on the list.
 */
export function checkVpeHydrated(html: string): string | null {
	const section = sliceById(html, VPE_SECTION_ID);
	if (section === null) {
		return `no element with id="${VPE_SECTION_ID}" on the VPE dashboard.`;
	}
	const labels = ariaLabels(section);
	if (!labels.some((l) => nudgeMethod(l) !== null)) {
		return `#${VPE_SECTION_ID} has no nudge draft link: the page had not hydrated, or every member on the list already has a speaker slot. Re-seed (bun run db:seed).`;
	}
	const preferred = new Set(
		labels
			.filter((l) => l.endsWith("(preferred)"))
			.map(nudgeMethod)
			.filter((m): m is string => m !== null),
	);
	if (preferred.size < 2) {
		return `#${VPE_SECTION_ID} marks ${preferred.size} preferred contact method(s) on its nudges, not 2 or more. Re-seed (bun run db:seed).`;
	}
	return null;
}

/**
 * The VPM shot, server-drawn parts: the lane dropdown and the ⋯ menu (#1042),
 * a "Resend invite" control on a guest already invited to the next meeting
 * (#1041), and a caption for each non-visitor guest kind (#1050).
 */
export function checkVpmFeatures(html: string): string | null {
	const section = sliceById(html, VPM_SECTION_ID);
	if (section === null) {
		return `no element with id="${VPM_SECTION_ID}" on the VP Membership page.`;
	}
	const labels = ariaLabels(section);
	if (!labels.some((l) => l.startsWith("Lane for "))) {
		return `#${VPM_SECTION_ID} has no lane dropdown.`;
	}
	if (!labels.some((l) => l.startsWith("More actions for "))) {
		return `#${VPM_SECTION_ID} has no ⋯ menu.`;
	}
	if (!labels.includes("Resend invite")) {
		return `#${VPM_SECTION_ID} has no "Resend invite" control: no guest is invited to the next meeting. Re-seed (bun run db:seed).`;
	}
	const captions = [
		...section.matchAll(/data-slot="guest-kind-caption"[^>]*>([^<]*)</g),
	].map((m) => m[1] ?? "");
	for (const kind of ["visiting_toastmaster", "guest_speaker"] as const) {
		if (!captions.some((c) => c.startsWith(GUEST_KIND_LABELS[kind]))) {
			return `#${VPM_SECTION_ID} shows no "${GUEST_KIND_LABELS[kind]}" caption. Re-seed (bun run db:seed).`;
		}
	}
	return null;
}

/**
 * The VPM shot, hydrated parts: the invite's WhatsApp or email DRAFT link. The
 * guest's own contact links are drawn by the server and look alike (`wa.me/…`,
 * `mailto:…`), so this keys off what only a draft has: a prefilled `text=` or
 * `subject=`.
 */
export function checkVpmHydrated(html: string): string | null {
	const section = sliceById(html, VPM_SECTION_ID);
	if (section === null) {
		return `no element with id="${VPM_SECTION_ID}" on the VP Membership page.`;
	}
	if (
		!/href="(https:\/\/wa\.me\/\d+\?text=|mailto:[^"]*\?subject=)/.test(section)
	) {
		return `#${VPM_SECTION_ID} has no invite draft link: the page had not hydrated when the shot was taken.`;
	}
	return null;
}

/**
 * The printed agenda: a guest who is a visiting Toastmaster or a guest speaker
 * holds a role, so the roster names their kind (#1059). Read from the fetched
 * HTML of `/print`. A caption is "Name · Guest speaker, Home club", and a
 * Visitor's is "Name · Guest", which does not count.
 */
export function checkAgendaFeatures(html: string): string | null {
	const labels = [
		GUEST_KIND_LABELS.visiting_toastmaster,
		GUEST_KIND_LABELS.guest_speaker,
	];
	if (!labels.some((label) => html.includes(` · ${label}`))) {
		return `the printed agenda shows no guest kind caption (${labels.join(" or ")}): no visiting Toastmaster or guest speaker holds a role on it. Re-seed (bun run db:seed).`;
	}
	return null;
}
