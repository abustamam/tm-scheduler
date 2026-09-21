// src/components/club/personal-meeting-editors.tsx
//
// The two focused, phone-sized duty editors behind the personal meeting page's
// checklist (#666): set the meeting THEME, and set the WORD OF THE DAY.
//
// ## Why the bodies live here and not in the route files
//
// Same reason `personal-meeting-body.tsx` next door gives: a route module
// imports `#/server/meetings` → `#/db` and throws `DATABASE_URL is not set` the
// moment vitest imports it, so anything inside one is reachable by a source
// grep and nothing else. Everything with a branch in it is therefore here.
//
// ## The props are PASS-THROUGH, deliberately
//
// These components take the loader's raw fields — `meeting`, `slots`,
// `canManage`, `memberId` — and derive the capability THEMSELVES through
// `resolveMeetingViewer`. That is the direct answer to CODING_STANDARDS'
// "a component tested through its props cannot see a WRONG prop": had the route
// computed `canEdit` and passed a boolean, the one expression that decides who
// may edit a meeting from a forwarded chat link would be untested by
// construction — which is exactly the #319 shape. The route now passes only
// values it read out of the loader, so there is nothing in it left to get
// wrong.
//
// ## No new authorization, and none of this IS authorization
//
// Every gate below is an AFFORDANCE. The writes are the same two public server
// fns the meeting page's dialogs call, and `requireMeetingAgendaEditor` /
// `requireWordOfTheDayEditor` re-decide server-side on every request against
// `role_definitions.key` (#464). A wrong answer here shows or hides a form; it
// grants nothing. `resolveMeetingViewer` is reused rather than re-derived so
// this surface and the agenda cannot come to disagree about who runs a meeting.

import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { formatMeetingDate } from "#/lib/format";
import { isMeetingLocked, resolveMeetingViewer } from "#/lib/meeting-lifecycle";
import { MEETING_LIMITS } from "#/lib/meeting-limits";
import { deriveMeetingRoleFlags } from "#/lib/meeting-roles";
import { canEditWordOfTheDay } from "#/lib/meeting-viewer";
import { personalMeetingHref } from "#/lib/role-duties";
import { WOD_LIMITS } from "#/lib/wod-limits";
import { updateMeeting, updateWordOfTheDay } from "#/server/meetings";

/** The meeting fields both editors read. A structural subset of the meeting row
 *  the shared loaders return, so a route hands its `meeting` straight over.
 *
 *  Deliberately NARROW since #772: it carries what these two forms PREFILL and
 *  no longer the six meta fields a theme save used to echo back. Widening it to
 *  cover the meeting row again would be the first half of reintroducing that
 *  lost update. */
export interface EditorMeeting {
	/** The RESOLVED uuid. Both writers validate `z.string().uuid()`, so the
	 *  `$meetingId` URL segment (a club-local date key) would be rejected at the
	 *  write, after the page had already rendered fine. */
	id: string;
	/** `Date` during SSR, string after hydration — the union is the honest type
	 *  for anything that crossed a server fn. */
	scheduledAt: Date | string;
	status: string;
	/** Prefills the theme editor. */
	theme: string | null;
	/** Prefill the WORD editor — and since #793 that is ALL they do. They are what
	 *  the three inputs show on arrival, and the same values the submit compares
	 *  against to decide which columns the officer actually edited; a field that
	 *  still reads as it was seeded is omitted from the payload rather than
	 *  written back. `applyWordOfTheDayUpdate` is a patch now, so an omitted field
	 *  is left alone.
	 *
	 *  That closes the last of the class #772 closed on the general meta writer.
	 *  These three used to ride EVERY save straight off this snapshot, so a
	 *  `wodExample` the Toastmaster added through the Edit-meeting dialog after
	 *  this page loaded was reverted the moment the Grammarian saved their word. */
	wordOfTheDay: string | null;
	wodDefinition: string | null;
	wodExample: string | null;
}

/** One slot, reduced to what `deriveMeetingRoleFlags` matches on. */
export interface EditorSlot {
	roleName: string;
	roleKey?: string | null;
	assigneeId: string | null;
}

interface EditorProps {
	/** The RAW `$clubId` URL param (slug or uuid) — for links, which must land
	 *  on the same spelling the visitor arrived with. */
	clubId: string;
	/** The RAW `$meetingId` URL segment (a club-local date key, usually). */
	meetingId: string;
	meeting: EditorMeeting;
	slots: EditorSlot[];
	/** The club's timezone, for the date line and the lifecycle (meeting-over)
	 *  check. The wall-time echo it also fed went with #772. */
	timezone: string;
	canManage: boolean;
	/** The effective member id — session member or localStorage pick. Null when
	 *  nobody is identified, which the ROUTE handles before rendering these. */
	memberId: string | null;
	isSignedIn: boolean;
	/** Called after a write lands. The route navigates back to the personal page
	 *  so the checklist visibly ticks — the tick is the receipt (#666). */
	onSaved: () => void | Promise<void>;
}

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The shared card: one heading, one sentence of context, one form, one way back.
 *
 * The back link is a plain `<Link>` rather than `BackLink`: arrival here is a
 * tap from the personal page (or a chat link), so this is a return, and it sits
 * BELOW the card where a thumb is rather than above the heading.
 */
