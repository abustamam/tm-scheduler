import { areaClubPrintPath } from "#/lib/area-visits";
import { cn } from "#/lib/utils";

/**
 * The "Print summary" link on a club's row and card (#1120): the one-page visit
 * summary, in a new tab. Renders nothing under `readOnly`: the console preview's
 * viewer is a superadmin, who is refused the summary (it is the director's), so
 * a link there would only open a not-found page.
 */
export function PrintSummaryLink({
	areaId,
	areaClubId,
	readOnly = false,
	className,
}: {
	areaId: string;
	areaClubId: string;
	readOnly?: boolean;
	className?: string;
}) {
	if (readOnly) return null;
	return (
		<a
			href={areaClubPrintPath(areaId, areaClubId)}
			target="_blank"
			rel="noreferrer"
			className={cn("underline-offset-4 hover:underline", className)}
		>
			Print summary
		</a>
	);
}
