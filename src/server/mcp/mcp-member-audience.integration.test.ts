/**
 * #1281: a plain member holds a connector credential, and every officer tool
 * still refuses them.
 *
 * Card (officer tools, member caller): protects=a member's `tmk_` token cannot
 * reach any officer tool on their own club; fails_when=a tool answers a member,
 * or the refusal differs between "your club" and "a club you are not in", or an
 * archived club is named; no_claim=inputs are previews (writes carry no
 * planHash), so green proves the authorization seam and not each tool's write
 * path, which have their own suites. The officer control call per tool proves
 * the input is one the tool accepts.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiTokens, clubs, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { MCP_TOOLS } = await import("#/server/mcp/tools");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { memberClubsForUser, NOT_OFFICER_MESSAGE } = await import(
	"#/server/mcp/authz-logic"
);
const { handleMcpRequest } = await import("#/server/mcp/handle-request");

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

function tool(name: string) {
	const t = MCP_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`no tool ${name}`);
	return t;
}

/** The dispatcher's job, inlined: the context a tool really receives. */
function call(name: string, token: string, input: Record<string, unknown>) {
	const t = tool(name);
	return t.handler(input, { rawToken: token, audience: t.audience });
}

async function outcome(p: Promise<unknown>) {
	try {
		return { ok: true as const, value: await p };
	} catch (e) {
		const err = e as { code?: string; message: string };
		return { ok: false as const, code: err.code, message: err.message };
	}
}

/** A valid-shaped input per officer tool for club `s` (previews, never applies). */
function officerInputs(s: SeededClub): Record<string, Record<string, unknown>> {
	return {
		assign_roles: {
			meetingId: s.meetingId,
			assignments: [{ slotId: s.slotId, memberId: s.memberId }],
		},
		cancel_meeting: { meetingId: s.meetingId },
		edit_agenda: {
			meetingId: s.meetingId,
			operations: [{ op: "add", label: "Break", minutes: 5 }],
		},
		find_people: { clubId: s.clubId },
		get_agenda: { meetingId: s.meetingId },
		get_import_report: { clubId: s.clubId },
		get_lineup_blast: { meetingId: s.meetingId },
		record_guest_book: {
			clubId: s.clubId,
			meetingDate: "2031-01-07",
			entries: [{ name: "Gia Guest" }],
		},
		restore_meeting: { meetingId: s.meetingId },
		set_awards: {
			meetingId: s.meetingId,
			awards: [{ category: "best_speaker", memberId: s.memberId }],
		},
		upsert_agendas: {
			clubId: s.clubId,
			meetings: [{ date: "2031-01-07", time: "19:00", theme: "Growth" }],
		},
		list_meetings: { clubId: s.clubId },
	};
}

const OFFICER_TOOLS = MCP_TOOLS.filter((t) => t.audience === "officer").map(
	(t) => t.name,
);

