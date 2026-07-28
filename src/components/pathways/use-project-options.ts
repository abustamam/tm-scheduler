import { useEffect, useState } from "react";
import { getProjectOptions, type PickerPath } from "#/server/project-picker";

/**
 * Load a member's pickable Pathways projects (#418).
 *
 * Fetched on demand rather than in a route loader because the subject isn't
 * known until the sheet opens — and on the claim path it changes as the
 * claimant picks their name. Loading it for every member of the roster up front
 * would be the whole catalog times the club.
 *
 * A failure resolves to an empty list, not an error: the picker degrades to the
 * free-text fields it replaced, so a speech can always still be recorded.
 */
export function useProjectOptions(
	memberId: string | null,
	enabled: boolean,
): PickerPath[] {
	const [paths, setPaths] = useState<PickerPath[]>([]);

	useEffect(() => {
		if (!enabled || !memberId) {
			setPaths([]);
			return;
		}
		let live = true;
		getProjectOptions({ data: { memberId } })
			.then((result) => {
				if (live) setPaths(result);
			})
			.catch(() => {
				if (live) setPaths([]);
			});
		return () => {
			live = false;
		};
	}, [memberId, enabled]);

	return paths;
}
