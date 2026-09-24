import { Link } from "@tanstack/react-router";

/**
 * The speech-log card footer (#681), shared by `/dashboard` and
 * `/members/$id`: "Show all" when the default window cut speeches off, "Show
 * recent" once `?speeches=all` is set, nothing otherwise.
 *
 * `to="."` links to the CURRENT route with only the search changed, so one
 * component serves both pages (and keeps the profile's `$id`) without either
 * route's path being named here.
 */
export function SpeechLogToggle({
	truncated,
	allSpeeches,
}: {
	truncated: boolean;
	allSpeeches: boolean;
}) {
	if (!truncated && !allSpeeches) return null;
	return (
		<div className="border-t border-[var(--line)] px-5 py-2.5 text-right text-xs">
			{allSpeeches ? (
				<Link to="." search={{}}>
					Show recent
				</Link>
			) : (
				<Link to="." search={{ speeches: "all" }}>
					Show all
				</Link>
			)}
		</div>
	);
}