function EditorCard({
	title,
	blurb,
	when,
	backHref,
	children,
}: {
	title: string;
	blurb: string;
	when: string;
	backHref: string;
	children: React.ReactNode;
}) {
	return (
		<div className="mx-auto w-full max-w-reading space-y-4 p-4 pb-10">
			<header className="space-y-1 pt-2">
				<p className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.04em]">
					{when}
				</p>
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					{title}
				</h1>
				<p className="text-muted-foreground text-sm">{blurb}</p>
			</header>
			<div className="rounded-lg border border-[var(--line)] p-4">
				{children}
			</div>
			<Link
				to={backHref}
				className="inline-block text-sm text-primary hover:underline"
			>
				Back to your meeting page
			</Link>
		</div>
	);
}

/**
 * Why the form is not being offered — or null when it is.
 *
 * Ordered so the WINDOW outranks the ROLE: telling the meeting's Toastmaster
 * they are not the Toastmaster, because the meeting was completed an hour ago,
 * sends them looking for a permissions problem that does not exist. It is the
 * same ordering, for the same reason, that the agenda-write resolvers put the
 * archive gate ahead of the lock.
 *
 * `cancelled` is checked separately from `isMeetingOver`, and it is NOT
 * redundant: a cancelled meeting whose date is still in the future is neither
 * completed nor past, so without this arm the club would be invited to write a
 * theme for a meeting that is not happening. `personal-meeting-body.tsx` makes
 * the identical exception for the identical reason.
 */
export function editorBlockedReason(input: {
	status: string;
	canEdit: boolean;
	/** Copy for the role-denial arm — the two editors grant to different roles. */
	roleMessage: string;
}): string | null {
	if (input.status === "cancelled") {
		return "This meeting was cancelled, so its agenda is closed.";
	}
	if (input.canEdit) return null;
	if (isMeetingLocked(input.status)) {
		return "This meeting is finished, so its agenda is closed.";
	}
	return input.roleMessage;
}

/**
 * The shared save/submit machinery. Extracted because the two forms differ only
 * in which writer they call and what they read out of the form — and a second
 * copy of "set busy, await, toast, hand back" is where the two would drift on
 * the part that matters, which is that `onSaved` runs ONLY after a write lands.
 */
function useDutySave(onSaved: () => void | Promise<void>) {
	const [saving, setSaving] = useState(false);
	async function run(write: () => Promise<unknown>, done: string) {
		setSaving(true);
		try {
			await write();
			toast.success(done);
			// AFTER the await, and only on the success path: a failed write that
			// still navigated would send the member back to a checklist that has
			// not ticked, with the toast already gone.
			await onSaved();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSaving(false);
		}
	}
	return { saving, run };
}

/**
 * Everything both editors derive from the loader's raw fields. One helper so
 * the two cannot answer "is this editable?" differently.
 */
function useEditorContext(props: EditorProps) {
	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(
		props.slots,
		props.memberId,
	);
	const viewer = resolveMeetingViewer({
		status: props.meeting.status,
		scheduledAt: props.meeting.scheduledAt,
		timezone: props.timezone,
		currentMemberId: props.memberId,
		canManage: props.canManage,
		isTmod,
		isGrammarian,
		isSignedIn: props.isSignedIn,
	});
	return {
		viewer,
		when: formatMeetingDate(props.meeting.scheduledAt, props.timezone),
		backHref: personalMeetingHref({
			clubId: props.clubId,
			meetingId: props.meetingId,
		}),
	};
}

/** The blocked card — heading and back link intact, form replaced by the why. */
function BlockedCard({
	title,
	when,
	backHref,
	reason,
}: {
	title: string;
	when: string;
	backHref: string;
	reason: string;
}) {
	return (
		<EditorCard title={title} blurb={reason} when={when} backHref={backHref}>
			<p className="text-muted-foreground text-sm">
				Nothing to do here — head back to your meeting page.
			</p>
		</EditorCard>
	);
}

const THEME_TITLE = "Set the meeting theme";
const THEME_BLURB =
	"Your theme gives the meeting a thread — the Table Topics Master and speakers will build on it.";

