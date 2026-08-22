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
import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AgendaEditor } from "#/components/agenda/agenda-editor";
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
		// Null means STANDARD (no template) — this editor has nothing to edit.
		// A shared-template meeting returns a normal draft (see
		// `loadAgendaDraft`'s docblock); this redirect is the standard-meeting
		// case only.
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
				<Link
					to="/club/$clubId/meeting/$meetingId"
					params={{ clubId, meetingId }}
					className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground no-underline hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" aria-hidden="true" />
					Back to meeting
				</Link>
				<h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">
					Edit agenda
				</h1>
				<p className="text-muted-foreground text-sm">{draft.templateName}</p>
			</div>

			<AgendaEditor
				draft={draft}
				onAddRow={async (afterRowId, kind) => {
					await addAgendaRowFn({ data: { meetingId, afterRowId, kind } });
					await refresh();
				}}
				onUpdateRow={async (rowId, patch) => {
					await updateAgendaRowFn({ data: { meetingId, rowId, patch } });
					await refresh();
				}}
				onRemoveRow={async (rowId) => {
					await removeAgendaRowFn({ data: { meetingId, rowId } });
					await refresh();
				}}
				onMoveRow={async (rowId, direction) => {
					await moveAgendaRowFn({ data: { meetingId, rowId, direction } });
					await refresh();
				}}
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
