import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CONTACT_METHODS } from "#/lib/preferred-contact";
import {
	applySetMyPreferredContact,
	loadMyContactPreference,
	type MyContactPreference,
} from "./contact-preference-logic";
import { requireUser } from "./guards";

export type { MyContactPreference } from "./contact-preference-logic";

/**
 * The signed-in member's own contact preference, and the methods they may pick
 * (#1093). Scoped by the session's user id; takes no input.
 */
export const getMyContactPreference = createServerFn({ method: "GET" }).handler(
	async (): Promise<MyContactPreference> => {
		const user = await requireUser();
		return loadMyContactPreference(user.id);
	},
);

const setSchema = z.object({
	preferredContact: z.enum(CONTACT_METHODS).nullable(),
});

/**
 * Set the signed-in member's own preference (#1093). Takes no person or member
 * id: whose preference it is comes from the session alone. Refuses a method
 * their email and phone do not support.
 */
export const setMyPreferredContact = createServerFn({ method: "POST" })
	.validator((i: unknown) => setSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		return applySetMyPreferredContact({
			userId: user.id,
			preferredContact: data.preferredContact,
		});
	});
