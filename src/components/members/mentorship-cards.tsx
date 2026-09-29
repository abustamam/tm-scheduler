import { Link } from "@tanstack/react-router";
import { HeartHandshake, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { MemberContactLinks } from "#/components/members/member-contact-links";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	MENTORSHIP_FOCUS_LABELS,
	MENTORSHIP_FOCUS_OTHER_MAX,
	MENTORSHIP_FOCUSES,
	type MentorshipFocus,
	mentorshipFocusText,
} from "#/lib/mentorship";
import type {
	ClubMentorships,
	MemberMentorships,
	MentorshipRow,
	MyMentorships,
} from "#/server/mentorship";

/**
 * Mentorship (#939): member-to-member pairings inside one club.
 *
 * Every label here says "mentor", "mentee" or "mentoring", never "club
 * mentor": that is the charter helper (#1043), a different thing assigned to
 * a chartering club, and no copy here may read as it.
 *
 * All three components are presentational and controlled: the routes own the
 * server calls and pass the payloads down.
 */

export const MENTORING_HEADING = "Mentoring";
export const WILLING_TO_MENTOR_LABEL = "I'm willing to mentor another member";
export const YOUR_MENTORS_HEADING = "Your mentors";
export const YOUR_MENTEES_HEADING = "Your mentees";
export const MEMBER_MENTORING_HEADING = "Member mentoring";
export const MENTORSHIP_ADMIN_HEADING = "Mentorship";

/** The server's payload shapes, under the names the components use. */
export type MentorshipPartyRow = MentorshipRow;
export type MyMentorshipsView = MyMentorships;
export type MemberMentorshipsView = MemberMentorships;
export type ClubMentoringView = ClubMentorships;

const CARD =
	"overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]";

const SELECT =
	"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/** Name, focus and how to reach them. */
function PartyLine({ row }: { row: MentorshipPartyRow }) {
	const focus = mentorshipFocusText(row.focus, row.focusOther);
	return (
		<li
			data-mentorship={row.id}
			className="border-t border-[var(--line)] px-5 py-3"
		>
			<div className="text-sm font-bold text-[var(--sea-ink)]">
				{row.member.name}
				{focus ? (
					<span className="ml-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
						{focus}
					</span>
				) : null}
			</div>
			{row.member.email || row.member.phone ? (
				<div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
					<MemberContactLinks
						name={row.member.name}
						email={row.member.email}
						phone={row.member.phone}
					/>
				</div>
			) : (
				<div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
					No contact on file.
				</div>
			)}
		</li>
	);
}

/**
 * The member's own mentoring card on the dashboard: their "willing to mentor"
 * flag, their active mentors and their active mentees. Ended pairings never
 * reach it (the read returns active ones only).
 */
