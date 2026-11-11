/**
 * Wiring guard for the meeting page's "Your jobs" card (#1376).
 *
 * The route imports the db layer and cannot be rendered under vitest, so the
 * prop expressions are asserted as source (CLAUDE.md: a component tested
 * through its props cannot see a WRONG prop).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";
const CARD = "src/components/club/meeting-your-jobs.tsx";
const HOOK = "src/components/club/use-confirm-own-role.ts";

describe("MeetingYourJobs wiring (#1376)", () => {
	// protects=the card sits right after the strip and acts as the page's
	// identity, meeting key and club; fails_when=it is moved, fed `?as=`, or
	// given the wrong key/club expression; no_claim=the card renders.
	it("mounts after MeetingPersonalStrip with myId and source", () => {
		const src = readSource(ROUTE);
		const strip = src.indexOf("<MeetingPersonalStrip");
		const stripEnd = src.indexOf("/>", strip) + 2;
		const card = src.indexOf("<MeetingYourJobs");
		expect(card).toBeGreaterThan(strip);
		// Nothing but whitespace/comments between the two elements.
		expect(src.slice(stripEnd, card).replace(/[\s{}]/g, "")).toBe("");
		const cardEnd = src.indexOf("/>", card);
		const block = src.slice(card, cardEnd);
		expect(block).toMatch(/memberId=\{myId\}/);
		expect(block).toMatch(/source=\{source\}/);
		expect(block).toMatch(/meetingKey=\{urlKey\}/);
		expect(block).toMatch(/clubUuid=\{clubUuid\}/);
		expect(block).not.toMatch(/search\.as|\bas\b=/);
	});

	// protects=no new server surface or private fields; fails_when=the card
	// imports another server module; no_claim=the view's fields are public-safe.
	// (The confirm call lives in the shared hook, pinned below.)
	it("imports only #/server/personal-meeting from src/server", () => {
		const raw = readFileSync(resolve(ROOT, CARD), "utf8");
		const mods = [...raw.matchAll(/from\s+"(#\/server\/[^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(mods.length).toBeGreaterThan(0);
		expect(new Set(mods)).toEqual(new Set(["#/server/personal-meeting"]));
	});

	// protects=the shared Confirm hook acts as the page's resolved member, per
	// slot, and the card feeds it the page's memberId; fails_when=the call drops
	// memberId (selecting the officer arm) or loses the slot, or the card hands
	// the hook another id; no_claim=the server accepts it.
	it("confirms through confirmSlot with the slot and the page's memberId (#1612)", () => {
		const hook = readSource(HOOK).replace(/\s+/g, " ");
		expect(hook).toContain(
			"await confirmSlot({ data: { slotId, memberId } });",
		);
		const card = readSource(CARD).replace(/\s+/g, " ");
		expect(card).toMatch(/useConfirmOwnRole\(\{ memberId,/);
		expect(card).toContain(
			"onClick={() => void confirm(role.slotId, role.roleName)}",
		);
		expect(card).toContain('role.status === "claimed" && canConfirm');
	});

	// protects=the card offers Confirm to anyone who has not declined, and never
	// once the meeting is over; fails_when=the gate stops excluding not_coming,
	// reverts to requiring coming, or loses the meeting-over arm; no_claim=the
	// RSVP page's own gate.
	it("gates Confirm on not_coming and on the meeting being over (#1612)", () => {
		const card = readSource(CARD).replace(/\s+/g, " ");
		const gate = card.match(/const canConfirm = ([^;]*);/)?.[1] ?? "";
		expect(gate).toContain('view.planStatus !== "not_coming"');
		expect(gate).toContain("!isMeetingOver({");
	});
});
