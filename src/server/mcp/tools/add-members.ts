/**
 * `add_members` — an admin adds new members to the roster (#1563). The
 * connector twin of Roster -> "+ Add member" (`bulkImportMembers`), and it
 * writes through THE SAME WRITER: `applyBulkImport` (members-logic.ts), which
 * dedupes against the live roster with `buildImportPreview`, inserts each Person
 * and membership with `insertRosterMember` and logs `member_add` crediting the
 * caller. There is no second insert path here.
 *
 * Decision (triage on #1563): a misspelled name must never become a silent
 * second Person. A row `buildImportPreview` would import, whose name the shared
 * matcher (`#/lib/person-search`) finds close to an existing roster member in
 * either direction, is `ambiguous`; it lands only when the call names it in
 * `confirmNew`. The matcher is prefix/substring, not fuzzy ("John" and "John
 * Smith" collide, "Jon Smyth" does not), so the model must still ask the user.
 *
 * Authorization: `audience: "officer"` through `authorizeToken` is exactly the
 * set `requireClubRole(..., ["admin"])` admits in the app: a club admin or an
 * open-term officer (`isEffectiveAdmin`, #202). No further gate.
 *
 * "Ambiguous" is wider than the matcher: a row that shares any whole name word
 * (length >= 2) with a roster member's name or goes-by name is ambiguous too, so
 * "Jon Smith" next to "John Smith" is never a silent second Person.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import { matchTier } from "#/lib/person-search";
import { toStoredPhone } from "#/lib/phone";
import { buildImportPreview } from "#/lib/roster-import";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import { applyBulkImport } from "#/server/members-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const TOOL = "add_members";
const MAX_ROWS = 100;
const MAX_MATCHES = 3;

const inputSchema = {
	clubId: z.string().uuid(),
	rows: z
		.array(
			z.object({
				name: z.string().trim().min(1).max(200),
				email: z.string().trim().max(320).optional(),
				phone: z.string().trim().max(40).optional(),
			}),
		)
		.min(1)
		.max(MAX_ROWS)
		.describe("The people to add, each a name with an optional email/phone."),
	confirmNew: z
		.array(z.string())
		.max(MAX_ROWS)
		.optional()
		.describe(
			"Names of ambiguous rows the USER confirmed are new people, spelled as in rows. Never fill this on your own.",
		),
	startOrientation: z
		.boolean()
		.optional()
		.describe("true starts the new-member checklist. Omit otherwise."),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const PLAN_STALE_MESSAGE =
	"The plan changed since you previewed this (the roster, or which names you confirmed in confirmNew). Preview again with the same input, show the fresh plan, and ask the user again.";

type Verdict = "would_add" | "skipped" | "ambiguous";
type SkipReason = "already_on_roster" | "invalid_email";

interface PlanRow {
	index: number;
	name: string;
	email: string | null;
	phone: string | null;
	verdict: Verdict;
	reason: string;
	skipReason: SkipReason | null;
	possibleMatches: { memberId: string; name: string }[];
	/** Ambiguous only: the call listed this row in `confirmNew`. */
	confirmed: boolean;
}

const fold = (s: string) => s.trim().toLowerCase();

/** Whole words of a name, case-folded, length >= 2. */
const wordsOf = (s: string | null | undefined) =>
	fold(s ?? "")
		.split(/\s+/)
		.filter((w) => w.length >= 2);

function sharesWord(
	name: string,
	m: { name: string; preferredName: string | null },
) {
	const mine = new Set(wordsOf(name));
	return [...wordsOf(m.name), ...wordsOf(m.preferredName)].some((w) =>
		mine.has(w),
	);
}

function skipReasonOf(issues: string[]): SkipReason {
	if (issues.includes("invalid-email")) return "invalid_email";
	return "already_on_roster";
}

const SKIP_TEXT: Record<SkipReason, string> = {
	already_on_roster:
		"skipped: already on the roster (or repeated in this call)",
	invalid_email: "skipped: the email address is not valid",
};

