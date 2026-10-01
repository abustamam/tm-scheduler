import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import { phoneEditPayload } from "./member-edit-phone";

describe("phoneEditPayload (#906 review)", () => {
	it("omits the phone when the field is untouched", () => {
		expect(phoneEditPayload("415-555-2671 x12", "415-555-2671 x12")).toEqual(
			{},
		);
	});

	it("omits it for an untouched byte-exact padded value", () => {
		expect(
			phoneEditPayload("  call the office  ", "  call the office  "),
		).toEqual({});
	});

	it("omits it for an untouched empty field over no phone", () => {
		expect(phoneEditPayload("", null)).toEqual({});
	});

	it("sends a changed value, trimmed", () => {
		expect(phoneEditPayload(" +14155550100 ", "+14155552671")).toEqual({
			phone: "+14155550100",
		});
	});

	it("sends an explicit null when the officer blanks a phone", () => {
		expect(phoneEditPayload("   ", "+14155552671")).toEqual({ phone: null });
	});

	it("sends a value typed into a field that loaded empty", () => {
		expect(phoneEditPayload("+14155550100", null)).toEqual({
			phone: "+14155550100",
		});
	});
});

describe("the member page sends the phone through phoneEditPayload", () => {
	// The route cannot be submitted from here without its whole loader harness,
	// so this pins the wiring: the payload spreads the helper's result against
	// the LOADED value, and no bare `phone:` key survives beside it to send the
	// stale prefill anyway.
	const src = readSource("src/routes/_authed/members.$id.tsx");

	it("spreads phoneEditPayload against member.phoneRaw", () => {
		expect(src).toMatch(
			/\.\.\.phoneEditPayload\(\s*String\(form\.get\("phone"\) \?\? ""\),\s*member\.phoneRaw,?\s*\)/,
		);
	});

	it("does not also send a phone key of its own", () => {
		expect(src).not.toMatch(/phone:\s*String\(form\.get\("phone"\)/);
	});
});
