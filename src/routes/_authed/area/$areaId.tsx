import { createFileRoute, notFound } from "@tanstack/react-router";
import { AreaHealthView } from "#/components/area/area-health-view";
import { PageContainer } from "#/components/page-container";
import { isAreaRefusal } from "#/lib/area-refusal";
import { programYearLabel } from "#/lib/dcp";
import { getAreaHealth } from "#/server/area-health";

/**
 * An Area Director's view of their area (#1119, ADR-0032): counts, rates and
 * dates for every club in it, and nothing about any person. `getAreaHealth`
 * checks the caller holds a CURRENT term on THIS area before it reads anything;
 * a refusal renders the standard not-found, the same page as a link that never
 * existed.
 *
 * A person with no club reaches this page through `_authed.tsx`'s minimal
 * frame, not the workspace shell (`clublessMayOpen`).
 */
export const Route = createFileRoute("/_authed/area/$areaId")({
	loader: async ({ params }) => {
		try {
			return await getAreaHealth({ data: { areaId: params.areaId } });
		} catch (err) {
			if (isAreaRefusal(err)) throw notFound();
			throw err;
		}
	},
	component: AreaPage,
});

function AreaPage() {
	const health = Route.useLoaderData();
	return (
		<PageContainer className="space-y-6">
			<div className="space-y-1">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Area {health.label}
				</h1>
				<p className="text-sm text-muted-foreground">
					{programYearLabel(health.programYear)} · Counts, rates and dates for
					each club in your area. Nothing here names a member.
				</p>
			</div>
			<AreaHealthView health={health} />
		</PageContainer>
	);
}
