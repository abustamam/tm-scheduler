/**
 * Verifies every evaluation-resource URL still serves a PDF.
 *
 * NOT a vitest test, on purpose. It needs the network, and a test that SKIPS
 * when offline is indistinguishable from one that passed — the same shape
 * CLAUDE.md records for the Chrome print gates. A script you either ran or did
 * not.
 *
 * Run it when TI reorganizes their resource library, or periodically:
 *   bun run check:eval-links
 *
 * Declared in `package.json` so it is discoverable from the script list rather
 * than only from this comment. It is deliberately NOT wired into `check`, `test`
 * or CI: it needs the network, and the whole point above is that it is a thing
 * you RAN, not a gate that can quietly skip.
 *
 * All 64 returned `200 application/pdf` when the table was built (2026-08-20),
 * and all 64 again on 2026-08-20 under the magic-byte validation below.
 */
import { EVALUATION_RESOURCES } from "#/lib/evaluation-resources";

const CONCURRENCY = 8;
// TI's CDN rejects a default fetch agent on some paths.
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
// Real PDF files measure 133KB–694KB; 1024 bytes catches placeholders and truncation.
const MIN_PDF_BYTES = 1024;

interface Failure {
	key: string;
	itemCode: string | null;
	url: string;
	reason: string;
}

async function check(url: string): Promise<string | null> {
	try {
		// GET, not HEAD: several of these paths answer HEAD with 405.
		const res = await fetch(url, {
			headers: { "user-agent": UA },
			redirect: "follow",
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			// Release connection before returning.
			await res.body?.cancel();
			return `HTTP ${res.status}`;
		}
		// Read the body to validate it.
		const buf = new Uint8Array(await res.arrayBuffer());

		// Require PDF magic bytes: %PDF-
		const pdfPrefix = buf.slice(0, 5);
		const isPdf =
			pdfPrefix[0] === 0x25 && // %
			pdfPrefix[1] === 0x50 && // P
			pdfPrefix[2] === 0x44 && // D
			pdfPrefix[3] === 0x46 && // F
			pdfPrefix[4] === 0x2d; // -
		if (!isPdf) {
			const actualPrefix = new TextDecoder().decode(pdfPrefix);
			return `not a PDF (body starts with ${JSON.stringify(actualPrefix)})`;
		}

		// Require minimum size to catch placeholders and truncation.
		if (buf.byteLength < MIN_PDF_BYTES) {
			return `suspiciously small (${buf.byteLength} bytes, expected > ${MIN_PDF_BYTES})`;
		}

		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function main() {
	const queue = [...EVALUATION_RESOURCES];
	const failures: Failure[] = [];
	let done = 0;

	async function worker() {
		for (;;) {
			const r = queue.shift();
			if (!r) return;
			const reason = await check(r.url);
			done += 1;
			process.stdout.write(
				`\r  checked ${done}/${EVALUATION_RESOURCES.length}   `,
			);
			if (reason)
				failures.push({
					key: r.key,
					itemCode: r.itemCode,
					url: r.url,
					reason,
				});
		}
	}

	console.log(`Checking ${EVALUATION_RESOURCES.length} evaluation resources…`);
	await Promise.all(
		Array.from({ length: CONCURRENCY }, () => worker()),
	);
	process.stdout.write("\n");

	if (failures.length === 0) {
		console.log(`All ${EVALUATION_RESOURCES.length} links serve a PDF.`);
		return;
	}

	console.error(`\n${failures.length} link(s) failed:\n`);
	for (const f of failures)
		console.error(`  ${f.itemCode ?? f.key}  ${f.reason}\n    ${f.url}`);
	console.error(
		"\nTI moved or retired these. Re-scrape the category and update" +
			" src/lib/evaluation-resources.ts — do not delete a row to make this pass.",
	);
	process.exitCode = 1;
}

await main();
