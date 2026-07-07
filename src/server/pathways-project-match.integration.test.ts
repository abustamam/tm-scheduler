/**
 * DB-backed tests for resolving free-text speeches to catalog projects
 * (`resolveSpeechProjects`, Phase 2 / #101).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-project-match.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { pathwaysPaths, pathwaysProjects, people, speeches } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveSpeechProjects } = await import(
	"./pathways-project-match-logic"
);

// Suite-unique courseCode (globally unique column) keeps this suite's path +
// projects disjoint from sibling suites sharing these tables.
const SUITE_TAG = randomUUID().slice(0, 8);
const CODE = `TEST-PM-${SUITE_TAG}`;
// resolveSpeechProjects() matches a speech's free-text pathwayPath against
// pathwaysPaths by NAME, globally (case-insensitively) — it requires exactly
// one match. pathwaysPaths.name is not unique, and pathways-sync.integration
// and pathways-read.integration both insert a path literally named
// "Presentation Mastery" too. Under vitest's parallel file workers, when one
// of those rows coexists with this suite's during the lookup, it returns 2+
// matches and this suite's resolvable speech is (wrongly, but correctly per
// the ambiguity rule) marked unresolved instead of resolved — a real flake
// driven by shared DB state, not just an unscoped assertion query. A
// suite-unique path name keeps that global by-name lookup exact-one
// regardless of what sibling suites are doing concurrently.
const PATH_NAME = `Presentation Mastery ${SUITE_TAG}`;

let pathId: string;
let level3ProjectId: string;
let level1ProjectId: string;
let personId: string;
const createdSpeechIds: string[] = [];

async function makeSpeech(
	over: Partial<typeof speeches.$inferInsert>,
): Promise<string> {
	const id = randomUUID();
	await testDb.insert(speeches).values({
		id,
		personId,
		title: over.title ?? "A Speech",
		...over,
	});
	createdSpeechIds.push(id);
	return id;
}

async function localCleanup() {
	if (createdSpeechIds.length > 0) {
		await testDb.delete(speeches).where(inArray(speeches.id, createdSpeechIds));
		createdSpeechIds.length = 0;
	}
}

describe.skipIf(!hasTestDb)("resolveSpeechProjects", () => {
	beforeAll(async () => {
		const [path] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: CODE, name: PATH_NAME })
			.returning({ id: pathwaysPaths.id });
		pathId = path.id;

		const [p3] = await testDb
			.insert(pathwaysProjects)
			.values({ pathId, level: 3, name: "Persuasive Speaking" })
			.returning({ id: pathwaysProjects.id });
		level3ProjectId = p3.id;

		const [p1] = await testDb
			.insert(pathwaysProjects)
			.values({ pathId, level: 1, name: "Ice Breaker" })
			.returning({ id: pathwaysProjects.id });
		level1ProjectId = p1.id;

		const [person] = await testDb
			.insert(people)
			.values({ name: "Test Speaker" })
			.returning({ id: people.id });
		personId = person.id;
	});

	afterAll(async () => {
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, pathId));
		await testDb.delete(people).where(eq(people.id, personId));
	});

	beforeEach(localCleanup);
	afterEach(localCleanup);

	it("resolves, skips unresolvable, and leaves already-linked/empty speeches untouched", async () => {
		const resolvable = await makeSpeech({
			title: "My Persuasive Speech",
			pathwayPath: PATH_NAME,
			projectName: "Persuasive Speaking",
			projectId: null,
		});
		const badPath = await makeSpeech({
			title: "Wrong Path",
			pathwayPath: "Nonexistent Path",
			projectName: "Persuasive Speaking",
			projectId: null,
		});
		const badProject = await makeSpeech({
			title: "Wrong Project",
			pathwayPath: PATH_NAME,
			projectName: "Totally Made Up Project",
			projectId: null,
		});
		const alreadyLinked = await makeSpeech({
			title: "Already Linked",
			pathwayPath: PATH_NAME,
			projectName: "Ice Breaker",
			projectId: level1ProjectId,
		});
		const noProjectName = await makeSpeech({
			title: "No Project Name",
			pathwayPath: PATH_NAME,
			projectName: null,
			projectId: null,
		});

		const result = await resolveSpeechProjects();

		expect(result.resolved).toBeGreaterThanOrEqual(1);
		expect(result.unresolved).toBeGreaterThanOrEqual(2);

		const rows = await testDb
			.select({ id: speeches.id, projectId: speeches.projectId })
			.from(speeches)
			.where(
				inArray(speeches.id, [
					resolvable,
					badPath,
					badProject,
					alreadyLinked,
					noProjectName,
				]),
			);
		const byId = Object.fromEntries(rows.map((r) => [r.id, r.projectId]));

		expect(byId[resolvable]).toBe(level3ProjectId);
		expect(byId[badPath]).toBeNull();
		expect(byId[badProject]).toBeNull();
		// Untouched — still points at the level 1 project it was already linked to.
		expect(byId[alreadyLinked]).toBe(level1ProjectId);
		expect(byId[noProjectName]).toBeNull();
	});
});