async function planRows(
	clubId: string,
	rows: z.infer<typeof inputSchema.rows>,
	confirmNew: Set<string>,
): Promise<PlanRow[]> {
	const roster = await db
		.select({
			id: members.id,
			name: members.name,
			preferredName: members.preferredName,
			email: people.email,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.clubId, clubId));
	const cc = await loadClubDefaultCountryCode(clubId);
	const preview = buildImportPreview(
		rows.map((r) => ({
			name: r.name,
			email: r.email ?? "",
			phone: r.phone ?? "",
			office: "",
		})),
		roster,
	);
	return preview.map((p, index) => {
		const base = {
			index,
			name: p.name.trim(),
			email: p.email.trim() || null,
			// As it will be STORED, so a changed club country code makes a hash stale.
			phone: toStoredPhone(p.phone, cc),
			possibleMatches: [] as PlanRow["possibleMatches"],
			confirmed: false,
		};
		if (!p.willImport) {
			const skipReason = skipReasonOf(p.issues);
			return {
				...base,
				verdict: "skipped" as const,
				reason: SKIP_TEXT[skipReason],
				skipReason,
			};
		}
		const close = roster
			.filter(
				(m) =>
					matchTier(base.name, m) !== null ||
					matchTier(m.name, { name: base.name }) !== null ||
					sharesWord(base.name, m),
			)
			.slice(0, MAX_MATCHES);
		if (close.length === 0) {
			return {
				...base,
				verdict: "would_add" as const,
				reason: "would add",
				skipReason: null,
			};
		}
		return {
			...base,
			verdict: "ambiguous" as const,
			reason: `ambiguous: possible match for ${close.map((m) => m.name).join(", ")}. Ask the user whether this is someone new; if so, PREVIEW AGAIN with the name in confirmNew, then apply with that new planHash.`,
			skipReason: null,
			possibleMatches: close.map((m) => ({ memberId: m.id, name: m.name })),
			confirmed: confirmNew.has(fold(base.name)),
		};
	});
}

const lands = (r: PlanRow) =>
	r.verdict === "would_add" || (r.verdict === "ambiguous" && r.confirmed);

const summarize = (rows: PlanRow[]) => ({
	wouldAdd: rows.filter((r) => r.verdict === "would_add").length,
	skipped: rows.filter((r) => r.verdict === "skipped").length,
	ambiguous: rows.filter((r) => r.verdict === "ambiguous").length,
	confirmedNew: rows.filter((r) => r.verdict === "ambiguous" && r.confirmed)
		.length,
});

export const addMembersTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// Adds people and never changes or removes one; repeating the call finds the
	// rows already on the roster and skips them, but it is not declared idempotent.
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
	},
	config: {
		title: "Add members to the roster",
		description:
			"Add one or more new members (name, optional email and phone) as a club " +
			"admin would with Roster -> Add member. Call once WITHOUT " +
			"planHash to preview: it writes nothing and lists, per row, would_add, " +
			"skipped (already on the roster) or ambiguous (a possible match for an " +
			"existing member), plus a planHash. An ambiguous row is NEVER added " +
			"unless the user confirmed it is a new person and you list its name in " +
			"confirmNew: ask the user, never guess. confirmNew is part of the plan, " +
			"so after the user confirms a name, PREVIEW AGAIN (no planHash) with " +
			"confirmNew filled, show that plan, and apply with THAT new planHash; " +
			"an old planHash with confirmNew added is PLAN_STALE. Show the plan in " +
			"full; after they agree, call again with the same input plus the " +
			"planHash. New " +
			"members are active with no office. Pass startOrientation true only if " +
			"asked. GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		const confirmNew = new Set((args.confirmNew ?? []).map(fold));

		const hashOf = (rows: PlanRow[]) =>
			planHash({
				tool: TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan: {
					startOrientation: args.startOrientation === true,
					confirmNew: [...confirmNew].sort(),
					rows,
				},
			});
		const view = (rows: PlanRow[]) => ({
			clubId: club.clubId,
			summary: summarize(rows),
			rows,
		});

		const rows = await planRows(club.clubId, args.rows, confirmNew);
		if (!args.planHash) {
			return { applied: false, plan: view(rows), planHash: hashOf(rows) };
		}
		if (hashOf(rows) !== args.planHash) {
			throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
				plan: view(rows),
				planHash: hashOf(rows),
			});
		}

		const toAdd = rows.filter(lands);
		const result =
			toAdd.length === 0
				? { insertedIds: [] as string[], inserted: 0 }
				: await applyBulkImport({
						clubId: club.clubId,
						rows: toAdd.map((r) => ({
							name: r.name,
							email: r.email ?? "",
							phone: r.phone ?? "",
							office: "",
						})),
						startOrientation: args.startOrientation === true,
						actorMemberId: club.membershipId,
					});
		return {
			applied: true,
			clubId: club.clubId,
			added: result.inserted,
			addedMemberIds: result.insertedIds,
			notAdded: rows.filter((r) => !lands(r)),
			// Planned but not inserted: a row became a duplicate between plan and write.
			skippedAtWrite: toAdd.length - result.inserted,
			...(toAdd.length > result.inserted
				? {
						skippedAtWriteNote:
							"Some planned rows were not added because they became duplicates while writing. Preview again to see the roster as it is now.",
					}
				: {}),
			note: "GavelUp tells no one. Let the new members know yourself.",
		};
	},
};
