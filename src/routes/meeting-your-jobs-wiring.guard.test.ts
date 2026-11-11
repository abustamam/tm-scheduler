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
	it("imports only the personal-meeting view and confirmSlot from src/server", () => {
		const raw = readFileSync(resolve(ROOT, CARD), "utf8");
		const mods = [
			...raw.matchAll(/(?:from\s+|import\()\s*"(#\/server\/[^"]+)"/g),
		].map((m) => m[1]);
		expect(mods.length).toBeGreaterThan(0);
		// #1612: plus `confirmSlot`, the holder arm (its server checks are the gate).
		expect(new Set(mods)).toEqual(
			new Set(["#/server/personal-meeting", "#/server/slots"]),
		);
	});

	// protects=the card's Confirm acts as the page's resolved member, per slot;
	// fails_when=the call drops memberId (selecting the officer arm) or loses
	// the slot; no_claim=the server accepts it.
	it("confirms through confirmSlot with the slot and the page's memberId (#1612)", () => {
		const raw = readSource(CARD).replace(/\s+/g, " ");
		expect(raw).toContain("await confirmSlot({ data: { slotId, memberId } });");
		expect(raw).toContain(
			"onClick={() => void confirmRole(role.slotId, role.roleName)}",
		);
		expect(raw).toMatch(/role\.status === "claimed" && canConfirm/);
		expect(raw).toMatch(/view\.planStatus === "coming"/);
	});
});
