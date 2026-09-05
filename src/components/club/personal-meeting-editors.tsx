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
import { utcToZonedWallTime } from "#/lib/datetime";
import { formatMeetingDate } from "#/lib/format";
import { isMeetingLocked, resolveMeetingViewer } from "#/lib/meeting-lifecycle";
import { MEETING_LIMITS } from "#/lib/meeting-limits";
import {
	type MeetingMetaEcho,
	themeOnlyUpdate,
} from "#/lib/meeting-meta-update";
import { deriveMeetingRoleFlags } from "#/lib/meeting-roles";
import { canEditWordOfTheDay } from "#/lib/meeting-viewer";
import { personalMeetingHref } from "#/lib/role-duties";
import { WOD_LIMITS } from "#/lib/wod-limits";
import { updateMeeting, updateWordOfTheDay } from "#/server/meetings";

/** The meeting fields both editors read. A structural subset of the meeting row
 *  the shared loaders return, so a route hands its `meeting` straight over. */
export interface EditorMeeting extends MeetingMetaEcho {
	/** The RESOLVED uuid. Both writers validate `z.string().uuid()`, so the
	 *  `$meetingId` URL segment (a club-local date key) would be rejected at the
	 *  write, after the page had already rendered fine. */
	id: string;
	/** `Date` during SSR, string after hydration — the union is the honest type
	 *  for anything that crossed a server fn. */
	scheduledAt: Date | string;
	status: string;
	theme: string | null;
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
	/** The club's timezone, for the date line and the wall-time echo. */
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
 * Writes through `updateMeeting`, which is a full REPLACE — see
 * `#/lib/meeting-meta-update`. `themeOnlyUpdate` is what stops a one-field save
 * from nulling the club's location, Word of the Day, announcements and notes,
 * and it is not optional decoration: without it this component is a data-loss
 * bug that reports success.
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
								data: themeOnlyUpdate({
									meetingId: props.meeting.id,
									// Null for a signed-in admin: the server resolves them
									// through the session, and asserting a member id they may
									// not hold would be the forgeable input #396 removed.
									selfMemberId: props.isSignedIn ? null : props.memberId,
									// The meeting's CURRENT wall time, resubmitted unchanged.
									// A self-serve TMOD carries `canReschedule = false` and any
									// actual move is rejected — see ADR-0010.
									scheduledAt: utcToZonedWallTime(
										new Date(props.meeting.scheduledAt),
										props.timezone,
									),
									theme,
									current: props.meeting,
								}),
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

/**
 * The Grammarian's focused Word-of-the-Day editor.
 *
 * Writes through `updateWordOfTheDay`, which touches the three WOD columns and
 * physically cannot reach any other meta — so unlike the theme editor above it
 * needs no echo of the rest of the meeting. It still submits all THREE fields
 * every time, because that writer nulls what it is not given: saving a word
 * without carrying the definition back would clear the definition.
 */
export function PersonalWordEditor(props: EditorProps) {
	const { viewer, when, backHref } = useEditorContext(props);
	const { saving, run } = useDutySave(props.onSaved);
	const [word, setWord] = useState(props.meeting.wordOfTheDay ?? "");
	const [definition, setDefinition] = useState(
		props.meeting.wodDefinition ?? "",
	);
	const [example, setExample] = useState(props.meeting.wodExample ?? "");

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
									selfMemberId: props.isSignedIn ? null : props.memberId,
									// Blank → undefined, which the writer stores as null. All
									// three travel on every save; see the component docblock.
									wordOfTheDay: word.trim() || undefined,
									wodDefinition: definition.trim() || undefined,
									wodExample: example.trim() || undefined,
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
