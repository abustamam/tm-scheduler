import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isRefreshRefusal,
	REFRESH_REFUSAL_MESSAGE,
	REFRESH_REFUSAL_SQLSTATE,
} from "./oauth-refresh-refusal";

const refusal = {
	code: REFRESH_REFUSAL_SQLSTATE,
	message: `${REFRESH_REFUSAL_MESSAGE}u1 holds no oauth_consent for client c1`,
};

describe("isRefreshRefusal (#851)", () => {
	it("recognises the trigger's error however deeply it is wrapped", () => {
		expect(isRefreshRefusal(refusal)).toBe(true);
		expect(
			isRefreshRefusal(
				new Error("Failed query: insert …", {
					cause: new Error("adapter", { cause: refusal }),
				}),
			),
		).toBe(true);
	});

	it("does not claim a bare permission error, which is an outage, not a disconnect", () => {
		expect(
			isRefreshRefusal({
				code: REFRESH_REFUSAL_SQLSTATE,
				message: "permission denied for table oauth_refresh_token",
			}),
		).toBe(false);
	});

	it("does not claim the message under another SQLSTATE", () => {
		expect(isRefreshRefusal({ ...refusal, code: "P0001" })).toBe(false);
	});

	it("is false for non-errors and survives a cause cycle", () => {
		expect(isRefreshRefusal(undefined)).toBe(false);
		expect(isRefreshRefusal("boom")).toBe(false);
		const a: { cause?: unknown } = {};
		a.cause = a;
		expect(isRefreshRefusal(a)).toBe(false);
	});

	it("matches what migration 0087 actually raises", () => {
		const sql = readFileSync(
			resolve(
				__dirname,
				"../../drizzle/0087_oauth_refresh_requires_consent.sql",
			),
			"utf8",
		);
		expect(sql).toContain(`RAISE EXCEPTION '${REFRESH_REFUSAL_MESSAGE}%`);
		expect(sql).toContain("USING ERRCODE = 'insufficient_privilege'");
	});
});
