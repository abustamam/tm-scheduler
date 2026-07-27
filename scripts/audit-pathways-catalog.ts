/**
 * Read-only audit of the seed catalog against what Base Camp has actually
 * corroborated (#382).
 *
 * `src/lib/pathways-catalog.ts` was LLM-generated, not transcribed from TI. It
 * doesn't need to be trusted, because `reconcileCatalog`
 * (`src/server/pathways-detail-logic.ts`) grades it on every /detail sync:
 * a seeded project that Base Camp confirms gets its `bcm_block_id` stamped, and
 * a required project we failed to seed gets derived. What reconciliation never
 * does is act on the *absence* — a seeded row Base Camp has never mentioned just
 * sits there forever with a null block id. That absence is this script.
 *
 * Two signals, deliberately reported apart because they mean different things:
 *
 *   SUSPECT     required + no block id, on a path that HAS detail-synced.
 *               Every member enrolled in a path sees all of its required
 *               projects, so if any of them synced and this row is still
 *               unstamped, the seeded name or level is wrong.
 *
 *   UNVERIFIED  elective + no block id. Inconclusive, NOT a finding. Unchosen
 *               electives arrive as placeholders with an empty block id and are
 *               skipped (`src/lib/basecamp-detail.ts`), so an elective is only
 *               corroborated once some member actually picks it. These names can
 *               only be checked by a human against a real source — see #398.
 *
 * Plus SEED GAPS: rows reconciliation had to derive because the seed missed
 * them. Harmless (the system healed itself) but they show where the guess was
 * short, and they're the other half of judging how good the seed was.
 *
 * Usage:
 *   bun run scripts/audit-pathways-catalog.ts
 *
 * Reports only — never writes, always exits 0. Bun auto-loads .env.local for
 * DATABASE_URL. Run it against whichever database has real sync data; on a
 * database that has never synced, every path is skipped and it says so.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { pathwaysPaths, pathwaysProjects } from "#/db/schema";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";

/** `courseCode|level|name` for every project the seed claims. */
const SEEDED = new Set(
	PATHWAYS_CATALOG.flatMap((p) =>
		p.projects.map((proj) => `${p.courseCode}|${proj.level}|${proj.name}`),
	),
);

