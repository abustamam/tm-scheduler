/**
 * DB-backed tests for `/api/mcp` itself (#773, design D12): what the token
 * proves, what it does not, and that the transport survives a second call.
 *
 * Drives `handleMcpRequest` with real `Request` objects rather than going
 * through the route file, because a `createFileRoute` handler body is
 * unreachable from vitest (#544) — which is exactly why the handler lives in a
 * module of its own.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/mcp-route.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { session, user } from "#/db/auth-schema";
import {
	activityLog,
	apiTokens,
	clubs,
	guests,
	impersonationSessions,
	meetings,
	officerTerms,
	people,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { handleMcpRequest } = await import("#/server/mcp/handle-request");
const oauth = await import("#/test/oauth-flow");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { MCP_TOOLS } = await import("#/server/mcp/tools");

/** A JSON-RPC POST to /api/mcp, with an optional bearer token and cookie. */
function mcpRequest(
	body: unknown,
	opts: { token?: string | null; cookie?: string } = {},
): Request {
	return new Request("https://club.test/api/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
			...(opts.cookie ? { cookie: opts.cookie } : {}),
		},
		body: JSON.stringify(body),
	});
}

let rpcId = 0;
function toolsCall(name: string, args: Record<string, unknown> = {}) {
	rpcId += 1;
	return {
		jsonrpc: "2.0",
		id: rpcId,
		method: "tools/call",
		params: { name, arguments: args },
	};
}

/** The tool's own payload, or its error envelope. */
async function readToolResult(res: Response): Promise<{
	status: number;
	isError: boolean;
	body: Record<string, unknown>;
	raw: string;
}> {
	const raw = await res.text();
	if (!res.ok) return { status: res.status, isError: true, body: {}, raw };
	const parsed = JSON.parse(raw) as {
		result?: {
			isError?: boolean;
			structuredContent?: Record<string, unknown>;
		};
	};
	return {
		status: res.status,
		isError: Boolean(parsed.result?.isError),
		body: parsed.result?.structuredContent ?? {},
		raw,
	};
}

