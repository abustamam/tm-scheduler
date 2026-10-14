/**
 * Stand-ins for the three server modules the print route imports, for the
 * CLIENT bundle `print-fallback-entry.tsx` builds (see `client-bundle-chrome.ts`).
 * The bundle renders `PrintAgendaView`, which never calls any of them; they are
 * the route file's top-level imports, and the real ones reach `#/db`.
 */
const notInTheHarness = (name: string) => () => {
	throw new Error(`${name} is not available in the print client harness`);
};

export const getPublicMeetingByKey = notInTheHarness("getPublicMeetingByKey");
export const getClubLogoMeta = notInTheHarness("getClubLogoMeta");
export const resolveClubOrRedirect = notInTheHarness("resolveClubOrRedirect");