async function main() {
	const paths = await db
		.select({
			id: pathwaysPaths.id,
			courseCode: pathwaysPaths.courseCode,
			name: pathwaysPaths.name,
			// "Has this path ever detail-synced?" — answered by a stamped
			// bcm_block_id, which ONLY reconcileCatalog writes. The seed always
			// leaves it null.
			//
			// This used to count pathways_path_levels rows, on the reasoning that
			// such a row "exists only once reconcileCatalog has run". #412 broke
			// that by making the seed write min_req_electives to the same table —
			// necessary, since without it a never-synced club silently lost its
			// whole "choose N electives" section. The consequence was that every
			// seeded path looked synced: the first prod run after that shipped
			// reported 11 of 11 detail-synced and 83 SUSPECT rows, 55 of which were
			// the required projects of five paths nobody is enrolled in (#422).
			// Worse than noise — it invites "fixing" catalog entries that are right.
			stampedProjects: sql<number>`count(${pathwaysProjects.id})`,
		})
		.from(pathwaysPaths)
		.leftJoin(
			pathwaysProjects,
			and(
				eq(pathwaysProjects.pathId, pathwaysPaths.id),
				isNotNull(pathwaysProjects.bcmBlockId),
			),
		)
		.groupBy(pathwaysPaths.id, pathwaysPaths.courseCode, pathwaysPaths.name)
		.orderBy(asc(pathwaysPaths.courseCode));

	if (paths.length === 0) {
		console.log(
			"No paths in pathways_paths. Seed first: bun run scripts/seed-pathways-catalog.ts",
		);
		process.exit(0);
	}

	const synced = paths.filter((p) => Number(p.stampedProjects) > 0);
	const unsynced = paths.filter((p) => Number(p.stampedProjects) === 0);

	console.log(
		`Paths: ${paths.length} total · ${synced.length} detail-synced · ${unsynced.length} never detail-synced\n`,
	);

	if (unsynced.length > 0) {
		console.log("SKIPPED — no /detail sync yet, so nothing to check against:");
		for (const p of unsynced) {
			console.log(`  ${p.courseCode}  ${p.name}`);
		}
		console.log("");
	}

	if (synced.length === 0) {
		console.log(
			"Nothing to audit. Run a /detail sync (the extension, or paste at\n" +
				"/admin/pathways-sync) against this database first — the catalog can only\n" +
				"be graded against data Base Camp has actually returned.",
		);
		process.exit(0);
	}

	const pathIds = synced.map((p) => p.id);
	const nameByPathId = new Map(
		synced.map((p) => [p.id, `${p.courseCode} ${p.name}`]),
	);
	const courseCodeByPathId = new Map(synced.map((p) => [p.id, p.courseCode]));

	const uncorroborated = await db
		.select({
			pathId: pathwaysProjects.pathId,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
		})
		.from(pathwaysProjects)
		.where(
			sql`${inArray(pathwaysProjects.pathId, pathIds)} and ${isNull(pathwaysProjects.bcmBlockId)}`,
		)
		.orderBy(
			asc(pathwaysProjects.pathId),
			asc(pathwaysProjects.level),
			asc(pathwaysProjects.name),
		);

	const suspect = uncorroborated.filter((r) => r.isRequired);
	const unverified = uncorroborated.filter((r) => !r.isRequired);

	console.log(`SUSPECT — required, but Base Camp never named it (${suspect.length})`);
	if (suspect.length === 0) {
		console.log(
			"  none. Every required project on a synced path matched a real Base Camp block.\n",
		);
	} else {
		console.log(
			"  Each of these is a seeded name or level that Base Camp does not confirm.\n" +
				"  Fix them in src/lib/pathways-catalog.ts and re-seed.\n",
		);
		for (const r of suspect) {
			console.log(`  ${nameByPathId.get(r.pathId)}  L${r.level}  ${r.name}`);
		}
		console.log("");
	}

	console.log(`UNVERIFIED — elective, nobody has picked it yet (${unverified.length})`);
	console.log(
		"  Inconclusive by construction, not a finding: an unchosen elective never\n" +
			"  arrives from Base Camp, so silence here means nothing either way.\n" +
			"  Verifying these needs a human against a real source — see #398.\n",
	);
	for (const r of unverified) {
		console.log(`  ${nameByPathId.get(r.pathId)}  L${r.level}  ${r.name}`);
	}
	if (unverified.length > 0) console.log("");

	const corroborated = await db
		.select({
			pathId: pathwaysProjects.pathId,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
		})
		.from(pathwaysProjects)
		.where(
			sql`${inArray(pathwaysProjects.pathId, pathIds)} and ${pathwaysProjects.bcmBlockId} is not null`,
		)
		.orderBy(
			asc(pathwaysProjects.pathId),
			asc(pathwaysProjects.level),
			asc(pathwaysProjects.name),
		);

	const derived = corroborated.filter(
		(r) =>
			!SEEDED.has(`${courseCodeByPathId.get(r.pathId)}|${r.level}|${r.name}`),
	);

	console.log(`SEED GAPS — real, but the seed didn't have it (${derived.length})`);
	if (derived.length === 0) {
		console.log(
			"  none. Reconciliation never had to derive a project the seed missed.\n",
		);
	} else {
		console.log(
			"  Reconciliation already added these, so nothing is broken — but they're\n" +
				"  worth folding back into the seed so a fresh database starts complete.\n",
		);
		for (const r of derived) {
			console.log(
				`  ${nameByPathId.get(r.pathId)}  L${r.level}  ${r.name}${r.isRequired ? "  (required)" : ""}`,
			);
		}
		console.log("");
	}

	console.log(
		`Summary: ${corroborated.length} corroborated · ${suspect.length} suspect · ` +
			`${unverified.length} unverified · ${derived.length} seed gaps`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
