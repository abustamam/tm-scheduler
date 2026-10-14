import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageContainer } from "#/components/page-container";
import { MENTORS_MEMBERS_ONLY_MESSAGE } from "#/lib/mentorship";
import { listMentors, type MentorListing } from "#/server/mentorship";

const FIND_A_MENTOR_HEADING = "Find a mentor";
const NO_MENTORS_MESSAGE =
	"Nobody in your club has offered to mentor yet. Ask your VP Education.";
const NO_BIO_TEXT = "No bio yet";

/**
 * Find a mentor (#945): the club's members who said they are willing to
 * mentor, with the bio each wrote and how many people they mentor now. For
 * active members of the club only, never public (the route sits under
 * `_authed`, and `listMentors` refuses a caller with no membership of their own,
 * such as a read-only impersonation). No contact details here: the member page
 * already shows those to club members. Choosing a mentor comes with the request
 * flow (#1209).
 */
export const Route = createFileRoute("/_authed/mentors")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		if (!clubId) throw redirect({ to: "/dashboard" });
		try {
			return {
				mentors: await listMentors({ data: { clubId } }),
				refused: null as string | null,
			};
		} catch (err) {
			// The one refusal the page explains: the default error page never shows
			// a message. Anything else is a real failure and keeps that page.
			if (
				err instanceof Error &&
				err.message === MENTORS_MEMBERS_ONLY_MESSAGE
			) {
				return { mentors: [] as MentorListing[], refused: err.message };
			}
			throw err;
		}
	},
	component: MentorsPage,
});

/** "Mentoring 2 people now" / "Not mentoring anyone yet". */
function menteeCountText(n: number): string {
	if (n === 0) return "Not mentoring anyone yet";
	return `Mentoring ${n} ${n === 1 ? "person" : "people"} now`;
}

function MentorsPage() {
	const { mentors, refused } = Route.useLoaderData();
	return (
		<PageContainer className="space-y-5">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{FIND_A_MENTOR_HEADING}
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Members of your club who have offered to mentor.
				</p>
			</div>
			{refused ? (
				<p role="alert" className="text-sm">
					{refused}
				</p>
			) : mentors.length === 0 ? (
				<p className="text-sm text-[var(--sea-ink-soft)]">
					{NO_MENTORS_MESSAGE}
				</p>
			) : (
				<ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
					{mentors.map((m) => (
						<li
							key={m.memberId}
							data-mentor={m.memberId}
							className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-4"
						>
							<h2 className="text-base font-bold text-[var(--sea-ink)]">
								{m.name}
							</h2>
							<p
								className={
									m.mentorBio
										? "mt-1 text-sm whitespace-pre-wrap"
										: "mt-1 text-sm text-[var(--sea-ink-soft)]"
								}
							>
								{m.mentorBio ?? NO_BIO_TEXT}
							</p>
							<p className="mt-2 text-xs text-[var(--sea-ink-soft)]">
								{menteeCountText(m.activeMenteeCount)}
							</p>
						</li>
					))}
				</ul>
			)}
		</PageContainer>
	);
}
