import { Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";

/**
 * The page every `/club/<club>/meeting/<key>/…` route shows when its key names
 * no meeting (#877): a date with nothing scheduled, a malformed key, a uuid from
 * another club, or an archived club. They all collapse to one answer on purpose.
 * The resolver (`resolvePublicMeetingKey`) returns null for every one of them, so
 * telling them apart here would be an existence oracle for a takedown.
 *
 * ONE component, not a copy per route. The meeting page and three duty pages
 * each carried their own copy of this markup, and the agenda editor and ballot
 * had none, so a missing meeting there fell through to the root not-found page
 * or, on the editor, to a 500.
 *
 * Takes the RAW `clubId` segment rather than reading route params, because it
 * is mounted by routes under two different parents (`/club/$clubId` and
 * `/club/$clubId_`) and a component can only read its own route's params.
 */
export function MeetingNotFound({ clubId }: { clubId: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
			<p className="font-semibold text-lg">Meeting not found</p>
			<p className="text-muted-foreground text-sm">
				This meeting doesn't exist for this club, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link
					to="/club/$clubId"
					params={{ clubId }}
					search={{ view: "roles", count: 8 }}
				>
					Back to meetings
				</Link>
			</Button>
		</div>
	);
}