/**
 * The Toastmaster of the Day's focused theme editor.
 *
 * Writes through `updateMeeting`, which since #772 is a PATCH: the payload is
 * the theme and the two identity fields, and every column it does not name is
 * left alone by `applyMeetingMetaPatch`. It used to send six more, echoed off
 * the page's loader snapshot, because the writer nulled what it was not given —
 * which meant a theme save silently reverted a Word of the Day the Grammarian
 * had entered after this page loaded. The small payload is the fix; a field
 * added back to it is that bug returning.
 */
export function PersonalThemeEditor(props: EditorProps) {
	const { viewer, when, backHref } = useEditorContext(props);
	const { saving, run } = useDutySave(props.onSaved);
	const [theme, setTheme] = useState(props.meeting.theme ?? "");

	const blocked = editorBlockedReason({
		status: props.meeting.status,
		canEdit: viewer.canEditMeetingMeta,
		roleMessage:
			"Only this meeting's Toastmaster — or a club officer — can set the theme.",
	});
	if (blocked) {
		return (
			<BlockedCard
				title={THEME_TITLE}
				when={when}
				backHref={backHref}
				reason={blocked}
			/>
		);
	}

	return (
		<EditorCard
			title={THEME_TITLE}
			blurb={THEME_BLURB}
			when={when}
			backHref={backHref}
		>
			<form
				className="space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					void run(
						() =>
							updateMeeting({
								data: {
									meetingId: props.meeting.id,
									// ALWAYS sent, signed in or not. `isSignedIn` is not "is an
									// admin": `publicShellDecision` returns `shell: true` for
									// ANY member of the club, so nulling on it refused the
									// ordinary signed-in member who holds this meeting's TMOD
									// slot — the form rendered (`canEditMeetingMeta` is
									// `runsMeeting && isEditableWindow`, and `runsMeeting`
									// includes `isTmod`) and Save threw "You don't have
									// permission to edit this meeting."
									//
									// Sending it is not the forgeable input #396 removed,
									// because the server never TRUSTS it:
									// `resolveMeetingAgendaAuthz` runs the admin arm FIRST and
									// never reads `selfMemberId`, so an admin resolves through
									// the session either way; the self-assert arm then compares
									// it against `role_slots.assigned_member_id` before
									// crediting it. The existing dialog already does exactly
									// this — `club.$clubId.meeting.$meetingId.tsx:944` branches
									// on `canManage`, never on having a session.
									selfMemberId: props.memberId,
									// The theme, and NOTHING else (#772). `updateMeeting` is a
									// patch: what is absent is left alone. Sending the six other
									// meta fields — which this editor did until #772, because the
									// writer nulled what it was not given — wrote back a
									// page-load snapshot and reverted whatever the Grammarian had
									// saved since. Blank clears, which is a legitimate edit.
									theme,
								},
							}),
						"Theme saved.",
					);
				}}
			>
				<div className="space-y-2">
					<Label htmlFor="theme">Theme</Label>
					<Input
						id="theme"
						name="theme"
						value={theme}
						maxLength={MEETING_LIMITS.theme}
						placeholder="e.g. New beginnings"
						onChange={(e) => setTheme(e.target.value)}
					/>
				</div>
				<Button type="submit" size="lg" className="w-full" disabled={saving}>
					{saving ? <Loader2 className="size-4 animate-spin" /> : "Save theme"}
				</Button>
			</form>
		</EditorCard>
	);
}

const WORD_TITLE = "Set the Word of the Day";
const WORD_BLURB =
	"One word for the club to work into what they say — the definition and an example help everyone use it.";

/** What the three inputs hold, keyed by the input rather than by the column. The
 *  two spellings are kept apart on purpose: the payload's keys are the COLUMN
 *  names, and `WOD_PATCH_FIELDS` below is the one place that pairs them. */
interface WordOfTheDayDraft {
	word: string;
	definition: string;
	example: string;
}

/** column ← input. The enrolment list for `wordOfTheDayPatch`: a fourth
 *  Word-of-the-Day field is edited by adding a row here, and
 *  `personal-duty-routes.guard.test.ts` reads it back against
 *  `updateWordOfTheDaySchema` so one added to the wire and forgotten here fails. */
const WOD_PATCH_FIELDS = [
	["wordOfTheDay", "word"],
	["wodDefinition", "definition"],
	["wodExample", "example"],
] as const satisfies readonly (readonly [string, keyof WordOfTheDayDraft])[];

