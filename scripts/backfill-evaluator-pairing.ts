/**
 * One-off backfill: link existing Evaluator slots to the Speaker they evaluate
 * (#512).
 *
 * `role_slots.evaluates_slot_id` is now written wherever a speaker/evaluator
 * pair is CREATED, but meetings that already existed when that shipped still
 * have NULL — so their agendas print a generic "Evaluates a speaker" forever.
 * This pairs those up.
 *
 * ## Why this is a separate, cautious pass rather than part of the fix
 *
 * At creation the pairing is unambiguous: `generateSlotRows` emits contiguous
 * `slotIndex` 0..n-1 per role in a single insert, so Speaker N and Evaluator N
 * genuinely correspond. On a meeting edited since, they may not:
 *
 *   - `applyRemoveSpeakerSlot` deletes the highest UNCLAIMED slot of each role
 *     INDEPENDENTLY. A claimed evaluator alongside an unclaimed speaker leaves
 *     e.g. Speaker[0,2] against Evaluator[0,1] — same count, indices that no
 *     longer line up.
 *   - `applyMoveSpeakerSlot` reorders speakers without touching evaluators.
 *
 * So this script pairs ONLY where the evidence is unambiguous, and reports —
 * rather than guesses at — everything else. A wrong link is worse than no link:
 * a blank row reads as "not filled in yet", while "Evaluates Priya Nair" next
 * to the wrong speaker is a confident lie on a printed agenda.
 *
 * ## What counts as unambiguous
 *
 * Per meeting, for the club's paired Speaker/Evaluator roles:
 *   1. Both roles have at least one slot.
 *   2. The two slot counts are equal.
 *   3. Both index sets are contiguous from 0 (`0..n-1`, no gaps).
 *   4. No evaluator in that meeting is already linked.
 *
 * All four hold ⇒ pair by index. Any fail ⇒ skip the whole meeting and say why.
 *
 * Already-linked meetings are skipped, not rewritten, so this is idempotent and
 * safe to re-run. It never clears an existing link.
 *
 * Usage:
 *   bun run scripts/backfill-evaluator-pairing.ts           # dry run (default)
 *   bun run scripts/backfill-evaluator-pairing.ts --apply   # write the links
 *
 * Bun auto-loads .env.local for DATABASE_URL. Point it at prod deliberately.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, roleDefinitions, roleSlots } from "#/db/schema";
import { pickSpeakerAndEvaluatorRoles } from "#/lib/meeting-roles";

const APPLY = process.argv.includes("--apply");

type SkipReason =
	| "no speaker or evaluator slots"
	| "counts differ"
	| "indices not contiguous"
	| "already linked";

async function main() {
	console.log(
		APPLY ? "MODE: apply (writing links)\n" : "MODE: dry run (no writes)\n",
	);

	const clubRows = await db.select({ id: clubs.id, name: clubs.name }).from(clubs);

	let paired = 0;
	let meetingsPaired = 0;
	const skipped = new Map<SkipReason, string[]>();
	const note = (reason: SkipReason, what: string) => {
		const list = skipped.get(reason) ?? [];
		list.push(what);
		skipped.set(reason, list);
	};

	for (const club of clubRows) {
		const defs = await db
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.id));

		let speakerRoleId: string;
		let evaluatorRoleId: string | null;
		try {
			({ speakerRoleId, evaluatorRoleId } = pickSpeakerAndEvaluatorRoles(defs));
		} catch {
			// A club with no identifiable speaker role has nothing to pair.
			continue;
		}
		if (!evaluatorRoleId) continue;

		const clubMeetings = await db
			.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.clubId, club.id));

		for (const meeting of clubMeetings) {
			const slots = await db
				.select({
					id: roleSlots.id,
					roleDefinitionId: roleSlots.roleDefinitionId,
					slotIndex: roleSlots.slotIndex,
					evaluatesSlotId: roleSlots.evaluatesSlotId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, meeting.id));

			const date = meeting.scheduledAt.toISOString().slice(0, 10);
			const where = `${club.name} ${date}`;

			const speakers = slots
				.filter((s) => s.roleDefinitionId === speakerRoleId)
				.sort((a, b) => a.slotIndex - b.slotIndex);
			const evaluators = slots
				.filter((s) => s.roleDefinitionId === evaluatorRoleId)
				.sort((a, b) => a.slotIndex - b.slotIndex);

			if (speakers.length === 0 || evaluators.length === 0) {
				note("no speaker or evaluator slots", where);
				continue;
			}
			if (evaluators.some((e) => e.evaluatesSlotId !== null)) {
				note("already linked", where);
				continue;
			}
			if (speakers.length !== evaluators.length) {
				note(
					"counts differ",
					`${where} (${speakers.length} speakers, ${evaluators.length} evaluators)`,
				);
				continue;
			}
			const contiguous = (xs: { slotIndex: number }[]) =>
				xs.every((x, i) => x.slotIndex === i);
			if (!contiguous(speakers) || !contiguous(evaluators)) {
				note(
					"indices not contiguous",
					`${where} (speakers ${speakers.map((s) => s.slotIndex).join(",")}; ` +
						`evaluators ${evaluators.map((e) => e.slotIndex).join(",")})`,
				);
				continue;
			}

			meetingsPaired++;
			for (const [i, evaluator] of evaluators.entries()) {
				const speaker = speakers[i];
				paired++;
				if (!APPLY) continue;
				await db
					.update(roleSlots)
					.set({ evaluatesSlotId: speaker.id })
					.where(eq(roleSlots.id, evaluator.id));
			}
		}
	}

	console.log(
		`${APPLY ? "Linked" : "Would link"} ${paired} evaluator slot(s) across ` +
			`${meetingsPaired} meeting(s).\n`,
	);

	if (skipped.size > 0) {
		console.log("Skipped (left untouched, no guess made):");
		for (const [reason, items] of skipped) {
			console.log(`\n  ${reason} — ${items.length}`);
			// "already linked" is the expected bulk on a re-run; don't wall the
			// terminal with it. The other reasons are the ones worth eyeballing.
			const show = reason === "already linked" ? 3 : items.length;
			for (const item of items.slice(0, show)) console.log(`    ${item}`);
			if (items.length > show) {
				console.log(`    … and ${items.length - show} more`);
			}
		}
		console.log("");
	}

	if (!APPLY && paired > 0) {
		console.log("Re-run with --apply to write these links.");
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
