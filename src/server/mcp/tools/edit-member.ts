/**
 * `edit_member` — an admin corrects one member's name, goes-by name, email or
 * phone (#1563). The connector twin of the roster's member edit (`editMember`),
 * writing through THE SAME WRITER: `applyMemberEdit` (members-logic.ts).
 *
 * The trap the schema sets: `editSchema` requires `name`, and OMITTING
 * `preferredName` CLEARS it (unlike `email`/`phone`, where omitted means leave
 * alone). So a name-only edit would wipe the goes-by name. This tool reads the
 * member's current name and preferredName and sends them whenever the caller
 * did not; `email` and `phone` are forwarded only when the caller sent them.
 *
 * The preview shows each changed field before -> after and names an email
 * refusal (`bound`: the person signed in; `multi_club`: another club holds them)
 * from `emailWriteRefusalFor`. A prediction, not the gate: the writer's own
 * WHERE decides, and when it refuses the email the rest of the edit still saves
 * (`emailRefused` in the result).
 *
 * Authorization: `audience: "officer"` through `authorizeToken` is exactly the
 * set `requireClubRole(..., ["admin"])` admits in the app: a club admin or an
 * open-term officer (`isEffectiveAdmin`, #202). No further gate.
 *
 * The final input is parsed through `editSchema` (the app's own validator), in
 * preview and apply, so a malformed email is a VALIDATION error with nothing
 * written.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import { toStoredPhone } from "#/lib/phone";
import {
	emailWriteRefusalFor,
	normalizeEmail,
} from "#/server/account-link-logic";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import { applyMemberEdit, editSchema } from "#/server/members-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const TOOL = "edit_member";

const inputSchema = {
	clubId: z.string().uuid(),
	memberId: z.string().uuid().describe("The member, from find_people."),
	name: z.string().trim().min(1).max(200).optional(),
	preferredName: z
		.string()
		.trim()
		.max(80)
		.nullable()
		.optional()
		.describe("What they go by. null or blank clears it. Omit to leave it."),
	email: z
		.string()
		.trim()
		.max(320)
		.nullable()
		.optional()
		.describe("Omit to leave it. null or blank clears it."),
	phone: z
		.string()
		.trim()
		.max(40)
		.nullable()
		.optional()
		.describe("Omit to leave it. null or blank clears it."),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const NOT_ON_ROSTER_MESSAGE =
	"That member is not on this club's roster. find_people lists who is.";
export const NOTHING_TO_EDIT_MESSAGE =
	"Pass at least one of name, preferredName, email or phone.";
export const PLAN_STALE_MESSAGE =
	"The member changed since you previewed this. Review the fresh plan and ask the user again.";
export const EMAIL_REFUSED_MESSAGES = {
	bound:
		"This person has signed in, so the email is theirs and was not changed.",
	multi_club:
		"Another club also holds this person, so the email was not changed.",
} as const;

type Field = "name" | "preferredName" | "email" | "phone";
interface Change {
	field: Field;
	before: string | null;
	after: string | null;
}

interface Cur {
	name: string;
	preferredName: string | null;
	personId: string;
	email: string | null;
	phone: string | null;
}

interface Plan {
	memberId: string;
	/** Only fields whose value would differ. */
	changes: Change[];
	/** Set when an email change is requested and the writer would refuse it. */
	emailRefusal: {
		code: keyof typeof EMAIL_REFUSED_MESSAGES;
		message: string;
	} | null;
}

const blankToNull = (v: string | null | undefined) => v?.trim() || null;

