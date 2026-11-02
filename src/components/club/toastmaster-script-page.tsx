// src/components/club/toastmaster-script-page.tsx
//
// The Toastmaster's script page body (#1480). The markup lives here and not in
// `club.$clubId.meeting.$meetingId_.me_.script.tsx` for the reason every other
// duty route's does: a route module imports `#/server/meetings` -> `#/db` and
// cannot be imported by a render test.
//
// It prints as a flowing page (no `FitPage`, no fixed sheet): a script is read
// aloud, and a long meeting may take more than one sheet.
import { Link } from "@tanstack/react-router";
import {
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "#/components/agenda/print-theme";
import type { ScriptLine } from "#/lib/toastmaster-script";

/** The fixed note a non-member sees, whether or not any introduction exists, so
 *  that the note does not reveal whether one does. */
export const MEMBERS_ONLY_INTRO_NOTE =
	"Members see each speaker's introduction.";

export function ToastmasterScriptPage({
	lines,
	when,
	clubName,
	theme,
	backHref,
	showMembersOnlyNote,
	signInRedirect,
}: {
	lines: ScriptLine[];
	/** The formatted meeting date. */
	when: string;
	clubName: string;
	theme: string | null;
	backHref: string;
	/** True when the viewer is not an active member (introductions withheld). */
	showMembersOnlyNote: boolean;
	/** Set only for a signed-out viewer: where "Sign in" returns to. */
	signInRedirect: string | null;
}) {
	return (
		<div>
			<PrintToolbar
				leading={
					<a href={backHref} className="text-sm underline">
						Back to your meeting page
					</a>
				}
			>
				<PrintButton />
			</PrintToolbar>
			<style>{PRINT_PAGE_CSS}</style>
			<main className="mx-auto w-full max-w-reading space-y-4 bg-background p-4 pb-10">
				<header className="space-y-1">
					<h1 className="font-semibold text-xl">Toastmaster's script</h1>
					<p className="text-muted-foreground text-sm">
						{clubName} · {when}
						{theme ? ` · Theme: ${theme}` : ""}
					</p>
				</header>
				{showMembersOnlyNote ? (
					<p className="rounded-md border border-border p-3 text-sm">
						{MEMBERS_ONLY_INTRO_NOTE}
						{signInRedirect ? (
							<>
								{" "}
								<Link to="/signin" search={{ redirect: signInRedirect }}>
									Sign in
								</Link>
							</>
						) : null}
					</p>
				) : null}
				<ol className="space-y-3">
					{lines.map((line, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: a built list with no ids, never reordered
							key={i}
							className="break-inside-avoid"
						>
							<Line line={line} />
						</li>
					))}
				</ol>
			</main>
		</div>
	);
}

function Time({ time, minutes }: { time: string; minutes: number }) {
	return (
		<span className="text-muted-foreground text-sm tabular-nums">
			{time}
			{minutes > 0 ? ` · ${minutes} min` : ""}
		</span>
	);
}

function Line({ line }: { line: ScriptLine }) {
	if (line.kind === "others") {
		return (
			<p className="text-muted-foreground text-sm">
				<Time time={line.time} minutes={0} /> {line.summary}
			</p>
		);
	}
	if (line.kind === "mine") {
		return (
			<div className="space-y-1">
				{line.backCue ? (
					<p className="text-muted-foreground text-sm">{line.backCue}</p>
				) : null}
				<p>
					<Time time={line.time} minutes={line.minutes} />{" "}
					<strong>{line.detail}</strong>
				</p>
			</div>
		);
	}
	return (
		<div className="space-y-2 rounded-lg border border-border p-3">
			<p>
				<Time time={line.time} minutes={line.minutes} />{" "}
				<strong>{line.speaker}</strong>
				{line.title ? ` · ${line.title}` : ""}
			</p>
			<blockquote className="border-primary border-l-4 pl-3">
				{line.say}
			</blockquote>
			{line.evaluatorAsk ? (
				<blockquote className="border-primary border-l-4 pl-3">
					{line.evaluatorAsk}
				</blockquote>
			) : null}
			{line.prepNote ? (
				<p className="text-muted-foreground text-sm">{line.prepNote}</p>
			) : null}
		</div>
	);
}
