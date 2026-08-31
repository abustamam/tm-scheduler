// src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx
//
// The per-meeting agenda editor (#agenda-templates Phase 2, Task 9).
//
// `$meetingId_` (trailing underscore) deliberately keeps this OUT from under
// `club.$clubId.meeting.$meetingId.tsx` — that giant meeting page renders no
// `<Outlet />`, so nesting under it the plain way (`club.$clubId.meeting.
// $meetingId.agenda.tsx`, confirmed by generating the route tree with that
// name) would make this page's content unreachable: the router would match
// both routes and render the parent's full leaf UI with nowhere for this
// component to appear. The underscore keeps the URL identical
// (`/club/$clubId/meeting/$meetingId/agenda`) while parenting this route
// directly on the club shell (`club.$clubId.tsx`) instead — the same shape
// `club.$clubId.roles-guide.tsx` uses for an in-chrome standalone page.
//
// `$meetingId` here is always the meeting's raw uuid, not a club-local-date
// KEY: `getAgendaDraft` (and every other Task 6-8 server fn) takes a bare
// uuid, and the "Edit agenda" button below wires `meetingId: meeting.id`, not
// a key. `resolveMeetingKey` also accepts a raw uuid, so a redirect back to
// the canonical meeting route with the same value still resolves correctly.
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { AgendaEditor } from "#/components/agenda/agenda-editor";
import { BackLink } from "#/components/back-link";
import {
	addAgendaRoleFn,
	addAgendaRowFn,
	getAgendaDraft,
	moveAgendaRowFn,
	planRoleRemovalFn,
	removeAgendaRoleFn,
	removeAgendaRowFn,
	updateAgendaRowFn,
} from "#/server/meeting-agenda-edit";

export const Route = createFileRoute(
	"/club/$clubId/meeting/$meetingId_/agenda",
)({
	loader: async ({ params }) => {
		const draft = await getAgendaDraft({
			data: { meetingId: params.meetingId },
		});
		// Null now means the meeting does not exist. It used to mean STANDARD —
		// no template, nothing for this editor to edit — but since #622 a
		// standard meeting is materialized into its own copy on first load, so
		// that case returns a normal draft like any other. The redirect stays as
		// the not-found path.
		if (!draft) {
			throw redirect({
				to: "/club/$clubId/meeting/$meetingId",
				params: { clubId: params.clubId, meetingId: params.meetingId },
			});
		}
		return draft;
	},
	component: AgendaEditorRoute,
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? `Edit agenda — ${loaderData.templateName}`
					: "Edit agenda",
			},
		],
	}),
});

function AgendaEditorRoute() {
	// The loader's own return value, not a re-derived one — the wiring guard
	// pins this so a future edit can't quietly swap in a second fetch that
	// disagrees with what `router.invalidate()` just refreshed.
	const draft = Route.useLoaderData();
	const { clubId, meetingId } = Route.useParams();
	const router = useRouter();

	async function refresh() {
		await router.invalidate();
	}

	return (
		<div className="mx-auto w-full max-w-reading space-y-6 p-4 pb-8 md:p-6">
			<div className="pt-2">
				<BackLink
					to="/club/$clubId/meeting/$meetingId"
					params={{ clubId, meetingId }}
				>
					Back to meeting
				</BackLink>
				<h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">
					Edit agenda
				</h1>
				<p className="text-muted-foreground text-sm">{draft.templateName}</p>
				{draft.templateName === "Standard meeting" ? (
					// Adoption is copy-once (spec D1/R1): 15 of the last 27 commits to the
					// run of show changed beat content, and an adopted club receives none
					// of them. Accepting that silently would be the invisible authoring
					// D1 rejects, so the trade is stated where it is made.
					<p className="mt-2 rounded-md border border-dashed p-3 text-muted-foreground text-sm">
						<strong className="font-medium">This agenda is now yours.</strong>{" "}
						Improvements we make to the standard agenda will not reach it — edit
						it here instead.
					</p>
				) : null}
			</div>

			<AgendaEditor
				draft={draft}
				onAddRow={async (afterRowId, kind) => {
					// The created row is RETURNED, not discarded: undo restores a
					// deleted row by adding one and patching its fields onto it, and
					// without the new id that needs a re-read to find.
					const created = await addAgendaRowFn({
						data: { meetingId, afterRowId, kind },
					});
					await refresh();
					return created;
				}}
				onUpdateRow={async (rowId, patch) => {
					// NO refresh. A pure edit's server answer is the value just sent, so
					// re-fetching the route to learn it is waste — and re-timing ten rows
					// would mean ten full route reloads, which is the cost this redesign
					// exists to remove. The editor holds the typed value locally and
					// `reseed()` restores the server's on a rejection.
					await updateAgendaRowFn({ data: { meetingId, rowId, patch } });
				}}
				onRemoveRow={async (rowId) => {
					await removeAgendaRowFn({ data: { meetingId, rowId } });
					await refresh();
				}}
				onMoveRow={async (rowId, direction) => {
					await moveAgendaRowFn({ data: { meetingId, rowId, direction } });
					await refresh();
				}}
				// Undo restores a deleted row with an add THEN an update, and only
				// the add invalidates. The editor calls this once the fields are
				// back on the server, so the row stops reading "New item".
				onRefresh={refresh}
				onAddRole={async (role) => {
					await addAgendaRoleFn({ data: { meetingId, ...role } });
					await refresh();
				}}
				planRoleRemoval={(roleKey) =>
					planRoleRemovalFn({ data: { meetingId, roleKey } })
				}
				onRemoveRole={async (roleKey) => {
					const released = await removeAgendaRoleFn({
						data: { meetingId, roleKey },
					});
					await refresh();
					return released;
				}}
			/>
		</div>
	);
}
