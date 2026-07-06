import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./guards";
import {
	type PathViewModel,
	pathwaysForMember,
	pathwaysForUser,
} from "./pathways-read-logic";

/** The signed-in user's own enrolled paths (dashboard tile / "my progress"). */
export const getMyPathways = createServerFn({ method: "GET" }).handler(
	async (): Promise<PathViewModel[]> => {
		const user = await requireUser();
		return pathwaysForUser(user.id);
	},
);

const memberSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
});

/** A roster member's paths (member-detail tab). Public read — roster is auth-decoupled. */
export const getMemberPathways = createServerFn({ method: "GET" })
	.validator((i: unknown) => memberSchema.parse(i))
	.handler(async ({ data }): Promise<PathViewModel[]> => {
		return pathwaysForMember(data.clubId, data.memberId);
	});
