// Treasurer membership-dues server fns (#206). Thin `createServerFn` wrappers
// ONLY — all db logic lives in `dues-logic.ts` so the Start compiler strips it
// from the client bundle (enforced by `server-modules.guard.test.ts`).
//
// Every fn is gated to clubRole "admin". Treasurer / President already resolve to
// "admin" (effective-admin: any open officer term passes `requireClubRole`
// admin — see guards.ts / #202), so this covers the Treasurer without a new role.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	createDuesPeriod as createDuesPeriodDb,
	createDuesPeriodSchema,
	deleteDuesPeriod as deleteDuesPeriodDb,
	deleteDuesPeriodSchema,
	getDuesForPeriod as getDuesForPeriodDb,
	getDuesOverview as getDuesOverviewDb,
	recordDuesPayment as recordDuesPaymentDb,
	recordPaymentSchema,
	undoDues as undoDuesDb,
	undoSchema,
	updateDuesPeriod as updateDuesPeriodDb,
	updateDuesPeriodSchema,
	waiveDues as waiveDuesDb,
	waiveSchema,
} from "./dues-logic";
import { requireClubRole, requireUser } from "./guards";

const clubScoped = z.object({ clubId: z.string().uuid() });
const periodScoped = z.object({
	clubId: z.string().uuid(),
	periodId: z.string().uuid(),
});

export const getDuesOverview = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return getDuesOverviewDb(data.clubId);
	});

export const getDuesForPeriod = createServerFn({ method: "GET" })
	.validator((i: unknown) => periodScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return getDuesForPeriodDb(data.clubId, data.periodId);
	});

export const createDuesPeriod = createServerFn({ method: "POST" })
	.validator((i: unknown) => createDuesPeriodSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return createDuesPeriodDb(data);
	});

export const updateDuesPeriod = createServerFn({ method: "POST" })
	.validator((i: unknown) => updateDuesPeriodSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return updateDuesPeriodDb(data);
	});

export const deleteDuesPeriod = createServerFn({ method: "POST" })
	.validator((i: unknown) => deleteDuesPeriodSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return deleteDuesPeriodDb(data);
	});

export const recordDuesPayment = createServerFn({ method: "POST" })
	.validator((i: unknown) => recordPaymentSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return recordDuesPaymentDb(data);
	});

export const waiveDues = createServerFn({ method: "POST" })
	.validator((i: unknown) => waiveSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return waiveDuesDb(data);
	});

export const undoDues = createServerFn({ method: "POST" })
	.validator((i: unknown) => undoSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return undoDuesDb(data);
	});
