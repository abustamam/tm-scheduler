/**
 * A member changes their own sign-in address (#1091, ADR-0030), end to end
 * through the REAL `auth.handler`: a magic-link session cookie, the request
 * POST, the link the new inbox receives, the GET page that link opens (which
 * changes nothing), and the POST its button sends.
 *
 * `sendEmail` is mocked so every message is observable: which inbox got what,
 * and in which order relative to the confirm.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/account-email-change.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { activityLog, members, people, user, verification } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));

const oauth = await import("#/test/oauth-flow");
const { sendEmail } = await import("#/lib/email");
const { signEmailChangeToken } = await import("#/lib/change-email-plugin");
const { signJWT } = await import("better-auth/crypto");
const {
	MEMBER_EMAIL_APPLY_PATH,
	MEMBER_EMAIL_CONFIRM_PATH,
	MEMBER_EMAIL_REQUEST_PATH,
	NEEDS_MERGE_MESSAGE,
	RATE_LIMITED_MESSAGE,
} = await import("#/lib/member-email-change");
const {
	EMAIL_CHANGE_LOCK_NAMESPACE,
	requestEmailChange,
	signInEmailStateFor,
	takeEmailChangeRequestSlot,
} = await import("./account-email-change-logic");
const { statementsDuring } = await import("#/test/query-spy");

type Loaded = Awaited<ReturnType<typeof oauth.loadAuthForTest>>;
type Sent = { to: string; subject: string; text: string };

const sent = vi.mocked(sendEmail);
const mails = (): Sent[] =>
	sent.mock.calls.map(([m]) => ({
		to: String(m.to),
		subject: m.subject,
		text: m.text,
	}));

function freshIp(): string {
	const [a, b] = randomBytes(2);
	return `198.19.${a ?? 0}.${1 + ((b ?? 0) % 254)}`;
}

describe.skipIf(!hasTestDb)("changing your own sign-in address (#1091)", () => {
	const SUFFIX = randomBytes(4).toString("hex");
	let loaded: Loaded;
	let secret: string;
	const clubs: SeededClub[] = [];
	const extraUserIds: string[] = [];
	const extraPersonIds: string[] = [];
	const addresses = new Set<string>();
	let n = 0;

	/** A never-used address, lower-case, tracked for cleanup. */
	function addr(label: string): string {
		const a = `chg-${label}-${SUFFIX}-${n++}@test.example`;
		addresses.add(a);
		return a;
	}

	async function freshClub(): Promise<SeededClub> {
		const c = await seedClub();
		clubs.push(c);
		return c;
	}

	async function emailOf(userId: string): Promise<string | undefined> {
		const [row] = await testDb
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, userId));
		return row?.email;
	}

	async function personEmail(personId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, personId));
		return row?.email ?? null;
	}

	async function cookieFor(userId: string): Promise<string> {
		const email = await emailOf(userId);
		if (!email) throw new Error("no such user");
		return oauth.signInCookie(loaded, email);
	}

	function requestChange(
		cookie: string,
		newEmail: string,
		ip: string = freshIp(),
	): Promise<Response> {
		return loaded.handler(
			new Request(`${oauth.TEST_ISSUER}${MEMBER_EMAIL_REQUEST_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: oauth.TEST_ORIGIN,
					cookie,
					"x-real-ip": ip,
				},
				body: JSON.stringify({ newEmail }),
			}),
		);
	}

	/** The confirm link the newest mail to `to` carries. */
	function linkSentTo(to: string): string {
		const mail = [...mails()].reverse().find((m) => m.to === to);
		const url = mail?.text.match(/https?:\/\/\S+member-email\/confirm\S+/)?.[0];
		if (!url) throw new Error(`no confirm link was sent to ${to}`);
		return url;
	}

	/** What a mail scanner or a browser does with the link: a bare GET. */
	function getPage(url: string): Promise<Response> {
		return loaded.handler(
			new Request(url, { headers: { "x-real-ip": freshIp() } }),
		);
	}

	/** The confirm page's button: a form POST of the token. */
	function apply(
		token: string,
		headers: Record<string, string> = { origin: oauth.TEST_ORIGIN },
	): Promise<Response> {
		return loaded.handler(
			new Request(`${oauth.TEST_ISSUER}${MEMBER_EMAIL_APPLY_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-real-ip": freshIp(),
					...headers,
				},
				body: new URLSearchParams({ token }).toString(),
			}),
		);
	}

	function tokenOf(url: string): string {
		return new URL(url).searchParams.get("token") ?? "";
	}

	function unescapeHtml(value: string): string {
		return value
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
	}

	/**
	 * Press the button on a rendered confirm page, the way a browser would:
	 * post exactly the fields of its POST form, to its `action`, with the
	 * page's own Origin. Nothing is taken from the link URL, so a broken
	 * action or a missing hidden input fails here.
	 */
	function submitPage(pageUrl: string, html: string): Promise<Response> {
		const form =
			/<form\b[^>]*\bmethod="post"[^>]*\baction="([^"]*)"[^>]*>([\s\S]*?)<\/form>/i.exec(
				html,
			);
		if (!form) throw new Error("the confirm page has no POST form");
		const action = new URL(unescapeHtml(form[1] ?? ""), pageUrl);
		const fields = new URLSearchParams();
		for (const input of (form[2] ?? "").matchAll(/<input\b[^>]*>/gi)) {
			const name = /\bname="([^"]*)"/.exec(input[0])?.[1];
			const value = /\bvalue="([^"]*)"/.exec(input[0])?.[1] ?? "";
			if (name) fields.append(unescapeHtml(name), unescapeHtml(value));
		}
		return loaded.handler(
			new Request(action, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: new URL(pageUrl).origin,
					"x-real-ip": freshIp(),
				},
				body: fields.toString(),
			}),
		);
	}

	/** A member clicking the link and then the page's button. */
	async function open(url: string): Promise<Response> {
		const page = await getPage(url);
		if (page.status !== 200) return page;
		return submitPage(url, await page.text());
	}

	function outcome(res: Response): string | null {
		const loc = res.headers.get("location");
		return loc
			? new URL(loc, oauth.TEST_ORIGIN).searchParams.get("emailChange")
			: null;
	}

	beforeAll(async () => {
		loaded = await oauth.loadAuthForTest(`nobody-${SUFFIX}@test.example`);
		secret = (await loaded.auth.$context).secret;
	});

	beforeEach(() => {
		sent.mockClear();
	});

	afterAll(async () => {
		const ids = [
			...clubs.flatMap((c) => [c.adminUserId, c.memberUserId]),
			...extraUserIds,
		];
		await testDb
			.delete(verification)
			.where(
				inArray(verification.identifier, [
					...ids.map((id) => `change-email-request:${id}`),
					...ids.map((id) => `change-email-generation:${id}`),
				]),
			);
		for (const c of [...clubs].reverse()) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		if (extraPersonIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, extraPersonIds));
		}
		if (extraUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, extraUserIds));
		}
		// Accounts the magic-link sign-ins created on the way (old-address probe).
		await testDb.delete(user).where(like(user.email, `chg-%-${SUFFIX}-%`));
		loaded.restoreEnv();
	});

	it("writes nothing until the link is clicked, then moves both addresses together", async () => {
		const club = await freshClub();
		const cookie = await cookieFor(club.memberUserId);
		const old = (await emailOf(club.memberUserId)) ?? "";
		const next = addr("happy");
		sent.mockClear();

		const res = await requestChange(cookie, next);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: true });
		expect(await emailOf(club.memberUserId)).toBe(old);
		expect(await personEmail(club.personId)).toBe(old);
		expect(mails().map((m) => m.to)).toEqual([next]);
		// The old address hears nothing before the confirm.
		expect(mails().some((m) => m.to === old)).toBe(false);

		const confirmed = await open(linkSentTo(next));
		expect(confirmed.status).toBe(302);
		expect(outcome(confirmed)).toBe("changed");
		expect(await emailOf(club.memberUserId)).toBe(next);
		expect(await personEmail(club.personId)).toBe(next);

		const notices = mails().filter((m) => m.to === old);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.text).toContain(
			`Your GavelUp sign-in address was changed to ${next}`,
		);
	});

	it("signs in on the new address, and the old one no longer reaches the account", async () => {
		const club = await freshClub();
		const cookie = await cookieFor(club.memberUserId);
		const old = (await emailOf(club.memberUserId)) ?? "";
		const next = addr("signin");
		await requestChange(cookie, next);
		await open(linkSentTo(next));

		const viaNew = await oauth.openMagicLink(loaded, next);
		const session = await loaded.auth.api.getSession({
			headers: new Headers({ cookie: oauth.cookieHeaderFrom(viaNew) }),
		});
		expect(session?.user.id).toBe(club.memberUserId);

		addresses.add(old);
		const viaOld = await oauth.openMagicLink(loaded, old);
		const oldSession = await loaded.auth.api.getSession({
			headers: new Headers({ cookie: oauth.cookieHeaderFrom(viaOld) }),
		});
		expect(oldSession?.user.id).not.toBe(club.memberUserId);
		if (oldSession) extraUserIds.push(oldSession.user.id);
		// …and that fresh account is bound to nobody's Person.
		const bound = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.userId, oldSession?.user.id ?? ""));
		expect(bound).toEqual([]);
	});

	it("normalises case and surrounding whitespace in the new address", async () => {
		const club = await freshClub();
		const cookie = await cookieFor(club.memberUserId);
		const next = addr("case");
		const typed = `  ${next.toUpperCase()}\t`;
		sent.mockClear();
		const res = await requestChange(cookie, typed);
		expect(res.status).toBe(200);
		expect(mails().map((m) => m.to)).toEqual([next]);
		expect(outcome(await open(linkSentTo(next)))).toBe("changed");
		expect(await emailOf(club.memberUserId)).toBe(next);
		expect(await personEmail(club.personId)).toBe(next);
	});

	describe("an address somebody else holds", () => {
		async function expectRefusedAtRequest(
			club: SeededClub,
			taken: string,
		): Promise<void> {
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			sent.mockClear();
			const res = await requestChange(cookie, taken.toUpperCase());
			// Identical to the success case.
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: true });
			const toNew = mails().filter((m) => m.to === taken);
			expect(toNew).toHaveLength(1);
			expect(toNew[0]?.subject).toBe(
				"This address is already in use on GavelUp",
			);
			expect(toNew[0]?.text).not.toMatch(/member-email\/confirm/);
			expect(await emailOf(club.memberUserId)).toBe(old);
		}

		it("is refused when another account signs in with it", async () => {
			const club = await freshClub();
			const other = await freshClub();
			const taken = (await emailOf(other.adminUserId)) ?? "";
			await expectRefusedAtRequest(club, taken);
		});

		it("is refused when another account carries it even though no Person does", async () => {
			// The `user` arm on its own: an account bound to nobody. Without this
			// case the Person arm masks it, since a seeded account's Person
			// carries the same address.
			const club = await freshClub();
			const taken = addr("bare-account");
			const bareId = randomUUID();
			extraUserIds.push(bareId);
			await testDb.insert(user).values({
				id: bareId,
				name: "Bare",
				email: taken,
				emailVerified: true,
			});
			await expectRefusedAtRequest(club, taken);
		});

		it("is refused when another Person bound to an account carries it", async () => {
			const club = await freshClub();
			const other = await freshClub();
			const taken = addr("bound-person");
			// Bound, and on no roster: being bound alone counts.
			const [p] = await testDb
				.insert(people)
				.values({ name: "Bound", email: taken, userId: other.adminUserId })
				.returning({ id: people.id });
			if (p) extraPersonIds.push(p.id);
			await expectRefusedAtRequest(club, taken);
		});

		it("is refused when another unbound Person on a roster carries it", async () => {
			const club = await freshClub();
			const taken = addr("rostered");
			const [p] = await testDb
				.insert(people)
				.values({ name: "Spouse", email: taken })
				.returning({ id: people.id });
			if (!p) throw new Error("no person");
			await testDb.insert(members).values({
				clubId: club.clubId,
				personId: p.id,
				name: "Spouse",
				clubRole: "member",
				status: "active",
			});
			await expectRefusedAtRequest(club, taken);
		});

		it("is NOT refused for a leftover Person on no roster and bound to nobody", async () => {
			const club = await freshClub();
			const free = addr("leftover");
			const [p] = await testDb
				.insert(people)
				.values({ name: "Leftover", email: free })
				.returning({ id: people.id });
			if (p) extraPersonIds.push(p.id);
			const cookie = await cookieFor(club.memberUserId);
			await requestChange(cookie, free);
			expect(outcome(await open(linkSentTo(free)))).toBe("changed");
		});

		it("is refused again at confirm when an account took it after the request", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			const next = addr("late-user");
			await requestChange(cookie, next);
			const link = linkSentTo(next);
			const lateId = randomUUID();
			extraUserIds.push(lateId);
			await testDb
				.insert(user)
				.values({ id: lateId, name: "Late", email: next, emailVerified: true });
			sent.mockClear();

			expect(outcome(await open(link))).toBe("in_use");
			expect(await emailOf(club.memberUserId)).toBe(old);
			expect(await personEmail(club.personId)).toBe(old);
			expect(mails()).toEqual([]);
		});

		it("is refused at confirm when an account takes it DURING the confirm (unique backstop)", async () => {
			// The recheck reads under READ COMMITTED, so an account committed
			// after it ran is invisible to it; `user.email`'s unique index is what
			// refuses the move. Driven as a real interleaving: the sign-up holds
			// its uncommitted row, the confirm's UPDATE parks behind it, then the
			// sign-up commits.
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			const next = addr("race");
			await requestChange(cookie, next);
			const link = linkSentTo(next);
			const racerId = randomUUID();
			extraUserIds.push(racerId);
			const signUp = await openBlockingTx(async (tx) => {
				await tx.insert(user).values({
					id: racerId,
					name: "Racer",
					email: next,
					emailVerified: true,
				});
			});
			sent.mockClear();
			const confirming = open(link);
			await waitForLockWait('update "user"', signUp.pid);
			await signUp.commit();

			expect(outcome(await confirming)).toBe("in_use");
			expect(await emailOf(club.memberUserId)).toBe(old);
			expect(await personEmail(club.personId)).toBe(old);
			expect(mails()).toEqual([]);
		});

		it("is refused again at confirm when a rostered Person took it after the request", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			const next = addr("late-person");
			await requestChange(cookie, next);
			const link = linkSentTo(next);
			const [p] = await testDb
				.insert(people)
				.values({ name: "Typed in", email: next })
				.returning({ id: people.id });
			if (!p) throw new Error("no person");
			await testDb.insert(members).values({
				clubId: club.clubId,
				personId: p.id,
				name: "Typed in",
				clubRole: "member",
				status: "active",
			});
			sent.mockClear();

			expect(outcome(await open(link))).toBe("in_use");
			expect(await emailOf(club.memberUserId)).toBe(old);
			expect(await personEmail(club.personId)).toBe(old);
			expect(mails()).toEqual([]);
		});
	});

	it("an earlier link works until another change lands, then is dead", async () => {
		const club = await freshClub();
		const cookie = await cookieFor(club.memberUserId);
		const first = addr("first");
		const second = addr("second");
		await requestChange(cookie, first);
		const firstLink = linkSentTo(first);
		await requestChange(cookie, second);
		const secondLink = linkSentTo(second);

		expect(outcome(await open(secondLink))).toBe("changed");
		sent.mockClear();
		expect(outcome(await open(firstLink))).toBe("stale");
		expect(await emailOf(club.memberUserId)).toBe(second);
		expect(await personEmail(club.personId)).toBe(second);
		expect(mails()).toEqual([]);
		// The same link replayed after it landed is dead too.
		expect(outcome(await open(secondLink))).toBe("stale");
	});

	it("an unrequested earlier link still works when nothing landed in between", async () => {
		const club = await freshClub();
		const cookie = await cookieFor(club.memberUserId);
		const first = addr("early");
		const second = addr("later");
		await requestChange(cookie, first);
		const firstLink = linkSentTo(first);
		await requestChange(cookie, second);
		expect(outcome(await open(firstLink))).toBe("changed");
		expect(await emailOf(club.memberUserId)).toBe(first);
	});

	it("refuses a forged, foreign or expired token", async () => {
		const club = await freshClub();
		const old = await emailOf(club.memberUserId);
		const claim = {
			userId: club.memberUserId,
			from: old ?? "",
			to: addr("forged"),
			generation: 0,
		};
		const forged = await signEmailChangeToken(claim, "not-the-secret");
		const expired = await signEmailChangeToken(claim, secret, -60);
		// Signed with the REAL secret but minted for another purpose — the shape
		// of every other HS256 token Better Auth signs with it.
		const foreign = await signJWT({ ...claim }, secret, 3600);
		for (const token of [forged, expired, foreign, "garbage"]) {
			const res = await open(
				`${oauth.TEST_ISSUER}${MEMBER_EMAIL_CONFIRM_PATH}?token=${encodeURIComponent(token)}`,
			);
			expect(outcome(res)).toBe("expired");
			// …and posted straight at the button's endpoint, past the page.
			expect(outcome(await apply(token))).toBe("expired");
		}
		expect(await emailOf(club.memberUserId)).toBe(old);
	});

	it("changes only the account whose session asked", async () => {
		const club = await freshClub();
		const adminOld = await emailOf(club.adminUserId);
		const cookie = await cookieFor(club.memberUserId);
		const next = addr("own");
		await requestChange(cookie, next);
		expect(outcome(await open(linkSentTo(next)))).toBe("changed");
		expect(await emailOf(club.memberUserId)).toBe(next);
		expect(await emailOf(club.adminUserId)).toBe(adminOld);
	});

	describe("an account bound to no Person", () => {
		it("sees no control, and the endpoint refuses it", async () => {
			const loneEmail = addr("lone");
			const cookie = await oauth.signInCookie(loaded, loneEmail);
			const session = await loaded.auth.api.getSession({
				headers: new Headers({ cookie }),
			});
			const loneId = session?.user.id ?? "";
			extraUserIds.push(loneId);

			expect(await signInEmailStateFor(loneId)).toEqual({
				email: loneEmail,
				canChange: false,
				needsMerge: false,
			});
			sent.mockClear();
			const res = await requestChange(cookie, addr("lone-next"));
			expect(res.status).toBe(403);
			expect(mails()).toEqual([]);
		});

		it("a bound member does see the control", async () => {
			const club = await freshClub();
			expect(await signInEmailStateFor(club.memberUserId)).toMatchObject({
				canChange: true,
			});
		});
	});

	describe("superadmin follows the address at confirm", () => {
		it("grants when the new address is on the allowlist", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const next = addr("grant");
			const prev = process.env.SUPERADMIN_EMAILS;
			process.env.SUPERADMIN_EMAILS = next;
			try {
				await requestChange(cookie, next);
				expect(outcome(await open(linkSentTo(next)))).toBe("changed");
			} finally {
				process.env.SUPERADMIN_EMAILS = prev;
			}
			const [row] = await testDb
				.select({ s: user.isSuperadmin })
				.from(user)
				.where(eq(user.id, club.memberUserId));
			expect(row?.s).toBe(true);
		});

		it("revokes when the old address was on the allowlist and the new one is not", async () => {
			const club = await freshClub();
			const old = (await emailOf(club.memberUserId)) ?? "";
			const prev = process.env.SUPERADMIN_EMAILS;
			process.env.SUPERADMIN_EMAILS = old;
			try {
				const cookie = await cookieFor(club.memberUserId);
				const [before] = await testDb
					.select({ s: user.isSuperadmin })
					.from(user)
					.where(eq(user.id, club.memberUserId));
				expect(before?.s).toBe(true);
				const next = addr("revoke");
				await requestChange(cookie, next);
				expect(outcome(await open(linkSentTo(next)))).toBe("changed");
			} finally {
				process.env.SUPERADMIN_EMAILS = prev;
			}
			const [row] = await testDb
				.select({ s: user.isSuperadmin })
				.from(user)
				.where(eq(user.id, club.memberUserId));
			expect(row?.s).toBe(false);
		});
	});

	describe("abuse limits", () => {
		it("refuses the fourth request in an hour from one account, even from fresh addresses", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			for (let i = 0; i < 3; i++) {
				const res = await requestChange(cookie, addr(`cap${i}`), freshIp());
				expect(res.status).toBe(200);
			}
			sent.mockClear();
			const fourth = await requestChange(cookie, addr("cap3"), freshIp());
			expect(fourth.status).toBe(429);
			expect((await fourth.json()).message).toBe(RATE_LIMITED_MESSAGE);
			expect(mails()).toEqual([]);
		});

		it("holds the per-account cap under concurrent requests", async () => {
			// Ten at once from ten addresses: without the per-account lock, the
			// count-then-insert lets several read "2" and all insert.
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const statuses = await Promise.all(
				Array.from({ length: 10 }, (_, i) =>
					requestChange(cookie, addr(`par${i}`), freshIp()).then(
						(r) => r.status,
					),
				),
			);
			expect(statuses.filter((s) => s === 200)).toHaveLength(3);
			expect(statuses.filter((s) => s === 429)).toHaveLength(7);
		});

		it("takes the per-account lock before counting", async () => {
			// Deterministic half of the concurrency proof: while another
			// transaction holds this account's lock, a slot-take must WAIT.
			const club = await freshClub();
			const holder = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(${EMAIL_CHANGE_LOCK_NAMESPACE}::int4, hashtext(${club.memberUserId}))`,
				);
			});
			const taking = takeEmailChangeRequestSlot(club.memberUserId);
			await waitForLockWait("pg_advisory_xact_lock", holder.pid);
			await holder.commit();
			expect(await taking).toBe(true);
		});

		it("grants exactly three slots to a burst of twenty", async () => {
			const club = await freshClub();
			const granted = await Promise.all(
				Array.from({ length: 20 }, () =>
					takeEmailChangeRequestSlot(club.memberUserId),
				),
			);
			expect(granted.filter(Boolean)).toHaveLength(3);
		});

		it("refuses the fourth request in an hour from one client address, across accounts", async () => {
			const a = await freshClub();
			const b = await freshClub();
			const ip = freshIp();
			const cookies = [
				await cookieFor(a.adminUserId),
				await cookieFor(a.memberUserId),
				await cookieFor(b.adminUserId),
				await cookieFor(b.memberUserId),
			];
			const statuses: number[] = [];
			for (const [i, cookie] of cookies.entries()) {
				statuses.push((await requestChange(cookie, addr(`ip${i}`), ip)).status);
			}
			expect(statuses).toEqual([200, 200, 200, 429]);
		});
	});

	describe("the link is a page; only its button writes (#1091 review)", () => {
		it("a GET of the link changes nothing and names the new address", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			const next = addr("prefetch");
			await requestChange(cookie, next);
			const link = linkSentTo(next);
			sent.mockClear();

			const page = await getPage(link);
			expect(page.status).toBe(200);
			expect(page.headers.get("content-type")).toMatch(/text\/html/);
			expect(page.headers.get("cache-control")).toBe("no-store");
			const html = await page.text();
			expect(html).toContain(next);
			expect(html).toContain('method="post"');
			// A scanner fetching it twice changes nothing either.
			await getPage(link);
			expect(await emailOf(club.memberUserId)).toBe(old);
			expect(await personEmail(club.personId)).toBe(old);
			expect(mails()).toEqual([]);

			expect(outcome(await submitPage(link, html))).toBe("changed");
			expect(await emailOf(club.memberUserId)).toBe(next);
		});

		it("escapes the address it shows", async () => {
			const club = await freshClub();
			const old = await emailOf(club.memberUserId);
			const token = await signEmailChangeToken(
				{
					userId: club.memberUserId,
					from: old ?? "",
					to: `<script>x</script>@evil.example`,
					generation: 0,
				},
				secret,
			);
			const html = await (
				await getPage(
					`${oauth.TEST_ISSUER}${MEMBER_EMAIL_CONFIRM_PATH}?token=${encodeURIComponent(token)}`,
				)
			).text();
			expect(html).not.toContain("<script>");
			expect(html).toContain("&lt;script&gt;");
		});

		it("refuses the button's POST from another origin, or with none", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			const next = addr("csrf");
			await requestChange(cookie, next);
			const token = tokenOf(linkSentTo(next));

			const attempts: Record<string, string>[] = [
				{ origin: "https://evil.example" },
				{ origin: "null" },
				{},
				// A session cookie does not make a cross-origin POST acceptable.
				{ origin: "https://evil.example", cookie },
			];
			for (const headers of attempts) {
				const res = await apply(token, headers);
				expect(res.status).toBe(403);
			}
			expect(await emailOf(club.memberUserId)).toBe(old);
			expect(outcome(await apply(token))).toBe("changed");
		});
	});

	it("a link replayed after the address went A to B and back to A is dead", async () => {
		const club = await freshClub();
		const cookie = await cookieFor(club.memberUserId);
		const a = (await emailOf(club.memberUserId)) ?? "";
		const b = addr("aba");
		await requestChange(cookie, b);
		const aToB = linkSentTo(b);
		expect(outcome(await open(aToB))).toBe("changed");

		addresses.add(a);
		await requestChange(cookie, a);
		expect(outcome(await open(linkSentTo(a)))).toBe("changed");
		expect(await emailOf(club.memberUserId)).toBe(a);

		sent.mockClear();
		// The account is on A again, which is the old link's `from`: only the
		// change generation can tell this link is from before.
		expect(outcome(await apply(tokenOf(aToB)))).toBe("stale");
		expect(await emailOf(club.memberUserId)).toBe(a);
		expect(mails()).toEqual([]);
	});

	describe("an account bound to two or more Persons (#1091 review)", () => {
		async function bindSecondPerson(club: SeededClub): Promise<void> {
			const [p] = await testDb
				.insert(people)
				.values({
					name: "Duplicate",
					email: await emailOf(club.memberUserId),
					userId: club.memberUserId,
				})
				.returning({ id: people.id });
			if (p) extraPersonIds.push(p.id);
		}

		it("gets no control, and the request is refused with a merge message", async () => {
			const club = await freshClub();
			await bindSecondPerson(club);
			expect(await signInEmailStateFor(club.memberUserId)).toMatchObject({
				canChange: false,
				needsMerge: true,
			});
			const cookie = await cookieFor(club.memberUserId);
			sent.mockClear();
			const res = await requestChange(cookie, addr("dup"));
			expect(res.status).toBe(409);
			expect((await res.json()).message).toBe(NEEDS_MERGE_MESSAGE);
			expect(mails()).toEqual([]);
		});

		it("is refused at confirm when a second Person was bound after the request", async () => {
			const club = await freshClub();
			const cookie = await cookieFor(club.memberUserId);
			const old = await emailOf(club.memberUserId);
			const next = addr("dup-late");
			await requestChange(cookie, next);
			const link = linkSentTo(next);
			await bindSecondPerson(club);
			sent.mockClear();
			expect(outcome(await open(link))).toBe("needs_merge");
			expect(await emailOf(club.memberUserId)).toBe(old);
			expect(await personEmail(club.personId)).toBe(old);
			expect(mails()).toEqual([]);
		});
	});

	describe("a holder stored with Unicode spaces still blocks (#1091 review)", () => {
		it("a rostered Person stored as the address plus a NBSP", async () => {
			const club = await freshClub();
			const taken = addr("nbsp");
			const [p] = await testDb
				.insert(people)
				.values({ name: "Padded", email: `${taken} ` })
				.returning({ id: people.id });
			if (!p) throw new Error("no person");
			await testDb.insert(members).values({
				clubId: club.clubId,
				personId: p.id,
				name: "Padded",
				clubRole: "member",
				status: "active",
			});
			const cookie = await cookieFor(club.memberUserId);
			sent.mockClear();
			await requestChange(cookie, taken);
			expect(mails().find((m) => m.to === taken)?.subject).toBe(
				"This address is already in use on GavelUp",
			);
		});

		it("an account stored as a BOM plus the address", async () => {
			const club = await freshClub();
			const taken = addr("bom");
			const id = randomUUID();
			extraUserIds.push(id);
			await testDb.insert(user).values({
				id,
				name: "Padded",
				email: `﻿${taken}`,
				emailVerified: true,
			});
			const cookie = await cookieFor(club.memberUserId);
			sent.mockClear();
			await requestChange(cookie, taken);
			expect(mails().find((m) => m.to === taken)?.subject).toBe(
				"This address is already in use on GavelUp",
			);
		});
	});

	it("issues the same queries whichever email the request sends (#1091 review)", async () => {
		const club = await freshClub();
		const other = await freshClub();
		const taken = (await emailOf(other.adminUserId)) ?? "";
		const mintLink = vi.fn(async () => "https://link.example/x");
		const statements = await statementsDuring(() =>
			requestEmailChange({
				userId: club.memberUserId,
				newEmail: taken,
				mintLink,
			}),
		);
		// The same work is issued whichever email is sent — not a claim the
		// timing is identical (a LIMIT-1 scan can finish sooner on a hit; that
		// gap is accepted and unmeasured). A link is minted though the in-use
		// email carries none…
		expect(mintLink).toHaveBeenCalledTimes(1);
		// …and both collision arms ran, though the first already answered.
		const collisionReads = statements.filter((q) =>
			q.includes("regexp_replace"),
		);
		expect(collisionReads.some((q) => /from "user"/.test(q))).toBe(true);
		expect(collisionReads.some((q) => /from "people"/.test(q))).toBe(true);
	});

	it("writes one activity entry in every club that holds the member", async () => {
		const club = await freshClub();
		const second = await freshClub();
		const [extra] = await testDb
			.insert(members)
			.values({
				clubId: second.clubId,
				personId: club.personId,
				name: "Member User",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		const old = await emailOf(club.memberUserId);
		const cookie = await cookieFor(club.memberUserId);
		const next = addr("audit");
		await requestChange(cookie, next);
		expect(outcome(await open(linkSentTo(next)))).toBe("changed");

		const entries = await testDb
			.select({
				clubId: activityLog.clubId,
				actor: activityLog.actorMemberId,
				targetId: activityLog.targetId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					inArray(activityLog.clubId, [club.clubId, second.clubId]),
					eq(activityLog.action, "member_edit"),
				),
			);
		const byClub = new Map(entries.map((e) => [e.clubId, e]));
		expect(entries).toHaveLength(2);
		expect(byClub.get(club.clubId)?.actor).toBe(club.memberId);
		expect(byClub.get(second.clubId)?.actor).toBe(extra?.id);
		for (const e of entries) {
			expect(e.targetId).toBe(e.actor);
			expect(e.detail).toMatchObject({
				before: { email: old },
				after: { email: next },
			});
		}
	});
});
