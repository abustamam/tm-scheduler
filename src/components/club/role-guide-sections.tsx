// src/components/club/role-guide-sections.tsx
//
// A role's "before and during the meeting" guide (#933), in the two places it
// is read: the public roles guide (`club.$clubId.roles-guide.tsx`), where both
// halves are open reference text, and the member's own meeting page
// (`personal-meeting-body.tsx`), where the half that matters TODAY is the one
// expanded.
//
// Informational only. Nothing here is a checkbox: the three verifiable duties
// stay in `role-duties.ts`, and the personal page renders them first.
//
// A half the club has left blank renders NOTHING — no header over an empty
// box. A role with neither half falls back to its description, and only where
// the surface is not already showing it (`showDescriptionFallback`).
import { ChevronRight, FileText } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import {
	hasGuideText,
	type RoleGuide,
	type RoleGuideSource,
	roleGuide,
	roleGuideAnchor,
	roleSheetForKey,
	staticRoleSheetHref,
} from "#/lib/role-guide";

export interface RoleGuideSheetLink {
	href: string;
	/** The sheet's own title, for the accessible name. */
	title: string;
}

/**
 * Which halves start expanded on the personal page (#933 decision 4). Before
 * the meeting day, "Before"; on the day, "During"; after it — or for a
 * cancelled meeting, where there is nothing left to prepare or run — neither.
 * Takes the page's own `meetingPhase`, never a clock of its own.
 */
export function guideOpenState(
	phase: MeetingPhase,
	cancelled = false,
): { before: boolean; during: boolean } {
	if (cancelled || phase === "completed") {
		return { before: false, during: false };
	}
	return phase === "today"
		? { before: false, during: true }
		: { before: true, during: false };
}

/** One step per line, as the admin form asks. A single line is a paragraph. */
function GuideText({ text }: { text: string }) {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		return <p className="text-sm text-muted-foreground">{lines[0] ?? text}</p>;
	}
	return (
		<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
			{lines.map((line, i) => (
				// Lines are free text and may repeat; position is the identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
				<li key={i}>{line}</li>
			))}
		</ul>
	);
}

function SheetLink({ sheet }: { sheet: RoleGuideSheetLink }) {
	return (
		<a
			href={sheet.href}
			className="-mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary"
			aria-label={`Full script (PDF): ${sheet.title}`}
		>
			<FileText aria-hidden className="size-4" />
			Full script (PDF)
		</a>
	);
}

/** A collapsible half. Native `<details>`: keyboard and screen-reader
 *  behaviour for free, and it still opens with JavaScript off. */
function Collapsible({
	label,
	initiallyOpen,
	children,
}: {
	label: string;
	initiallyOpen: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<details
			open={open}
			onToggle={(e) => setOpen(e.currentTarget.open)}
			className="group"
		>
			<summary className="-mx-2 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
				<ChevronRight
					aria-hidden
					className="size-4 shrink-0 transition-transform group-open:rotate-90"
				/>
				{label}
			</summary>
			<div className="space-y-2 pb-1 pl-6">{children}</div>
		</details>
	);
}

/** A static half, for the reference page: a heading and its text. */
function Static({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<h4 className="text-xs font-semibold tracking-[0.04em] text-foreground uppercase">
				{label}
			</h4>
			{children}
		</div>
	);
}

export function RoleGuideSections({
	guide,
	sheet,
	open,
	showDescriptionFallback,
	className = "",
}: {
	guide: RoleGuide;
	/** The role's printed sheet, when it has one — ends the During half. */
	sheet?: RoleGuideSheetLink | null;
	/** Collapsible halves with these starting states, or omitted for the
	 *  always-open reference layout. */
	open?: { before: boolean; during: boolean };
	/** Render `description` when the role has no guide text. False where the
	 *  surface already prints the description above. */
	showDescriptionFallback: boolean;
	/** Extra classes for the root, which is absent when nothing renders. */
	className?: string;
}) {
	// Collapsible on the personal page, static headings on the reference page.
	const half = (label: string, initiallyOpen: boolean, body: ReactNode) =>
		open ? (
			<Collapsible label={label} initiallyOpen={initiallyOpen}>
				{body}
			</Collapsible>
		) : (
			<Static label={label}>{body}</Static>
		);
	if (!hasGuideText(guide)) {
		// No empty headers: the description (if wanted and present) and the
		// sheet, or nothing at all.
		if (!(showDescriptionFallback && guide.description) && !sheet) return null;
		return (
			<div className={`space-y-1 ${className}`}>
				{showDescriptionFallback && guide.description ? (
					<p className="text-sm text-muted-foreground">{guide.description}</p>
				) : null}
				{sheet ? <SheetLink sheet={sheet} /> : null}
			</div>
		);
	}
	return (
		<div className={`space-y-1 ${className}`}>
			{guide.before
				? half(
						"Before the meeting",
						open?.before ?? true,
						<GuideText text={guide.before} />,
					)
				: null}
			{guide.during
				? half(
						"During the meeting",
						open?.during ?? true,
						<>
							<GuideText text={guide.during} />
							{sheet ? <SheetLink sheet={sheet} /> : null}
						</>,
					)
				: null}
			{/* A sheet with no During half still gets its link, after the guide. */}
			{sheet && !guide.during ? <SheetLink sheet={sheet} /> : null}
		</div>
	);
}

/**
 * One role's card on the public roles guide (`club.$clubId.roles-guide.tsx`).
 * Lives here, not in the route, so it can be mounted in a test.
 *
 * `id` is the role's anchor (`roleGuideAnchor(key)`) — the fragment the guest
 * `confirm` draft links to; a key-less role has none. The description stays
 * where it always was, the guide follows with both halves open (reference
 * reading, not the room), and the sheet is the BLANK public copy: a guest
 * here has no particular meeting to fill one in for.
 */
export function RoleGuideItem({
	role,
}: {
	role: RoleGuideSource & { id: string };
}) {
	const sheet = roleSheetForKey(role.key);
	const anchor = role.key ? roleGuideAnchor(role.key) : "";
	return (
		<li id={anchor || undefined} className="scroll-mt-20 space-y-2 p-4">
			<div>
				<h3 className="font-medium text-foreground text-sm">{role.name}</h3>
				{role.description ? (
					<p className="mt-1 text-sm text-muted-foreground">
						{role.description}
					</p>
				) : null}
			</div>
			<RoleGuideSections
				guide={roleGuide(role)}
				sheet={
					sheet
						? { href: staticRoleSheetHref(sheet), title: sheet.title }
						: null
				}
				showDescriptionFallback={false}
			/>
		</li>
	);
}
