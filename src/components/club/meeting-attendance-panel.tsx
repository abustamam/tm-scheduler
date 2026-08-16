import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	buildPlanPanel,
	type PanelMember,
	type PlanStatus,
} from "#/lib/attendance-panel";

/** Chip copy. "No answer" is the ABSENCE of a row, so choosing it clears. */
const RUNG_LABELS: Record<PlanStatus, string> = {
	reached_out: "Asked",
	coming: "Coming",
	not_coming: "Not coming",
};

const MENU: { label: string; status: PlanStatus | null }[] = [
	{ label: "No answer", status: null },
	{ label: "Asked", status: "reached_out" },
	{ label: "Coming", status: "coming" },
	{ label: "Not coming", status: "not_coming" },
];

/** Tailwind's `lg` breakpoint (`min-width: 1024px`) — kept as one literal so the
 *  CSS class below and the JS desktop check can't drift apart. */
const LG_BREAKPOINT_PX = 1024;

function AttendanceRow({
	m,
	locked,
	meetingDate,
	shareUrl,
	pending,
	onWriteRung,
	onContacted,
}: {
	m: PanelMember;
	locked: boolean;
	meetingDate: string;
	shareUrl: string;
	pending: boolean;
	onWriteRung: (memberId: string, next: PlanStatus | null) => void;
	onContacted: (memberId: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 py-1.5">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-sm">{m.name}</span>
					{m.roleName ? <Badge variant="secondary">{m.roleName}</Badge> : null}
				</div>
				<NudgeButtons
					mode="attendance"
					name={m.name}
					preferredName={m.preferredName}
					phone={m.phone}
					email={m.email}
					meetingDate={meetingDate}
					shareUrl={shareUrl}
					onContacted={() => onContacted(m.id)}
				/>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						disabled={locked || pending}
						aria-label={`${m.name} status`}
					>
						{m.status ? RUNG_LABELS[m.status] : "—"}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{MENU.map((item) => (
						<DropdownMenuItem
							key={item.label}
							onSelect={() => onWriteRung(m.id, item.status)}
						>
							{item.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/**
 * Officer's planned-attendance panel, plan mode (spec D2-D4). Lists every
 * active member with where the outreach got to (no answer → asked → coming →
 * not coming) and lets the officer set a rung or message them. Presentational:
 * every write leaves as a callback, no server fn, no fetch, no server state.
 */
export function MeetingAttendancePanel({
	roster,
	plan,
	rungOverride,
	roleByMemberId,
	meetingDate,
	shareUrl,
	locked,
	onWriteRung,
	onContacted,
}: {
	roster: Omit<PanelMember, "status" | "roleName">[];
	plan: { memberId: string; status: PlanStatus }[];
	/** Optimistic overrides from the route, keyed by member. A key present with
	 *  value `null` means "optimistically cleared" — distinct from absent,
	 *  which means "no override". */
	rungOverride: Readonly<Record<string, PlanStatus | null>>;
	roleByMemberId: Readonly<Record<string, string>>;
	meetingDate: string;
	shareUrl: string;
	locked: boolean;
	/** One writer for both directions; `null` clears. Two callbacks made the
	 *  clear path a separate thing to remember at every call site. */
	onWriteRung: (
		memberId: string,
		next: PlanStatus | null,
	) => void | Promise<void>;
	onContacted: (memberId: string) => void | Promise<void>;
}) {
	// Per-row in-flight state, lifted from OutreachPanel: a BUSY guard against a
	// rapid double-tap, not the source of the displayed value — that comes from
	// `rungOverride`, which the route owns.
	const [pendingId, setPendingId] = useState<string | null>(null);

	// Mobile collapse (spec D4): below `lg` the panel starts collapsed to its
	// counts line so a big roster does not push the agenda off screen; at `lg`
	// and up it is always shown. `mounted` keeps the server render (no
	// `window`) and the client's first render in agreement — same guard
	// `NudgeButtons` uses, for the same reason: computing `isDesktop` before
	// hydration would make the two disagree and React would have to reconcile
	// a mismatch.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const isDesktop = mounted && window.innerWidth >= LG_BREAKPOINT_PX;
	const [expanded, setExpanded] = useState(false);
	const showRows = expanded || isDesktop;

	// Apply the override BEFORE calling buildPlanPanel, so the sort and the
	// counts reflect the optimistic state too — otherwise a chip jumps to a new
	// bucket a beat after it is tapped, and the counts line disagrees with the
	// chips. `!== undefined` (not `??`) because a key present with value `null`
	// means "optimistically cleared", distinct from the key being absent.
	const effectivePlan = roster
		.map((m) => ({
			memberId: m.id,
			status:
				rungOverride[m.id] !== undefined
					? rungOverride[m.id]
					: (plan.find((p) => p.memberId === m.id)?.status ?? null),
		}))
		.filter(
			(p): p is { memberId: string; status: PlanStatus } => p.status !== null,
		);

	const { rows, countsLine } = buildPlanPanel({
		roster,
		plan: effectivePlan,
		roleByMemberId,
	});

	async function writeRung(memberId: string, next: PlanStatus | null) {
		setPendingId(memberId);
		try {
			await onWriteRung(memberId, next);
		} finally {
			setPendingId(null);
		}
	}

	async function contacted(memberId: string) {
		setPendingId(memberId);
		try {
			await onContacted(memberId);
		} finally {
			setPendingId(null);
		}
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<CardTitle>Planned attendance</CardTitle>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							{countsLine}
						</span>
					</div>
					{/* Toggle only makes sense below `lg` — at `lg` and up the roster is
					 *  always shown, so the button is CSS-hidden there rather than
					 *  removed, since it is still a single DOM node either way. */}
					<Button
						variant="ghost"
						size="sm"
						className="lg:hidden"
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? (
							<>
								Hide
								<ChevronUp className="size-4" aria-hidden />
							</>
						) : (
							<>
								Show
								<ChevronDown className="size-4" aria-hidden />
							</>
						)}
					</Button>
				</div>
			</CardHeader>
			{/* The rows are absent from the DOM entirely when collapsed — not
			 *  merely CSS-hidden, which would still expose every member's name to a
			 *  screen reader (and make the collapse untestable). */}
			{showRows ? (
				<CardContent>
					{rows.map((m) => (
						<AttendanceRow
							key={m.id}
							m={m}
							locked={locked}
							meetingDate={meetingDate}
							shareUrl={shareUrl}
							pending={pendingId === m.id}
							onWriteRung={writeRung}
							onContacted={contacted}
						/>
					))}
				</CardContent>
			) : null}
		</Card>
	);
}