/**
 * The Word-of-the-Day payload: ONLY the fields the officer actually edited
 * (#793).
 *
 * Three states, and the middle one is the trap. A field reading as it was seeded
 * is OMITTED, which `applyWordOfTheDayUpdate` leaves alone — that is the fix. A
 * field the officer BLANKED travels as `""`, which that writer clears, and it has
 * to: flipping a writer to patch semantics silently removes a form's only way to
 * clear a field unless the form changes in the same breath (#772 learned this on
 * the meeting dialog). `""` rather than `null` because `updateWordOfTheDaySchema`
 * types these as plain strings on the wire; the writer treats the two the same.
 *
 * Seed-versus-current rather than an onChange "touched" flag, because the two
 * differ exactly where it matters: typing into a field and typing it back is not
 * an edit, and echoing it would write a page-load snapshot over whatever another
 * officer stored since — the bug this function exists to prevent.
 *
 * Not exported: every arm is driven through the rendered form in
 * `personal-meeting-editors.test.tsx`, which is the assertion that matters —
 * what the officer's typing turns into on the wire.
 */
function wordOfTheDayPatch(
	seed: WordOfTheDayDraft,
	current: WordOfTheDayDraft,
): { wordOfTheDay?: string; wodDefinition?: string; wodExample?: string } {
	const patch: {
		wordOfTheDay?: string;
		wodDefinition?: string;
		wodExample?: string;
	} = {};
	for (const [column, field] of WOD_PATCH_FIELDS) {
		const next = current[field].trim();
		if (next !== seed[field].trim()) patch[column] = next;
	}
	return patch;
}

/**
 * The Grammarian's focused Word-of-the-Day editor.
 *
 * Writes through `updateWordOfTheDay`, which touches the three WOD columns and
 * physically cannot reach any other meta — so unlike the theme editor above it
 * needs no echo of the rest of the meeting. Since #793 it needs no echo of the
 * Word of the Day either: that writer is a patch, so the payload is what
 * `wordOfTheDayPatch` found the officer had changed and nothing else. It used to
 * submit all three on every save, off a page-load snapshot, because the writer
 * nulled what it was not given — and a field reappearing on this payload
 * unconditionally is that lost update returning.
 */
export function PersonalWordEditor(props: EditorProps) {
	const { viewer, when, backHref } = useEditorContext(props);
	const { saving, run } = useDutySave(props.onSaved);
	// FROZEN at mount, deliberately: the diff below must be against what the
	// inputs were seeded with, not against whatever `props.meeting` says by the
	// time Save is pressed. Reading the live prop would make a field the officer
	// never touched look edited the moment the loader refreshed under them.
	const [seed] = useState<WordOfTheDayDraft>(() => ({
		word: props.meeting.wordOfTheDay ?? "",
		definition: props.meeting.wodDefinition ?? "",
		example: props.meeting.wodExample ?? "",
	}));
	const [word, setWord] = useState(seed.word);
	const [definition, setDefinition] = useState(seed.definition);
	const [example, setExample] = useState(seed.example);

	const blocked = editorBlockedReason({
		status: props.meeting.status,
		canEdit: canEditWordOfTheDay(viewer),
		roleMessage:
			"Only this meeting's Grammarian or Toastmaster — or a club officer — can set the Word of the Day.",
	});
	if (blocked) {
		return (
			<BlockedCard
				title={WORD_TITLE}
				when={when}
				backHref={backHref}
				reason={blocked}
			/>
		);
	}

	return (
		<EditorCard
			title={WORD_TITLE}
			blurb={WORD_BLURB}
			when={when}
			backHref={backHref}
		>
			<form
				className="space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					void run(
						() =>
							updateWordOfTheDay({
								data: {
									meetingId: props.meeting.id,
									selfMemberId: props.memberId,
									// ONLY what the officer edited (#793). Spread, so an
									// untouched field is an ABSENT KEY rather than a key holding
									// `undefined` — the payload then says on the wire what the
									// contract says, and naming one of these three columns here
									// unconditionally is the snapshot echo coming back.
									...wordOfTheDayPatch(seed, { word, definition, example }),
								},
							}),
						"Word of the day saved.",
					);
				}}
			>
				<div className="space-y-2">
					<Label htmlFor="wordOfTheDay">Word</Label>
					<Input
						id="wordOfTheDay"
						name="wordOfTheDay"
						value={word}
						maxLength={WOD_LIMITS.word}
						placeholder="e.g. ineffable"
						onChange={(e) => setWord(e.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="wodDefinition">Definition</Label>
					<Textarea
						id="wodDefinition"
						name="wodDefinition"
						rows={2}
						value={definition}
						maxLength={WOD_LIMITS.definition}
						onChange={(e) => setDefinition(e.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="wodExample">Example sentence</Label>
					<Textarea
						id="wodExample"
						name="wodExample"
						rows={2}
						value={example}
						maxLength={WOD_LIMITS.example}
						onChange={(e) => setExample(e.target.value)}
					/>
				</div>
				<Button type="submit" size="lg" className="w-full" disabled={saving}>
					{saving ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save word of the day"
					)}
				</Button>
			</form>
		</EditorCard>
	);
}