describe.skipIf(!hasTestDb)("/api/mcp (#773)", () => {
	let seed: SeededClub;
	let adminToken: string;
	/** Rows created directly by a test, cleaned up by id.  */
	let extraUsers: string[] = [];
	let extraClubs: string[] = [];
	let extraPeople: string[] = [];

	/** Mint a token for a user, as `/me` would. */
	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
		return raw;
	}

	beforeEach(async () => {
		seed = await seedClub();
		extraUsers = [];
		extraClubs = [];
		extraPeople = [];
		adminToken = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const id of extraClubs) {
			await testDb.delete(clubs).where(eq(clubs.id, id));
		}
		if (extraPeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, extraPeople));
		}
		if (extraUsers.length > 0) {
			await testDb.delete(user).where(inArray(user.id, extraUsers));
		}
	});

	// --- AC1: what a token proves --------------------------------------

	it("authenticates tools/list with a minted token", async () => {
		const res = await handleMcpRequest(
			mcpRequest(
				{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
				{ token: adminToken },
			),
		);
		expect(res.status).toBe(200);
		const listed = JSON.parse(await res.text()) as {
			result: { tools: { name: string }[] };
		};
		expect(listed.result.tools.map((t) => t.name).sort()).toEqual([
			"assign_roles",
			"find_people",
			"get_agenda",
			"list_meetings",
			"record_guest_book",
			"upsert_agendas",
			"whoami",
		]);
	});

	it("401s an unknown token", async () => {
		const res = await handleMcpRequest(
			mcpRequest(
				{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
				{ token: "tmk_not_a_real_token" },
			),
		);
		expect(res.status).toBe(401);
	});

	it("401s a REVOKED token", async () => {
		await testDb
			.update(apiTokens)
			.set({ revokedAt: new Date() })
			.where(eq(apiTokens.tokenHash, hashApiToken(adminToken)));
		const res = await handleMcpRequest(
			mcpRequest(
				{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
				{ token: adminToken },
			),
		);
		expect(res.status).toBe(401);
	});

	it("401s a missing Authorization header", async () => {
		const res = await handleMcpRequest(
			mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		);
		expect(res.status).toBe(401);
	});

	// --- AC2: bearer-only, tested behaviourally -------------------------

	it("401s a request carrying a VALID session cookie and no token, and writes nothing", async () => {
		// The behavioural half of the bearer-only claim. The import grep in
		// `mcp-authz.guard.test.ts` is blind to a cookie reaching the path through
		// a helper or a re-export, and this is the one claim in the design where
		// being wrong is a security hole rather than a bug. So: a REAL session row
		// for a REAL club admin, sent as the app's own cookie.
		const token = randomUUID();
		await testDb.insert(session).values({
			id: randomUUID(),
			token,
			userId: seed.adminUserId,
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			updatedAt: new Date(),
		});

		const before = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));

		const res = await handleMcpRequest(
			mcpRequest(
				toolsCall("record_guest_book", {
					clubId: seed.clubId,
					meetingDate: "2026-01-01",
					entries: [{ name: "Should Not Exist" }],
				}),
				{ cookie: `better-auth.session_token=${token}` },
			),
		);
		expect(res.status).toBe(401);

		const after = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		expect(after).toEqual(before);
	});

	// --- AC3: who may act on which club ---------------------------------

	it("FORBIDs a member who is not an admin", async () => {
		const memberToken = await mintToken(seed.memberUserId);
		const r = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("list_meetings", { clubId: seed.clubId }), {
					token: memberToken,
				}),
			),
		);
		expect(r.isError).toBe(true);
		expect(r.body).toMatchObject({ error: { code: "FORBIDDEN" } });
	});

	it("grants an elected officer who is not a stored admin (#202)", async () => {
		// Effective-admin: the same grant `requireClubRole` gives in the browser.
		// Without this case the officer path would be untested and could be
		// dropped by a refactor with every other test green.
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
		});
		const memberToken = await mintToken(seed.memberUserId);
		const r = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("whoami"), { token: memberToken }),
			),
		);
		expect(r.isError).toBe(false);
		expect(r.body).toMatchObject({
			clubs: [{ clubId: seed.clubId, via: "officer" }],
		});
	});

	it("FORBIDs an admin of club A naming club B's meeting", async () => {
		const other = await seedClub();
		try {
			const r = await readToolResult(
				await handleMcpRequest(
					mcpRequest(toolsCall("get_agenda", { meetingId: other.meetingId }), {
						token: adminToken,
					}),
				),
			);
			expect(r.isError).toBe(true);
			expect(r.body).toMatchObject({ error: { code: "FORBIDDEN" } });
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("FORBIDs a superadmin holding a read_write impersonation session and no membership", async () => {
		// The finding that motivated splitting these entry points off from
		// `requireClubRole`: that function falls through to
		// `requireReadWriteImpersonation`, so a superadmin with a browser "act as
		// admin" session open would have passed that authority to every token
		// call on the same club. An impersonation grant is something a human did
		// in a browser under ADR-0020's audit trail; a token is not that browser.
		const superId = randomUUID();
		await testDb.insert(user).values({
			id: superId,
			name: "Super Admin",
			email: `super-${superId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		extraUsers.push(superId);
		const [person] = await testDb
			.insert(people)
			.values({ name: "Super Admin", userId: superId })
			.returning({ id: people.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		extraPeople.push(person!.id);

		await testDb.insert(impersonationSessions).values({
			superadminUserId: superId,
			clubId: seed.clubId,
			mode: "read_write",
			reason: "testing",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});

		const superToken = await mintToken(superId);
		const r = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("list_meetings", { clubId: seed.clubId }), {
					token: superToken,
				}),
			),
		);
		expect(r.isError).toBe(true);
		expect(r.body).toMatchObject({ error: { code: "FORBIDDEN" } });
	});

	it("FORBIDs a club the token owner has no membership in at all", async () => {
		const r = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("list_meetings", { clubId: randomUUID() }), {
					token: adminToken,
				}),
			),
		);
		expect(r.isError).toBe(true);
		// FORBIDDEN, not NOT_FOUND: distinguishing the two would let a token
		// enumerate the platform's clubs.
		expect(r.body).toMatchObject({ error: { code: "FORBIDDEN" } });
	});

	it("reports ARCHIVED — not FORBIDDEN — to a real admin of an archived club", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		const r = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("list_meetings", { clubId: seed.clubId }), {
					token: adminToken,
				}),
			),
		);
		expect(r.body).toMatchObject({ error: { code: "ARCHIVED" } });

		// …and it is not NAMED by whoami either: archiving is the takedown lever.
		const who = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("whoami"), { token: adminToken }),
			),
		);
		expect(who.body).toMatchObject({ clubs: [] });
	});

	// --- AC4: the transport survives a second call ----------------------

	it("handles two sequential tools/call requests in one process", async () => {
		// In stateless mode the SDK transport refuses a second use
		// (`webStandardStreamableHttp.js:172-177`), so hoisting the server or the
		// transport to module scope works once and fails on the NEXT call — the
		// worst failure shape there is, because every smoke test passes.
		const first = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("whoami"), { token: adminToken }),
			),
		);
		const second = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("list_meetings", { clubId: seed.clubId }), {
					token: adminToken,
				}),
			),
		);
		expect(first.isError).toBe(false);
		expect(second.isError).toBe(false);
		expect(second.body).toMatchObject({ clubId: seed.clubId });
	});

	it("stamps last_used_at", async () => {
		await handleMcpRequest(
			mcpRequest(toolsCall("whoami"), { token: adminToken }),
		);
		const [row] = await testDb
			.select({ lastUsedAt: apiTokens.lastUsedAt })
			.from(apiTokens)
			.where(eq(apiTokens.tokenHash, hashApiToken(adminToken)));
		expect(row?.lastUsedAt).toBeInstanceOf(Date);
	});

	// --- AC11: nothing unmasked leaves ----------------------------------

	it("returns no raw guest email or phone from ANY tool", async () => {
		const email = "raw.address@example.com";
		const phone = "+15551234567";
		const [contactful] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Contactful Guest",
				email,
				phone,
				stage: "prospect",
			})
			.returning({ id: guests.id });

		// `record_guest_book` needs a meeting whose club-local day has ARRIVED, or
		// it returns `plan: null` and its masking code never runs — which is how
		// an earlier version of this test passed vacuously on the one tool that
		// actually ingests raw contact details. `seedClub`'s meeting is in the
		// future by design, so add a past one.
		const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: past,
			status: "completed",
			theme: "Past",
		});
		const pastDate = utcToZonedWallTime(past, "America/Chicago").slice(0, 10);

		// Sweep every tool that can name a guest, on the raw response text rather
		// than a parsed field: a leak through an unexpected key is exactly the
		// kind this is meant to catch.
		const calls = [
			toolsCall("whoami"),
			toolsCall("list_meetings", { clubId: seed.clubId }),
			toolsCall("find_people", { clubId: seed.clubId }),
			toolsCall("get_agenda", { meetingId: seed.meetingId }),
			toolsCall("record_guest_book", {
				clubId: seed.clubId,
				meetingDate: pastDate,
				entries: [{ name: "Contactful Guest", email }],
			}),
			// #809. It names this guest twice — once assigning, once in the plan
			// line's `to` — and it reads `guests` with its own select rather than
			// through `toMcpGuest`, which `serialize.ts` calls THE serializer
			// every guest passes through. That is exactly the shape this sweep is
			// the compensating control for, so the tool has to be in it.
			toolsCall("assign_roles", {
				meetingId: seed.meetingId,
				assignments: [
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					{ slotId: seed.slotId, guestId: contactful!.id },
				],
			}),
			// #808. It reads no guest and writes no guest, so on the face of it
			// it cannot leak one — which is exactly the reasoning that would keep
			// it out of a HAND-WRITTEN sweep and is why the sweep is derived. It
			// echoes free text the caller sent and re-reads a club's meetings, and
			// the day either of those grows a guest name this case is already
			// watching. A `time` is passed because this club has no standing
			// recurrence rule, so without one the entry would block on
			// `MISSING_TIME` and the plan it is being swept for would be empty.
			toolsCall("upsert_agendas", {
				clubId: seed.clubId,
				meetings: [{ date: "2027-03-02", time: "19:00", theme: "Harvest" }],
			}),
		];
		for (const call of calls) {
			const { raw } = await readToolResult(
				await handleMcpRequest(mcpRequest(call, { token: adminToken })),
			);
			expect(raw, `${call.params.name} leaked a raw email`).not.toContain(
				email,
			);
			expect(raw, `${call.params.name} leaked a raw phone`).not.toContain(
				"5551234567",
			);
		}

		// DERIVED completeness, the `mcp-authz.guard.test.ts` pattern: a
		// hand-written list cannot fail for the case it exists to catch. #809
		// added its tool to the registry assertion 280 lines above this one and
		// not to the sweep, and nothing noticed — so the next tool fails HERE
		// until someone writes it a call, rather than shipping unswept.
		expect(
			[...new Set(calls.map((c) => c.params.name))].sort(),
			"a tool is registered but not swept for unmasked guest contact. Add a call for it above; do not delete this case.",
		).toEqual(MCP_TOOLS.map((t) => t.name).sort());

		// The masked forms ARE there — otherwise this test would pass on a tool
		// that simply returned nothing.
		const found = await readToolResult(
			await handleMcpRequest(
				mcpRequest(toolsCall("find_people", { clubId: seed.clubId }), {
					token: adminToken,
				}),
			),
		);
		expect(JSON.stringify(found.body)).toContain("r•••@example.com");
		expect(JSON.stringify(found.body)).toContain("•••-4567");
	});

	// --- Limits ----------------------------------------------------------

	it("rejects an oversized body before parsing it", async () => {
		const res = await handleMcpRequest(
			new Request("https://club.test/api/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": "2000000",
					authorization: `Bearer ${adminToken}`,
				},
				body: "{}",
			}),
		);
		expect(res.status).toBe(413);
	});

	it("rejects a body that is not JSON", async () => {
		const res = await handleMcpRequest(
			new Request("https://club.test/api/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${adminToken}`,
				},
				body: "not json",
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects a BATCHED JSON-RPC request", async () => {
		// In JSON-response mode the SDK dispatches every message of a batch at
		// once without awaiting them (`webStandardStreamableHttp.js:588-591`), so
		// one 1 MB body could start thousands of applies together. Each blocks on
		// the club advisory lock holding a pooled connection, and the app shares
		// node-postgres' default pool of 10 — ten queued applies from one valid
		// token would starve the whole web app, not just this endpoint.
		const res = await handleMcpRequest(
			mcpRequest([toolsCall("whoami"), toolsCall("whoami")], {
				token: adminToken,
			}),
		);
		expect(res.status).toBe(400);
	});

	it("sends no CORS headers — the clients are not browsers", async () => {
		const res = await handleMcpRequest(
			mcpRequest(toolsCall("whoami"), { token: adminToken }),
		);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});

/**
 * The second credential kind (#843): an OAuth access token, minted by a REAL
 * authorization-code grant through GavelUp's own `auth.handler` — magic-link
 * sign-in, authorize with PKCE, consent, token redemption — so what `/api/mcp`
 * is asked to accept is exactly what claude.ai would present. See
 * `#/test/oauth-flow` for why nothing here signs a token by hand, except the
 * three tokens that exist to be WRONG, which are signed by the real key via
 * the jwt plugin so that the one thing wrong with each is the thing named.
 */
describe.skipIf(!hasTestDb)(
	"/api/mcp with an OAuth access token (#843)",
	() => {
		const SUFFIX = randomBytes(4).toString("hex");
		const SUPERADMIN_EMAIL = `oauth-route-admin-${SUFFIX}@example.com`;
		/** Every email a magic link went to, so their verification rows are removed. */
		const emails = new Set<string>([SUPERADMIN_EMAIL]);
		let loaded: Awaited<ReturnType<typeof oauth.loadAuthForTest>>;
		let restoreFetch: () => void;
		let jwksFetches = 0;
		let client: Awaited<ReturnType<typeof oauth.registerClient>>;
		let seed: SeededClub;

		beforeAll(async () => {
			loaded = await oauth.loadAuthForTest(SUPERADMIN_EMAIL);
			// Counted, so the forged-kid case can assert the verifier never
			// fetched for a key GavelUp does not have.
			restoreFetch = oauth.routeJwksToHandler((request) => {
				jwksFetches += 1;
				return loaded.handler(request);
			});
			const superCookie = await oauth.signInCookie(loaded, SUPERADMIN_EMAIL);
			client = await oauth.registerClient(
				loaded,
				superCookie,
				`mcp-route probe ${SUFFIX}`,
			);
		});

		afterAll(async () => {
			restoreFetch();
			await oauth.cleanupOAuth(client ? [client.clientId] : [], [...emails]);
			loaded.restoreEnv();
		});

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		/** A seeded user's email — `seedClub` derives it from the id. */
		const emailOf = (kind: "admin" | "member", userId: string) =>
			`${kind}-${userId}@test.example`;

		/** An access token for a seeded user, via the full grant. */
		async function accessTokenFor(
			kind: "admin" | "member",
			userId: string,
		): Promise<string> {
			const email = emailOf(kind, userId);
			emails.add(email);
			const cookie = await oauth.signInCookie(loaded, email);
			return oauth.mintAccessToken(loaded, client, cookie);
		}

		async function mintPersonalToken(userId: string): Promise<string> {
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
			return raw;
		}

		/**
		 * A JWT signed by GavelUp's REAL key with these claims. Starts from claims a
		 * valid token carries, so each negative case changes exactly one of them —
		 * and `signedWith({})` is the positive control proving the rest is right.
		 */
		async function signedWith(
			overrides: Record<string, unknown>,
		): Promise<string> {
			const now = Math.floor(Date.now() / 1000);
			const { token } = await loaded.auth.api.signJWT({
				body: {
					payload: {
						sub: seed.adminUserId,
						aud: oauth.TEST_RESOURCE,
						iss: oauth.TEST_ISSUER,
						client_id: client.clientId,
						azp: client.clientId,
						jti: randomUUID(),
						iat: now,
						exp: now + 600,
						...overrides,
					},
				},
			});
			return token;
		}

		const whoami = (token: string | null) =>
			handleMcpRequest(mcpRequest(toolsCall("whoami"), { token }));

		// --- AC2: same user, same clubs --------------------------------------

		it("resolves to the same user and clubs as that user's tmk_ token", async () => {
			const accessToken = await accessTokenFor("admin", seed.adminUserId);
			const personal = await mintPersonalToken(seed.adminUserId);

			const viaOAuth = await readToolResult(await whoami(accessToken));
			const viaPersonal = await readToolResult(await whoami(personal));

			expect(viaOAuth.status).toBe(200);
			expect(viaOAuth.isError).toBe(false);
			// The whole payload, not a field: a divergence anywhere — a club missing,
			// a different membershipId, a different `via` — is a second authorization
			// model, which is what the shared resolve exists to prevent.
			expect(viaOAuth.body).toEqual(viaPersonal.body);
			expect(viaOAuth.body).toMatchObject({
				user: { id: seed.adminUserId },
				clubs: [{ clubId: seed.clubId, via: "admin" }],
			});
		});

		it("refuses a flood of forged-kid tokens without a single JWKS fetch, and still serves a real one", async () => {
			// The anonymous denial of service four review passes found: the
			// verifier refetches the JWKS for every unknown `kid`, from this
			// server's own address, so ~21 junk tokens a minute drained the shared
			// rate-limit bucket and the next real refresh failed with a 500.
			const junk = (kid: string) =>
				`${Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid })).toString("base64url")}.e30.c2ln`;
			const before = jwksFetches;
			for (let i = 0; i < 30; i++) {
				const res = await whoami(junk(`forged-${SUFFIX}-${i}`));
				expect(res.status).toBe(401);
				expect(res.headers.get("www-authenticate")).toContain(
					"resource_metadata=",
				);
			}
			expect(jwksFetches - before).toBe(0);
			const r = await readToolResult(await whoami(await signedWith({})));
			expect(r.status).toBe(200);
		});

		it("closes every gate bypass the re-review reproduced, each without a fetch", async () => {
			// Each of these once reached the verifier, which then fetched: a `kid`
			// spelled like the gate's own sentinels, a numeric `kid`, and a token
			// with embedded whitespace that this gate's parser skipped and the
			// verifier's more lenient one still read.
			const header = (h: Record<string, unknown>) =>
				Buffer.from(JSON.stringify({ alg: "EdDSA", ...h })).toString(
					"base64url",
				);
			const before = jwksFetches;
			for (const token of [
				`${header({ kid: "absent" })}.e30.c2ln`,
				`${header({ kid: "malformed" })}.e30.c2ln`,
				`${header({ kid: 12345 })}.e30.c2ln`,
				`${header({ kid: `ws-${SUFFIX}` })}.e 30.AA`,
			]) {
				for (let i = 0; i < 3; i++) {
					const res = await whoami(token);
					expect(res.status, token).toBe(401);
				}
			}
			expect(jwksFetches - before).toBe(0);
		});

		for (const [label, overrides] of [
			["whose subject is the client itself", "client"],
			["that carries no jti", "no-jti"],
		] as const) {
			it(`401s a correctly signed token ${label} — not issued to a person`, async () => {
				const token = await signedWith(
					overrides === "client"
						? { sub: client.clientId }
						: { jti: undefined },
				);
				const res = await whoami(token);
				expect(res.status).toBe(401);
				expect(res.headers.get("www-authenticate")).toContain(
					"resource_metadata=",
				);
				expect(JSON.stringify(await res.json())).toContain(
					"not issued to a person",
				);
			});
		}

		it("the signed-claims helper produces a token the endpoint accepts (control)", async () => {
			// Without this, the three refusals below could pass because `signJWT`
			// makes tokens the verifier rejects for some OTHER reason.
			const r = await readToolResult(await whoami(await signedWith({})));
			expect(r.status).toBe(200);
			expect(r.isError).toBe(false);
		});

		// --- AC3 / AC4: audience, issuer, expiry -----------------------------

		for (const [label, overrides] of [
			["audience is a different resource", { aud: "https://evil.example/mcp" }],
			[
				"audience is the userinfo endpoint alone",
				{ aud: `${oauth.TEST_ISSUER}/oauth2/userinfo` },
			],
			[
				"issuer is a different server",
				{ iss: "https://evil.example/api/auth" },
			],
			[
				"token has expired",
				{
					iat: Math.floor(Date.now() / 1000) - 7200,
					exp: Math.floor(Date.now() / 1000) - 3600,
				},
			],
		] as const) {
			it(`401s with a challenge, and runs no tool, when the ${label}`, async () => {
				const before = await testDb
					.select({ id: roleSlots.id, status: roleSlots.status })
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, seed.meetingId));

				const res = await handleMcpRequest(
					mcpRequest(
						toolsCall("assign_roles", {
							meetingId: seed.meetingId,
							assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
						}),
						{ token: await signedWith(overrides) },
					),
				);
				expect(res.status).toBe(401);
				expect(res.headers.get("www-authenticate")).toContain(
					"resource_metadata=",
				);

				const after = await testDb
					.select({ id: roleSlots.id, status: roleSlots.status })
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, seed.meetingId));
				expect(after).toEqual(before);
			});
		}

		it("401s an access token whose user has since been deleted", async () => {
			// A signed JWT outlives its user until it expires; the FK cascade that
			// makes this unreachable for a `tmk_` token does nothing for it.
			const email = `oauth-gone-${SUFFIX}@example.com`;
			emails.add(email);
			const cookie = await oauth.signInCookie(loaded, email);
			const accessToken = await oauth.mintAccessToken(loaded, client, cookie);
			expect((await whoami(accessToken)).status).toBe(200);

			await testDb.delete(user).where(eq(user.email, email));
			const res = await whoami(accessToken);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toContain(
				"resource_metadata=",
			);
		});

		// --- AC6: no api_tokens write ----------------------------------------

		it("does NOT stamp any api_tokens row on an OAuth call", async () => {
			const personal = await mintPersonalToken(seed.adminUserId);
			const accessToken = await accessTokenFor("admin", seed.adminUserId);

			const r = await readToolResult(await whoami(accessToken));
			expect(r.isError).toBe(false);

			const rows = await testDb
				.select({ lastUsedAt: apiTokens.lastUsedAt })
				.from(apiTokens)
				.where(eq(apiTokens.userId, seed.adminUserId));
			expect(rows).toEqual([{ lastUsedAt: null }]);

			// …and the personal token, used, still is — so the assertion above is
			// about which credential was presented, not a broken stamp.
			await whoami(personal);
			const [stamped] = await testDb
				.select({ lastUsedAt: apiTokens.lastUsedAt })
				.from(apiTokens)
				.where(eq(apiTokens.tokenHash, hashApiToken(personal)));
			expect(stamped?.lastUsedAt).toBeInstanceOf(Date);
		});

		// --- AC5a: every 401 says where to authorize -------------------------

		it("every 401 carries a WWW-Authenticate challenge naming metadata that resolves", async () => {
			const cookieToken = randomUUID();
			await testDb.insert(session).values({
				id: randomUUID(),
				token: cookieToken,
				userId: seed.adminUserId,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
				updatedAt: new Date(),
			});
			const cases: [string, Request][] = [
				["no credential", mcpRequest(toolsCall("whoami"))],
				[
					"a session cookie and no credential",
					mcpRequest(toolsCall("whoami"), {
						cookie: `better-auth.session_token=${cookieToken}`,
					}),
				],
				[
					"a malformed OAuth token",
					mcpRequest(toolsCall("whoami"), { token: "not.a.jwt" }),
				],
				[
					"an unknown tmk_ token",
					mcpRequest(toolsCall("whoami"), { token: "tmk_not_a_real_token" }),
				],
			];
			const challenges = new Set<string>();
			for (const [label, request] of cases) {
				const res = await handleMcpRequest(request);
				expect(res.status, label).toBe(401);
				const header = res.headers.get("www-authenticate");
				expect(header, `${label} had no WWW-Authenticate`).toMatch(
					/^Bearer resource_metadata="[^"]+"/,
				);
				challenges.add(header as string);
			}
			// One value across both branches: the `tmk_` refusal is built in this
			// repo (`oauth-claims.ts`), the others by Better Auth, and a client
			// that reads them must not be told two different things.
			expect([...challenges]).toHaveLength(1);

			// Fetch the URL the challenge names, through the same root route
			// production serves it on. A challenge pointing at a 404 is how a
			// connector dead-ends with no diagnosis.
			const url = /resource_metadata="([^"]+)"/.exec(
				[...challenges][0] ?? "",
			)?.[1];
			expect(url).toBe(
				`${oauth.TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
			);
			const { serveWellKnownDiscovery } = await import(
				"#/lib/well-known-forward"
			);
			const doc = await serveWellKnownDiscovery(
				new Request(url as string),
				loaded.handler,
			);
			expect(doc.status).toBe(200);
			expect((await doc.json()).resource).toBe(oauth.TEST_RESOURCE);
		});

		// --- a write, credited to the right member ---------------------------

		it("applies a write over OAuth and credits it to the token owner's membership", async () => {
			const accessToken = await accessTokenFor("admin", seed.adminUserId);
			const r = await readToolResult(
				await handleMcpRequest(
					mcpRequest(
						toolsCall("assign_roles", {
							meetingId: seed.meetingId,
							assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
						}),
						{ token: accessToken },
					),
				),
			);
			expect(r.isError, r.raw).toBe(false);

			const [slot] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			expect(slot?.assignedMemberId).toBe(seed.memberId);

			const actors = await testDb
				.select({ actorMemberId: activityLog.actorMemberId })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, seed.slotId),
					),
				);
			expect(actors.length).toBeGreaterThan(0);
			expect(actors.every((a) => a.actorMemberId === seed.adminMemberId)).toBe(
				true,
			);
		});

		it("FORBIDs an OAuth user who is a plain member, exactly as a tmk_ token would", async () => {
			const accessToken = await accessTokenFor("member", seed.memberUserId);
			const r = await readToolResult(
				await handleMcpRequest(
					mcpRequest(toolsCall("list_meetings", { clubId: seed.clubId }), {
						token: accessToken,
					}),
				),
			);
			expect(r.isError).toBe(true);
			expect(r.body).toMatchObject({ error: { code: "FORBIDDEN" } });
		});
	},
);