describe.skipIf(!hasTestDb)("member connector audience (#1281)", () => {
	it("covers every officer tool in MCP_TOOLS", () => {
		expect(Object.keys(officerInputs({} as SeededClub)).sort()).toEqual(
			[...OFFICER_TOOLS].sort(),
		);
		expect(OFFICER_TOOLS).toHaveLength(12);
	});

	it.each(
		OFFICER_TOOLS,
	)("%s: an officer is served, a member is refused with the exact message", async (name) => {
		const s = await club();
		const input = officerInputs(s)[name] ?? {};
		const adminToken = await tokenFor(s.adminUserId);
		const memberToken = await tokenFor(s.memberUserId);

		// restore needs a cancelled meeting for the control call to succeed.
		if (name === "restore_meeting") {
			await call("cancel_meeting", adminToken, { meetingId: s.meetingId });
		}
		const control = await outcome(call(name, adminToken, input));
		// get_import_report on a club with no import answers NOT_FOUND from
		// INSIDE the tool, which is as far as authorization goes; no fixture
		// import is seeded here.
		if (name === "get_import_report") {
			expect(control).toMatchObject({ ok: false, code: "NOT_FOUND" });
		} else {
			expect(control, "control call as officer").toMatchObject({ ok: true });
		}

		const refused = await outcome(call(name, memberToken, input));
		expect(refused).toEqual({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
	});

	it("a foreign club and the member's own club give byte-identical refusals", async () => {
		const own = await club();
		const foreign = await club();
		const token = await tokenFor(own.memberUserId);
		for (const name of ["find_people", "get_import_report", "list_meetings"]) {
			const a = await outcome(call(name, token, { clubId: own.clubId }));
			const b = await outcome(call(name, token, { clubId: foreign.clubId }));
			expect(a).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: NOT_OFFICER_MESSAGE,
			});
			expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		}
		for (const name of ["get_agenda", "cancel_meeting"]) {
			const a = await outcome(call(name, token, { meetingId: own.meetingId }));
			const b = await outcome(
				call(name, token, { meetingId: foreign.meetingId }),
			);
			expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		}
	});

	it("an archived club the user is only a member of is FORBIDDEN, not ARCHIVED, for an officer tool", async () => {
		const s = await club();
		const memberToken = await tokenFor(s.memberUserId);
		const adminToken = await tokenFor(s.adminUserId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		const member = await outcome(
			call("find_people", memberToken, { clubId: s.clubId }),
		);
		expect(member).toEqual({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
		// Control: an officer of the same club is told it is archived, so the
		// member answer above is the audience check and not the archive check.
		const officer = await outcome(
			call("find_people", adminToken, { clubId: s.clubId }),
		);
		expect(officer).toMatchObject({ ok: false, code: "ARCHIVED" });
	});

	it("the same member can call the three member tools", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const who = (await call("whoami", token, {})) as {
			clubs: { clubId: string; via: string }[];
		};
		expect(who.clubs).toEqual([
			expect.objectContaining({ clubId: s.clubId, via: "member" }),
		]);
		await expect(call("get_my_feedback", token, {})).resolves.toBeTruthy();
		await expect(call("get_my_schedule", token, {})).resolves.toEqual({
			meetings: [expect.objectContaining({ meetingId: s.meetingId })],
		});
	});

	/**
	 * Card (dispatcher stamping): protects=`buildServer` stamps each tool's own
	 * `audience` onto the context over the real HTTP path, so a `member` tool is
	 * let through `authorizeToken` for a plain member and an `officer` tool is
	 * not (#1283's member write tools depend on it); fails_when=the
	 * `audience: tool.audience` line is deleted (the member probe then fails
	 * closed as officer) or hard-coded to "member" (the officer probe then
	 * serves a plain member); no_claim=the shipped tools: none of the member
	 * tools calls `authorizeToken` yet, so two probe tools are registered for
	 * this case alone, because the stamp has no other observable today.
	 */
	it("the HTTP dispatcher stamps a member tool as member and an officer tool as officer", async () => {
		const s = await club();
		const memberToken = await tokenFor(s.memberUserId);
		const { authorizeToken } = await import("#/server/mcp/authz-logic");
		const mk = (name: string, audience: "member" | "officer") => ({
			name,
			audience,
			config: {
				title: name,
				description: "test probe",
				inputSchema: { clubId: z.string() },
			},
			handler: async (
				input: Record<string, unknown>,
				ctx: Parameters<typeof authorizeToken>[0],
			) => {
				await authorizeToken(ctx, input.clubId as string);
				return { served: true };
			},
		});
		const probes = [
			mk("probe_member", "member"),
			mk("probe_officer", "officer"),
		];
		MCP_TOOLS.push(...probes);
		try {
			let id = 0;
			const rpc = async (name: string) => {
				id += 1;
				const res = await handleMcpRequest(
					new Request("https://club.test/api/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							authorization: `Bearer ${memberToken}`,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id,
							method: "tools/call",
							params: { name, arguments: { clubId: s.clubId } },
						}),
					}),
				);
				return (
					JSON.parse(await res.text()) as {
						result: {
							isError?: boolean;
							structuredContent: {
								served?: boolean;
								error?: { message: string };
							};
						};
					}
				).result;
			};
			const asMember = await rpc("probe_member");
			expect(asMember.isError ?? false).toBe(false);
			expect(asMember.structuredContent.served).toBe(true);
			const asOfficer = await rpc("probe_officer");
			expect(asOfficer.isError).toBe(true);
			expect(asOfficer.structuredContent.error?.message).toBe(
				NOT_OFFICER_MESSAGE,
			);
		} finally {
			for (const p of probes) MCP_TOOLS.splice(MCP_TOOLS.indexOf(p), 1);
		}
	});

	it("a tool context with no audience is treated as officer (fails closed)", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const r = await outcome(
			tool("find_people").handler({ clubId: s.clubId }, { rawToken: token }),
		);
		expect(r).toEqual({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
	});
});

/**
 * Card (memberClubsForUser): protects=standing is admin > officer > member, an
 * archived club is kept and flagged (callers decide), and an inactive
 * membership is no standing at all; fails_when=a plain member is dropped or
 * ranked above an officer, an admin who also holds office is downgraded, an
 * archived club disappears, or an inactive member still gets a club;
 * no_claim=what each caller does with the standing (the audience gate and
 * the consent rule have their own cases).
 */
describe.skipIf(!hasTestDb)("memberClubsForUser standing (#1281)", () => {
	it("admin > officer > member, and archived clubs are kept", async () => {
		const s = await club();
		const m = await memberClubsForUser(s.memberUserId);
		expect(m).toEqual([
			expect.objectContaining({ clubId: s.clubId, via: "member" }),
		]);
		const a = await memberClubsForUser(s.adminUserId);
		expect(a[0]?.via).toBe("admin");

		const { officerTerms } = await import("#/db/schema");
		await testDb
			.insert(officerTerms)
			.values({ membershipId: s.memberId, position: "vp_education" });
		expect((await memberClubsForUser(s.memberUserId))[0]?.via).toBe("officer");
		// An admin who also holds an office stays admin.
		await testDb
			.insert(officerTerms)
			.values({ membershipId: s.adminMemberId, position: "president" });
		expect((await memberClubsForUser(s.adminUserId))[0]?.via).toBe("admin");

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		expect(await memberClubsForUser(s.memberUserId)).toEqual([
			expect.objectContaining({ clubId: s.clubId, archived: true }),
		]);
	});

	it("an inactive membership is not a standing", async () => {
		const s = await club();
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, s.memberId));
		expect(await memberClubsForUser(s.memberUserId)).toEqual([]);
	});
});
