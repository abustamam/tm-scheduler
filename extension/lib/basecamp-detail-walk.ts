/**
 * Pure Base Camp /detail fan-out for the GavelUp sync extension (#120). No DOM,
 * no browser APIs — fetch is injected so it is unit-testable in Node.
 *
 * Graceful per-call (unlike the all-or-nothing summary walk): a failed /detail
 * call omits that member from the batch — their count-based data still synced
 * from the summary, and the next sync retries. One bad call never aborts sync.
 */
const DETAIL_BASE = "https://basecamp.toastmasters.org/api/bcm/progress";

interface FetchLike {
	(
		url: string,
		opts: RequestInit,
	): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface DetailTarget {
	basecampUserId: string; // numeric user.id (string)
	guid: string; // user.username — the ?user= param
	courseId: string;
}

/** Payload POSTed to /api/pathways/ingest under `details`. */
export interface DetailPayload {
	basecampUserId: string;
	courseId: string;
	blocks: unknown;
	speeches: unknown;
}

interface RawRow {
	user?: { id?: number | string; username?: string };
	course_id?: string;
}
interface RawPage {
	results: unknown[];
}

export function extractDetailTargets(pages: RawPage[]): DetailTarget[] {
	const targets: DetailTarget[] = [];
	for (const page of pages) {
		for (const row of page.results as RawRow[]) {
			const id = row.user?.id;
			const guid = row.user?.username;
			const courseId = row.course_id;
			if (id == null || !guid || !courseId) continue;
			targets.push({ basecampUserId: String(id), guid, courseId });
		}
	}
	return targets;
}

async function fetchOne(
	fetchImpl: FetchLike,
	target: DetailTarget,
	csrftoken: string,
): Promise<DetailPayload | null> {
	const url = `${DETAIL_BASE}/${encodeURIComponent(target.courseId)}/detail?user=${encodeURIComponent(target.guid)}&page_size=5000`;
	try {
		const res = await fetchImpl(url, {
			headers: {
				Accept: "application/json",
				"USE-JWT-COOKIE": "true",
				"X-Platform": "pathways",
				"X-CSRFToken": csrftoken || "",
			},
			credentials: "include",
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { blocks?: unknown; speeches?: unknown };
		return {
			basecampUserId: target.basecampUserId,
			courseId: target.courseId,
			blocks: body.blocks ?? { type: "course", children: [] },
			speeches: body.speeches ?? {},
		};
	} catch {
		return null; // graceful: omit this member
	}
}

/** Fan out with bounded concurrency; omit any target that fails. */
export async function fetchDetails(args: {
	fetchImpl: FetchLike;
	targets: DetailTarget[];
	csrftoken: string;
	concurrency?: number;
}): Promise<DetailPayload[]> {
	const { fetchImpl, targets, csrftoken, concurrency = 3 } = args;
	const out: DetailPayload[] = [];
	let cursor = 0;

	async function worker() {
		while (cursor < targets.length) {
			const target = targets[cursor++];
			const payload = await fetchOne(fetchImpl, target, csrftoken);
			if (payload) out.push(payload);
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, targets.length) },
		worker,
	);
	await Promise.all(workers);
	return out;
}
