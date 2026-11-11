/**
 * `set_my_contact_preference` — the caller says how THEY prefer to be reached
 * (#1570). The member-audience twin of the account card's
 * `setMyPreferredContact`, and it writes through the same writer:
 * `applySetMyPreferredContact`, which updates the token owner's own Person and
 * records `contact_preference_by = 'member'`.
 *
 * `audience: "member"`. WHO is written comes from the credential alone: the
 * input has no member, person or club id, because the preference lives on the
 * Person, not on a membership. The officer tool `set_contact_preference` is a
 * different writer and is not touched.
 *
 * The preview READS the writer's own two refusals (no linked Person, a method
 * the Person has no contact detail for) through `loadMyContactPreference`; it is
 * a prediction, never the gate. The apply recomputes, compares the `planHash`
 * (`PLAN_STALE` on drift), refuses on a refusal (`BLOCKED`), and then lets the
 * writer decide. GavelUp messages no one.
 */
import { z } from "zod";
import { planHash } from "#/lib/mcp-plan";
import {
	CONTACT_METHOD_UNAVAILABLE_MESSAGE,
	CONTACT_METHODS,
	type ContactMethod,
} from "#/lib/preferred-contact";
import { mayUseConnector } from "#/server/connector-eligibility";
import {
	applySetMyPreferredContact,
	loadMyContactPreference,
	NO_LINKED_PERSON_MESSAGE,
} from "#/server/contact-preference-logic";
import { authenticateToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const TOOL = "set_my_contact_preference";

const inputSchema = {
	preferredContact: z
		.enum(CONTACT_METHODS)
		.nullable()
		.describe("How the caller wants to be reached, or null for no preference."),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const MY_CONTACT_PLAN_STALE_MESSAGE =
	"Your contact details or preference changed since you previewed this. Review the fresh plan and ask the user again.";

interface Refusal {
	code: "no_linked_person" | "method_unavailable";
	message: string;
}

async function planMine(userId: string, after: ContactMethod | null) {
	const mine = await loadMyContactPreference(userId);
	let refusal: Refusal | null = null;
	if (!mine.linked) {
		refusal = { code: "no_linked_person", message: NO_LINKED_PERSON_MESSAGE };
	} else if (after !== null && !mine.available.includes(after)) {
		refusal = {
			code: "method_unavailable",
			message: CONTACT_METHOD_UNAVAILABLE_MESSAGE,
		};
	}
	return {
		before: mine.preferredContact,
		after,
		available: mine.available,
		unchanged: mine.linked && mine.preferredContact === after,
		refusal,
	};
}

export const setMyContactPreferenceTool: McpToolDefinition = {
	name: TOOL,
	audience: "member",
	// Setting the same method again changes nothing more; null removes one.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Set my preferred contact method",
		description:
			"Set how the caller prefers to be contacted by their clubs (email, call, " +
			"sms, whatsapp, or null for no preference), as they would on their " +
			"account page. Always the person this token belongs to; it takes no " +
			"member or club id. Call once WITHOUT planHash to preview: it writes " +
			"nothing and returns before and after, the methods they can pick, and " +
			"a refusal when they have no linked member record or no phone or email " +
			"for that method, plus a planHash. Show it to the user, and only after " +
			"they agree call again with the same input plus the planHash. GavelUp " +
			"messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		// User-scoped, not club-scoped (the preference is on the Person), so the
		// waiver in mcp-authz.guard.test.ts applies; like `get_my_feedback` it
		// re-checks `mayUseConnector` on every call, so a person who has left
		// their last open club loses this tool with the others.
		const { user } = await authenticateToken(ctx);
		if (!(await mayUseConnector(user.id))) {
			throw new McpError(
				"FORBIDDEN",
				"You are no longer an active member of an open club.",
			);
		}

		const plan = await planMine(user.id, args.preferredContact);
		const hash = planHash({
			tool: TOOL,
			// The preference is on the Person, not a club.
			clubId: "",
			userId: user.id,
			plan,
		});
		if (!args.planHash) {
			return { applied: false, plan, planHash: hash, blocking: plan.refusal };
		}
		if (hash !== args.planHash) {
			throw new McpError("PLAN_STALE", MY_CONTACT_PLAN_STALE_MESSAGE, {
				plan,
				planHash: hash,
			});
		}
		if (plan.refusal) {
			throw new McpError("BLOCKED", plan.refusal.message, {
				blocking: [plan.refusal],
			});
		}
		// The writer's own UPDATE is the gate; a race it loses throws its message.
		await applySetMyPreferredContact({
			userId: user.id,
			preferredContact: args.preferredContact,
		});
		return {
			applied: true,
			preferredContact: args.preferredContact,
			note: "GavelUp tells no one.",
		};
	},
};
