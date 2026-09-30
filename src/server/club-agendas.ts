/**
 * Server fns for the club's own agendas (#910): the Agendas page, the club's
 * default agenda, and adopting the standard agenda.
 *
 * Exports ONLY `createServerFn`s and types — a plain top-level db-touching
 * export here would drag `#/db` → `pg` into the client bundle. All db logic
 * lives in `club-agendas-logic.ts` (`server-modules.guard.test.ts`).
 *
 * EVERY fn, the read included, goes through `requireClubTemplateEditor`:
 * signed in, club not archived, officer of it. The Agendas page is a
 * management page, not reference content (the issue's "Read gate"). The club
 * and the acting member come from that gate, never from the client; a
 * TEMPLATE id comes from the client and the logic module resolves it against
 * the club inside each write's own query.
 * `meeting-templates-authz.guard.test.ts` sweeps this module for the gate.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	CLUB_TEMPLATE_DESCRIPTION_MAX,
	CLUB_TEMPLATE_NAME_MAX,
} from "#/lib/club-template-key";
import {
	adoptStandardAgenda,
	type ClubAgendaSummary,
	type ClubAgendas,
	deleteClubTemplate,
	duplicateClubTemplate,
	listClubAgendas as listClubAgendasLogic,
	type MeetingRef,
	renameClubTemplate as renameClubTemplateLogic,
	type SetDefaultResult,
	setClubDefaultTemplate as setClubDefaultTemplateLogic,
	setClubTemplateEnabled as setClubTemplateEnabledLogic,
} from "./club-agendas-logic";
import { requireClubTemplateEditor } from "./meeting-templates-logic";

export type { ClubAgendaSummary, ClubAgendas, MeetingRef, SetDefaultResult };

const clubInput = z.object({ clubId: z.string().uuid() });
const templateInput = z.object({
	clubId: z.string().uuid(),
	templateId: z.string().uuid(),
});
/** Loose ceilings on the WIRE, twice the logic's code-point limits, as
 *  `meeting-templates.ts` does: the logic trims, counts and words the refusal. */
const renameInput = z.object({
	clubId: z.string().uuid(),
	templateId: z.string().uuid(),
	name: z.string().max(CLUB_TEMPLATE_NAME_MAX * 2),
	description: z
		.string()
		.max(CLUB_TEMPLATE_DESCRIPTION_MAX * 2)
		.nullable(),
});
const enabledInput = z.object({
	clubId: z.string().uuid(),
	templateId: z.string().uuid(),
	enabled: z.boolean(),
});
const defaultInput = z.object({
	clubId: z.string().uuid(),
	templateId: z.string().uuid().nullable(),
});

/** The club's own templates, which is the default, and whether the club has
 *  adopted (has a default at all). */
export const listClubAgendas = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubInput.parse(input))
	.handler(async ({ data }): Promise<ClubAgendas> => {
		await requireClubTemplateEditor(data.clubId);
		return listClubAgendasLogic(data.clubId);
	});

/** Rename a club template (its key is kept). */
export const renameClubTemplate = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const result = renameInput.safeParse(input);
		if (result.success) return result.data;
		throw new Error("That name is too long.");
	})
	.handler(async ({ data }): Promise<{ ok: true }> => {
		await requireClubTemplateEditor(data.clubId);
		await renameClubTemplateLogic(data);
		return { ok: true };
	});

/** Copy a club template as "Copy of …". */
export const duplicateClubTemplateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => templateInput.parse(input))
	.handler(async ({ data }): Promise<{ templateId: string }> => {
		await requireClubTemplateEditor(data.clubId);
		return duplicateClubTemplate(data);
	});

/** Enable or disable a club template. Refuses disabling the default. */
export const setClubTemplateEnabled = createServerFn({ method: "POST" })
	.validator((input: unknown) => enabledInput.parse(input))
	.handler(async ({ data }): Promise<{ ok: true }> => {
		await requireClubTemplateEditor(data.clubId);
		await setClubTemplateEnabledLogic(data);
		return { ok: true };
	});

/** Delete a club template. `wasDefault` means new meetings are back on the
 *  standard agenda. */
export const deleteClubTemplateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => templateInput.parse(input))
	.handler(async ({ data }): Promise<{ wasDefault: boolean }> => {
		await requireClubTemplateEditor(data.clubId);
		return deleteClubTemplate(data);
	});

/** Set, or clear with `templateId: null`, the club's default agenda, and
 *  report what happened to each upcoming meeting. */
export const setClubDefaultTemplate = createServerFn({ method: "POST" })
	.validator((input: unknown) => defaultInput.parse(input))
	.handler(async ({ data }): Promise<SetDefaultResult> => {
		const { membership } = await requireClubTemplateEditor(data.clubId);
		return setClubDefaultTemplateLogic({
			clubId: data.clubId,
			templateId: data.templateId,
			actorMemberId: membership.id,
		});
	});

/** Make today's standard agenda the club's own, editable default. */
export const adoptStandardAgendaFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubInput.parse(input))
	.handler(async ({ data }): Promise<SetDefaultResult> => {
		const { membership } = await requireClubTemplateEditor(data.clubId);
		return adoptStandardAgenda({
			clubId: data.clubId,
			actorMemberId: membership.id,
		});
	});
