// #1651: a role change queued offline (#1638) must report on the Roles tab, and
// the offline banner must not tell members roles need a connection. The route
// cannot be rendered in jsdom (loader plus server fns), so both are read from
// source (comment-blind `readSource`: these are "must be present" checks).
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

/** The `roles:` panel's source: from its key to the next panel key. */
function rolesPanel(src: string): string {
	const start = src.search(/\n\t{5}roles: \(/);
	const end = src.search(/\n\t{5}attendance: \(/);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe("meeting route: Roles tab offline sync (#1651)", () => {
	const src = readSource(ROUTE);
	const squash = (s: string) => s.replace(/\s+/g, " ");

	it("renders <SyncStatus> in the Roles panel from the route's one hook instance", () => {
		const panel = rolesPanel(src);
		const at = panel.indexOf("<SyncStatus");
		expect(at).toBeGreaterThan(-1);
		const tag = panel.slice(at, panel.indexOf("/>", at));
		for (const wiring of [
			"online={online}",
			"queueCount={offlineMinutes.pendingCount}",
			"draining={offlineMinutes.draining}",
			"syncError={offlineMinutes.syncError}",
			"justSynced={offlineMinutes.justSynced}",
			"offlineMinutes.retryDrain()",
			"heldCount={offlineMinutes.heldOps.length}",
			"offlineMinutes.discardHeld()",
		]) {
			expect(squash(tag)).toContain(wiring);
		}
	});

	it("the offline banner names role assign/clear as saved and no longer lists roles as needing a connection", () => {
		const banner = squash(src);
		expect(banner).not.toMatch(/\(meeting details, roles\)/);
		expect(banner).toMatch(
			/assigning or clearing roles are saved on this device and sync when you reconnect/,
		);
		expect(banner).toMatch(
			/\(meeting details, other role changes\) need a connection/,
		);
	});
});
