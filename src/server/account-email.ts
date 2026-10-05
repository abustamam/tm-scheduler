import { createServerFn } from "@tanstack/react-start";
import {
	type SignInEmailState,
	signInEmailStateFor,
} from "./account-email-change-logic";
import { requireUser } from "./guards";

export type { SignInEmailState } from "./account-email-change-logic";

/**
 * The signed-in account's sign-in address, and whether Account settings offers
 * to change it (#1091). Only an account bound to a Person gets the control;
 * the request endpoint refuses the rest on its own (`change-email-plugin.ts`).
 * Scoped by the session's user id; takes no input.
 */
export const getSignInEmailState = createServerFn({ method: "GET" }).handler(
	async (): Promise<SignInEmailState> => {
		const user = await requireUser();
		return signInEmailStateFor(user.id);
	},
);