export function MentorshipCard({
	view,
	onToggleWilling,
}: {
	view: MyMentorshipsView | null;
	onToggleWilling: (willing: boolean) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const checkboxId = useId();
	if (!view) return null;

	async function toggle(next: boolean) {
		setBusy(true);
		try {
			await onToggleWilling(next);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section aria-labelledby={`${checkboxId}-heading`} className={CARD}>
			<div className="flex items-center gap-2 px-5 pt-4 pb-2.5">
				<HeartHandshake
					className="size-4 text-[var(--lagoon-deep)]"
					aria-hidden
				/>
				<h2 id={`${checkboxId}-heading`} className="text-sm font-bold">
					{MENTORING_HEADING}
				</h2>
			</div>
			{view.mentors.length > 0 ? (
				<>
					<h3 className="px-5 pb-1 text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)] uppercase">
						{YOUR_MENTORS_HEADING}
					</h3>
					<ul className="m-0 list-none p-0" data-list="mentors">
						{view.mentors.map((r) => (
							<PartyLine key={r.id} row={r} />
						))}
					</ul>
				</>
			) : null}
			{view.mentees.length > 0 ? (
				<>
					<h3 className="px-5 pt-2 pb-1 text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)] uppercase">
						{YOUR_MENTEES_HEADING}
					</h3>
					<ul className="m-0 list-none p-0" data-list="mentees">
						{view.mentees.map((r) => (
							<PartyLine key={r.id} row={r} />
						))}
					</ul>
				</>
			) : null}
			<div className="flex items-start gap-2.5 border-t border-[var(--line)] px-5 py-3">
				<input
					type="checkbox"
					id={checkboxId}
					checked={view.willingToMentor}
					disabled={busy}
					onChange={(e) => void toggle(e.currentTarget.checked)}
					className="mt-0.5 size-4 shrink-0 accent-[var(--lagoon-deep)]"
				/>
				<div className="leading-[1.3]">
					<label htmlFor={checkboxId} className="text-sm font-semibold">
						{WILLING_TO_MENTOR_LABEL}
					</label>
					<div className="text-xs text-[var(--sea-ink-soft)]">
						Your VP Education sees who is available when pairing members.
					</div>
				</div>
			</div>
		</section>
	);
}

function MemberLink({ id, name }: { id: string; name: string }) {
	return (
		<Link to="/members/$id" params={{ id }} className="font-semibold">
			{name}
		</Link>
	);
}

/**
 * The admin's club-wide list (dashboard): every active pairing, the active
 * members with no active mentor (new members first), and who is willing.
 */
export function ClubMentoringCard({
	view,
}: {
	view: ClubMentoringView | null;
}) {
	if (!view) return null;
	const unpaired = [...view.unpaired].sort(
		(a, b) => Number(b.inOrientation) - Number(a.inOrientation),
	);
	return (
		<section aria-labelledby="member-mentoring-heading" className={CARD}>
			<div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2.5">
				<h2 id="member-mentoring-heading" className="text-sm font-bold">
					{MEMBER_MENTORING_HEADING}
				</h2>
				<span className="text-xs text-[var(--sea-ink-soft)]">
					{view.active.length} active
				</span>
			</div>
			{view.active.length === 0 ? (
				<p className="border-t border-[var(--line)] px-5 py-3 text-xs text-[var(--sea-ink-soft)]">
					No active pairings. Pair a member with a mentor from their member
					page.
				</p>
			) : (
				<ul className="m-0 list-none p-0" data-list="active-pairings">
					{view.active.map((p) => {
						const focus = mentorshipFocusText(p.focus, p.focusOther);
						return (
							<li
								key={p.id}
								className="border-t border-[var(--line)] px-5 py-2.5 text-sm"
							>
								<MemberLink {...p.mentee} />
								<span className="text-[var(--sea-ink-soft)]">
									{" "}
									mentored by{" "}
								</span>
								<MemberLink {...p.mentor} />
								{focus ? (
									<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
										{focus}
									</span>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
			<div className="border-t border-[var(--line)] px-5 py-3">
				<h3 className="mb-1 text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)] uppercase">
					No mentor yet ({unpaired.length})
				</h3>
				{unpaired.length === 0 ? (
					<p className="text-xs text-[var(--sea-ink-soft)]">
						Every active member has a mentor.
					</p>
				) : (
					<ul
						className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-sm"
						data-list="unpaired"
					>
						{unpaired.map((m) => (
							<li key={m.id}>
								<MemberLink {...m} />
								{m.inOrientation ? (
									<span className="ml-1 text-xs text-[var(--sea-ink-soft)]">
										(new)
									</span>
								) : null}
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="border-t border-[var(--line)] px-5 py-3">
				<h3 className="mb-1 text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)] uppercase">
					Willing to mentor ({view.willing.length})
				</h3>
				{view.willing.length === 0 ? (
					<p className="text-xs text-[var(--sea-ink-soft)]">
						Nobody has said so yet. Members tick it on their dashboard.
					</p>
				) : (
					<ul
						className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-sm"
						data-list="willing"
					>
						{view.willing.map((m) => (
							<li key={m.id}>
								<MemberLink {...m} />
							</li>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}

export interface NewPairing {
	mentorMemberId: string;
	focus: MentorshipFocus | null;
	focusOther: string | null;
}

/** "" in a focus `<select>` is "no focus". */
function parseFocus(value: string): MentorshipFocus | null {
	return (MENTORSHIP_FOCUSES as readonly string[]).includes(value)
		? (value as MentorshipFocus)
		: null;
}

function FocusSelect({
	id,
	value,
	onChange,
	disabled,
}: {
	id: string;
	value: MentorshipFocus | null;
	onChange: (f: MentorshipFocus | null) => void;
	disabled?: boolean;
}) {
	return (
		<select
			id={id}
			className={SELECT}
			value={value ?? ""}
			disabled={disabled}
			onChange={(e) => onChange(parseFocus(e.target.value))}
		>
			<option value="">No particular focus</option>
			{MENTORSHIP_FOCUSES.map((f) => (
				<option key={f} value={f}>
					{MENTORSHIP_FOCUS_LABELS[f]}
				</option>
			))}
		</select>
	);
}

/** One active pairing on the admin panel: focus change and End. */
function AdminPairingRow({
	row,
	side,
	onEnd,
	onFocus,
}: {
	row: MentorshipPartyRow;
	side: "mentor" | "mentee";
	onEnd: (id: string) => Promise<void>;
	onFocus: (
		id: string,
		focus: MentorshipFocus | null,
		focusOther: string | null,
	) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const selectId = useId();
	async function run(fn: () => Promise<void>) {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
		}
	}
	return (
		<li
			data-mentorship={row.id}
			className="flex flex-col gap-1.5 border-t border-[var(--line)] py-2.5"
		>
			<div className="flex items-center justify-between gap-2 text-sm">
				<span>
					<span className="text-xs text-[var(--sea-ink-soft)]">
						{side === "mentor" ? "Mentor: " : "Mentee: "}
					</span>
					<MemberLink id={row.member.id} name={row.member.name} />
				</span>
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => run(() => onEnd(row.id))}
				>
					End
				</Button>
			</div>
			<label htmlFor={selectId} className="sr-only">
				Focus for {row.member.name}
			</label>
			<FocusSelect
				id={selectId}
				value={row.focus}
				disabled={busy}
				onChange={(f) =>
					run(() => onFocus(row.id, f, f === "other" ? row.focusOther : null))
				}
			/>
		</li>
	);
}

/**
 * The admin's mentorship panel on a member's page: this member's active
 * mentors and mentees (focus change, End), and "Add a mentor" with a picker
 * that lists members who are willing to mentor first. The server gates every
 * write with `requireClubRole(…, ["admin"])`.
 */
export function MentorshipAdminPanel({
	memberName,
	memberActive,
	view,
	onAdd,
	onEnd,
	onFocus,
}: {
	memberName: string;
	memberActive: boolean;
	view: MemberMentorshipsView;
	onAdd: (pairing: NewPairing) => Promise<void>;
	onEnd: (id: string) => Promise<void>;
	onFocus: (
		id: string,
		focus: MentorshipFocus | null,
		focusOther: string | null,
	) => Promise<void>;
}) {
	const ids = useId();
	const [mentorId, setMentorId] = useState("");
	const [focus, setFocus] = useState<MentorshipFocus | null>("new_member");
	const [focusOther, setFocusOther] = useState("");
	const [busy, setBusy] = useState(false);

	async function add() {
		if (!mentorId) return;
		setBusy(true);
		try {
			await onAdd({
				mentorMemberId: mentorId,
				focus,
				focusOther: focus === "other" ? focusOther.trim() || null : null,
			});
			setMentorId("");
			setFocusOther("");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
			<h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
				<HeartHandshake
					className="size-4 text-[var(--sea-ink-soft)]"
					aria-hidden
				/>
				{MENTORSHIP_ADMIN_HEADING}
			</h2>
			{view.willingToMentor ? (
				<p className="mb-2 text-xs text-[var(--sea-ink-soft)]">
					{memberName} is willing to mentor.
				</p>
			) : null}
			{view.mentors.length + view.mentees.length === 0 ? (
				<p className="mb-2 text-xs text-[var(--sea-ink-soft)]">
					No active pairings.
				</p>
			) : (
				<ul className="m-0 mb-2 list-none p-0" data-list="admin-pairings">
					{view.mentors.map((r) => (
						<AdminPairingRow
							key={r.id}
							row={r}
							side="mentor"
							onEnd={onEnd}
							onFocus={onFocus}
						/>
					))}
					{view.mentees.map((r) => (
						<AdminPairingRow
							key={r.id}
							row={r}
							side="mentee"
							onEnd={onEnd}
							onFocus={onFocus}
						/>
					))}
				</ul>
			)}
			{memberActive ? (
				<div className="flex flex-col gap-2 border-t border-[var(--line)] pt-3">
					<Label htmlFor={`${ids}-mentor`}>Add a mentor</Label>
					<select
						id={`${ids}-mentor`}
						className={SELECT}
						value={mentorId}
						disabled={busy}
						onChange={(e) => setMentorId(e.target.value)}
					>
						<option value="">Choose a member…</option>
						{view.candidates.map((c) => (
							<option key={c.id} value={c.id}>
								{c.willingToMentor ? `${c.name} (willing)` : c.name}
							</option>
						))}
					</select>
					<Label htmlFor={`${ids}-focus`}>Focus</Label>
					<FocusSelect
						id={`${ids}-focus`}
						value={focus}
						disabled={busy}
						onChange={setFocus}
					/>
					{focus === "other" ? (
						<Input
							aria-label="Describe the focus"
							placeholder="What will they work on?"
							maxLength={MENTORSHIP_FOCUS_OTHER_MAX}
							value={focusOther}
							disabled={busy}
							onChange={(e) => setFocusOther(e.target.value)}
						/>
					) : null}
					<Button
						size="sm"
						variant="outline"
						disabled={busy || !mentorId}
						onClick={add}
					>
						{busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
						Pair with mentor
					</Button>
				</div>
			) : (
				<p className="text-xs text-[var(--sea-ink-soft)]">
					Reactivate {memberName} to pair them with a mentor.
				</p>
			)}
		</div>
	);
}
