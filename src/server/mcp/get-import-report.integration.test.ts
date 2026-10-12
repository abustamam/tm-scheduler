/**
 * `get_import_report` (#1051) through the real `/api/mcp` handler: it returns
 * its own club's stored reconciliation report and refuses every other club.
 *
 * `history-import-logic.integration.test.ts` proves an apply stores the report;
 * this stores one directly and tests only the tool's reach.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, clubImports, clubs } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { handleMcpRequest } = await import("#/server/mcp/handle-request");
const { hashApiToken } = await import("#/server/api-tokens-logic");

let rpcId = 0;
async function callTool(token: string, args: Record<string, unknown>) {
	rpcId += 1;
	const res = await handleMcpRequest(
		new Request("https://club.test/api/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: rpcId,
				method: "tools/call",
				params: { name: "get_import_report", arguments: args },
			}),
		}),
	);
	const parsed = JSON.parse(await res.text()) as {
		result: { isError?: boolean; structuredContent: Record<string, unknown> };
	};
	return {
		isError: Boolean(parsed.result.isError),
		body: parsed.result.structuredContent,
	};
}

const REPORT = {
	reconciled: true,
	meetings: { applied: 1, failed: [] },
	counts: [
		{ key: "meetings", label: "Meetings", bundle: 1, gavelup: 1, missing: [] },
	],
	notImported: [],
};

describe.skipIf(!hasTestDb)("get_import_report (#1051)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let token: string;
	let importId: string;
	let otherImportId: string;

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
		return raw;
	}

	async function storeImport(clubId: string, applied: boolean) {
		const [row] = await testDb
			.insert(clubImports)
			.values({
				clubId,
				source: "easy_speak",
				bundle: { importState: { report: REPORT } },
				bundleSha256: randomUUID(),
				uploadedByUserId: "u",
				appliedAt: applied ? new Date() : null,
			})
			.returning({ id: clubImports.id });
		return row?.id as string;
	}

	beforeEach(async () => {
		seed = await seedClub();
		other = await seedClub();
		token = await mint(seed.adminUserId);
		importId = await storeImport(seed.clubId, true);
		otherImportId = await storeImport(other.clubId, true);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	it("returns its own club's stored report, latest by default or by id", async () => {
		const latest = await callTool(token, { clubId: seed.clubId });
		expect(latest.isError).toBe(false);
		expect(latest.body).toMatchObject({
			clubId: seed.clubId,
			importId,
			report: { reconciled: true },
		});
		const byId = await callTool(token, { clubId: seed.clubId, importId });
		expect(byId.body).toMatchObject({ importId });
	});

	it("refuses another club, whether or not it has an import", async () => {
		const r = await callTool(token, { clubId: other.clubId });
		expect(r.isError).toBe(true);
		expect(r.body).toMatchObject({ error: { code: "FORBIDDEN" } });
		expect(JSON.stringify(r.body)).not.toContain(otherImportId);
	});

	it("does not return another club's report for its own club id and a foreign import id", async () => {
		const r = await callTool(token, {
			clubId: seed.clubId,
			importId: otherImportId,
		});
		expect(r.isError).toBe(true);
		expect(r.body).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	it("says so when the club has no applied import", async () => {
		await testDb.delete(clubImports).where(eq(clubImports.id, importId));
		await storeImport(seed.clubId, false);
		const r = await callTool(token, { clubId: seed.clubId });
		expect(r.body).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	it("refuses an archived club", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		const r = await callTool(token, { clubId: seed.clubId });
		expect(r.isError).toBe(true);
	});
});
