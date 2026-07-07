/**
 * Pure Base Camp progress page-walk for the GavelUp sync extension (#107).
 * No DOM, no browser APIs — fetch is injected so it is unit-testable in Node.
 *
 * All-or-nothing: any page that fails aborts the whole walk (throws). A partial
 * sync would silently leave some members stale, which is worse than a retryable
 * failure — syncClubProgress is idempotent so re-running the whole walk is free.
 */

const BASE = "https://basecamp.toastmasters.org/api/bcm/progress/";

export interface BcmPage {
	results: unknown[];
	next: string | null;
}

/** Minimal shape of a fetch response this walk relies on (real fetch satisfies it). */
interface FetchLike {
	(
		url: string,
		opts: RequestInit,
	): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export async function walkProgressPages(args: {
	fetchImpl: FetchLike;
	guid: string;
	csrftoken: string;
}): Promise<BcmPage[]> {
	const { fetchImpl, guid, csrftoken } = args;
	if (!guid) throw new Error("No Base Camp club selected (missing club GUID).");

	const headers: Record<string, string> = {
		Accept: "application/json",
		"USE-JWT-COOKIE": "true",
		"X-Platform": "pathways",
		"X-CSRFToken": csrftoken || "",
	};

	const pages: BcmPage[] = [];
	let page = 1;
	// Walk sequentially; stop when a page reports no `next`. A hard cap guards
	// against a malformed `next` looping forever.
	for (let guardCap = 0; guardCap < 1000; guardCap++) {
		const url = `${BASE}?club=${encodeURIComponent(guid)}&page=${page}`;
		let res: Awaited<ReturnType<FetchLike>>;
		try {
			res = await fetchImpl(url, { headers, credentials: "include" });
		} catch (err) {
			throw new Error(
				`Base Camp request failed on page ${page}: ${(err as Error).message}`,
			);
		}
		if (!res.ok) {
			throw new Error(`Base Camp returned ${res.status} on page ${page}.`);
		}
		const body = (await res.json()) as BcmPage;
		pages.push(body);
		if (!body || !body.next) break;
		page += 1;
	}
	return pages;
}