async function plan(
	clubId: string,
	memberId: string,
	args: {
		name?: string;
		preferredName?: string | null;
		email?: string | null;
		phone?: string | null;
	},
): Promise<{ plan: Plan; cur: Cur }> {
	const [cur] = await db
		.select({
			name: members.name,
			preferredName: members.preferredName,
			personId: members.personId,
			email: people.email,
			phone: people.phone,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)));
	if (!cur) throw new McpError("NOT_FOUND", NOT_ON_ROSTER_MESSAGE);

	const changes: Change[] = [];
	if (args.name !== undefined && args.name !== cur.name) {
		changes.push({ field: "name", before: cur.name, after: args.name });
	}
	if (args.preferredName !== undefined) {
		const after = blankToNull(args.preferredName);
		if (after !== (cur.preferredName ?? null)) {
			changes.push({
				field: "preferredName",
				before: cur.preferredName ?? null,
				after,
			});
		}
	}
	let emailRefusal: Plan["emailRefusal"] = null;
	if (args.email !== undefined) {
		const after = blankToNull(args.email);
		if (after !== (cur.email ?? null)) {
			// The writer treats a case- or whitespace-only difference as the same
			// address: it writes it for a free person, never for a protected one
			// (bound / multi_club). Predict exactly that.
			const sameAddress = normalizeEmail(after) === normalizeEmail(cur.email);
			const code = await emailWriteRefusalFor(cur.personId, clubId);
			if (!sameAddress && code) {
				emailRefusal = { code, message: EMAIL_REFUSED_MESSAGES[code] };
			}
			if (!(sameAddress && code)) {
				changes.push({ field: "email", before: cur.email ?? null, after });
			}
		}
	}
	if (args.phone !== undefined) {
		const cc = await loadClubDefaultCountryCode(clubId);
		const after = toStoredPhone(args.phone ?? "", cc);
		if (after !== (cur.phone ?? null)) {
			changes.push({ field: "phone", before: cur.phone ?? null, after });
		}
	}
	return { plan: { memberId, changes, emailRefusal }, cur };
}

export const editMemberTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// A write can overwrite or clear a stored name, email or phone.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Edit a member",
		description:
			"Correct one member's name, goes-by name (preferredName), email or " +
			"phone, as a club admin would on the member page. Id from " +
			"find_people. Send only what changes: omitted fields are left as they " +
			"are. Call once WITHOUT planHash to preview: it writes nothing and shows " +
			"each field before and after, and says when an email cannot be changed " +
			"(the person has signed in, or another club holds them), plus a " +
			"planHash. Show the plan to the user in full; after they agree, call " +
			"again with the same input plus the planHash. An email that cannot be " +
			"changed does not block the other fields. GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		if (
			args.name === undefined &&
			args.preferredName === undefined &&
			args.email === undefined &&
			args.phone === undefined
		) {
			throw new McpError("VALIDATION", NOTHING_TO_EDIT_MESSAGE);
		}

		const hashOf = (p: Plan) =>
			planHash({
				tool: TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan: p,
			});
		const view = (p: Plan) => ({ clubId: club.clubId, ...p });

		const memberId = args.memberId.toLowerCase();
		const { plan: p, cur } = await plan(club.clubId, memberId, args);
		// The app's own validator, on the input as it will be written.
		const parsed = editSchema.safeParse({
			clubId: club.clubId,
			memberId,
			name: args.name ?? cur.name,
			preferredName:
				args.preferredName === undefined
					? cur.preferredName
					: blankToNull(args.preferredName),
			...(args.email !== undefined ? { email: args.email } : {}),
			...(args.phone !== undefined ? { phone: blankToNull(args.phone) } : {}),
		});
		if (!parsed.success) {
			throw new McpError(
				"VALIDATION",
				parsed.error.issues
					.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
					.join("; "),
			);
		}
		if (!args.planHash) {
			return { applied: false, plan: view(p), planHash: hashOf(p) };
		}
		if (hashOf(p) !== args.planHash) {
			throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
				plan: view(p),
				planHash: hashOf(p),
			});
		}
		if (p.changes.length === 0) {
			return { applied: true, clubId: club.clubId, plan: view(p), changed: [] };
		}

		// `parsed.data` already carries name and preferredName filled from the
		// member's current values (the schema's trap: omitting one clears it).
		const result = await applyMemberEdit({
			...parsed.data,
			actorMemberId: club.membershipId,
		});
		const emailRefused = result.emailRefused;
		return {
			applied: true,
			clubId: club.clubId,
			changed: p.changes.filter(
				(c) => !(c.field === "email" && emailRefused !== null),
			),
			emailRefused: emailRefused
				? { code: emailRefused, message: EMAIL_REFUSED_MESSAGES[emailRefused] }
				: null,
			note: "GavelUp tells no one. Let the member know yourself if they should hear of this.",
		};
	},
};
