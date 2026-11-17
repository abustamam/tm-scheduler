// #1651: a role change queued offline (#1638) must report on the Roles tab, and
// the offline banner must not tell members roles need a connection. The route
// cannot be rendered in jsdom (loader plus server fns), so both are read from
// source (comment-blind `readSource`: these are "must be present" checks). The
// indicator's own behaviour (member-only, pending/held lines) is rendered in
// `roles-sync-status.test.tsx`.
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

/** The `roles:` panel's source: from its key to the next panel key. */
function rolesPanel(src: string): string {
	const start = src.search(/\n\t{5}roles: \(/);
	expect(start).toBeGreaterThan(-1);
	const rest = src.slice(start + 1);
	const end = rest.search(/\n\t{5}\w+: \(/);
	expect(end).toBeGreaterThan(-1);
	return rest.slice(0, end);
}

describe("meeting route: Roles tab offline sync (#1651)", () => {
	const src = readSource(ROUTE);
	const squash = (s: string) => s.replace(/\s+/g, " ");

	it("renders <RolesSyncStatus> in the Roles panel, member-gated, unconditionally", () => {
		const panel = squash(rolesPanel(src));
		expect(panel).toContain(
			"<RolesSyncStatus shell={shell} sync={syncStatusProps} />",
		);
		// not switched off or wrapped in a dead condition
		expect(panel).not.toMatch(/\{\s*(false|0|null)\s*&&[^}]*<RolesSyncStatus/);
		expect(panel).not.toMatch(/\?\s*null\s*:\s*<RolesSyncStatus/);
	});

	it("the one SyncStatusProps object is built from the hook instance", () => {
		const s = squash(src);
		const at = s.indexOf("const syncStatusProps: SyncStatusProps = {");
		expect(at).toBeGreaterThan(-1);
		const obj = s.slice(at, s.indexOf("};", at));
		for (const wiring of [
			"online,",
			"queueCount: offlineMinutes.pendingCount",
			"draining: offlineMinutes.draining",
			"syncError: offlineMinutes.syncError",
			"justSynced: offlineMinutes.justSynced",
			"offlineMinutes.retryDrain()",
			"heldCount: offlineMinutes.heldOps.length",
			"offlineMinutes.discardHeld()",
		]) {
			expect(obj).toContain(wiring);
		}
	});

	it("the offline banner names what is saved and no longer lists roles as needing a connection", () => {
		const bannerAt = src.search(/\{!online && shell \? \(/);
		expect(bannerAt).toBeGreaterThan(-1);
		const rest = src.slice(bannerAt);
		const wifi = rest.indexOf("<WifiOff");
		expect(wifi).toBeGreaterThan(-1);
		const banner = squash(rest.slice(wifi, rest.indexOf("</div>", wifi)));
		expect(banner).toContain(
			"minutes edits, roll call, and taking, assigning or clearing a role are saved on this device and sync when you reconnect",
		);
		expect(banner).not.toMatch(/attendance/i);
		const need = banner.match(/\(([^)]*)\) need a connection/);
		expect(need).not.toBeNull();
		const list = (need as RegExpMatchArray)[1];
		expect(list).toContain("meeting details");
		// "role" may appear only inside an allowed phrase, never as its own item
		expect(list.replace(/guest assignments|speech details/g, "")).not.toMatch(
			/role/i,
		);
	});
});
