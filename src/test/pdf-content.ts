/**
 * Read the parts of a PDF that its LAYOUT decides, and none of the parts each
 * RENDER decides (#515).
 *
 * ## Why this exists
 *
 * `public/role-sheets/*.pdf` are build artifacts of `src/server/role-sheet-layout.ts`,
 * produced by `bun run build:role-sheets` and committed. Nothing verified that
 * the two agreed, and they have already disagreed in production twice: #507
 * shipped five sheets printing "Amber" while the layout said "Yellow", and
 * `ah-counter.pdf` shipped a table column ~1.25× wider than the layout's nine
 * equal columns — a difference no amount of asserting on the in-memory document
 * can see, because the file on disk is what `/resources` actually serves.
 *
 * ## What this compares
 *
 * The DECOMPRESSED content streams: every drawing operator react-pdf emitted —
 * glyphs, colours, line widths, coordinates — plus page count, page size, and
 * the fonts the document declares. That is a strict superset of the extracted
 * text #515 proposed, so it also catches a purely visual change (a colour, a
 * border, a column width) that leaves the wording alone. `ah-counter.pdf` was
 * exactly that shape, so the cheaper text comparison would have passed it.
 *
 * Deliberately NOT compared: `/CreationDate`, the trailer `/ID`, the xref table,
 * object offsets, and the compressed stream bytes. Each is a property of the
 * render, not of the layout.
 *
 * ## A normalised byte diff would also work — read this before ruling it out
 *
 * An earlier version of this comment claimed a byte-level CI step
 * (`build:role-sheets` then `git diff --exit-code`) could not be made stable,
 * citing `timer.pdf`'s content stream compressing to 4838 bytes committed
 * against 4472 fresh. **That reading was wrong**, and review caught it. The gap
 * was a STALE CORPUS, not entropy: all five committed streams were uniformly
 * LARGER than a fresh render of byte-identical inflated content (timer
 * 4838→4472, ah-counter 6661→4864, grammarian 2368→2245, ballot-counter
 * 3258→2813, general-evaluator 2028→1933). One-directional across every file is
 * a compressor-settings change, and `@react-pdf/pdfkit@5.1.1` imports one-shot
 * `node:zlib` today. Re-measured after re-rendering all five:
 *
 * - Two fresh renders in one process produce byte-identical compressed streams.
 * - Normalising ONLY `/CreationDate` and the trailer `/ID` — both fixed-length,
 *   so no offset shifts — makes a fresh render byte-identical to the committed
 *   file, for all five sheets.
 *
 * So the alternative is viable and nobody should be told otherwise. This gate
 * stays the one that runs for four reasons that survive the correction: it is
 * already inside `bun run test` and needs no workflow step, it names the
 * OPERATOR that changed instead of saying two binaries differ, it is indifferent
 * to the compressor so a `react-pdf` or zlib bump costs no re-baselining of five
 * binaries, and it does not depend on cross-platform byte determinism at all.
 *
 * That last one is the honest open question: every measurement above ran on one
 * macOS arm64 machine (bun 1.2.8, node 22.6.0). Whether CI's `ubuntu-latest`
 * zlib emits the same bytes is UNTESTED in either direction. A byte-level step
 * would find out on its first red run; this gate never has to ask.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { countPdfPages } from "./print-page-count";

/** The layout-determined content of one PDF. */
export interface PdfContent {
	/** Sheets, read off the page tree by {@link countPdfPages}. */
	pages: number;
	/** Each `/MediaBox`, whitespace-normalised, in file order. */
	mediaBoxes: string[];
	/** Every `/BaseFont` name and `/Font` resource map, in file order. */
	fonts: string[];
	/**
	 * Every stream, inflated. A stream that is not DEFLATE (an embedded image or
	 * font file) is reduced to `uninflated:<length>:<sha256>`, which {@link
	 * isUninflated} detects. A caller must treat that as a broken comparison
	 * rather than a passing one — see that function.
	 */
	streams: string[];
}

/**
 * Marker for a stream this module could not inflate.
 *
 * Not a graceful degradation. Once a stream is opaque, the gate silently stops
 * comparing LAYOUT and starts comparing COMPRESSION: a `react-pdf` release that
 * switched filters would make every sheet go red with a digest mismatch naming
 * no cause, and — worse, because it looks like success — a stream the reader
 * mis-delimits reduces to a hash on both sides and can compare EQUAL. So the
 * marker is public, and `role-sheet-artifacts.test.ts` asserts on it directly.
 */
const UNINFLATED = "uninflated:";

/** Whether {@link readPdfContent} failed to inflate this stream. */
export const isUninflated = (stream: string): boolean =>
	stream.startsWith(UNINFLATED);
/** Only numbers, so this can never run away scanning compressed bytes. */
const MEDIA_BOX = /\/MediaBox\s*\[([\d.+\-\s]*)\]/g;
const BASE_FONT = /\/BaseFont\s*\/([A-Za-z0-9+\-.,_]+)/g;
const FONT_MAP = /\/Font\s*<<([^>]*)>>/g;
/** A direct `/Length 2367`, rejecting the indirect `/Length 12 0 R` form. */
const LENGTH = /\/Length\s+(\d+)(?![\s\d]*R)/;

const squash = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Where the stream starting at `start` ends.
 *
 * Prefers the `/Length` in the stream's own dictionary: a compressed payload can
 * contain the ASCII bytes `endstream`, and searching for that keyword first
 * would truncate it. `/Length` is only trusted when the bytes it points at are
 * actually followed by `endstream`, so a malformed or indirect length falls back
 * to the search rather than silently reading the wrong span.
 */
function streamEnd(latin: string, keyword: number, start: number): number {
	const marker = latin.lastIndexOf("/Length", keyword);
	if (marker >= 0 && keyword - marker < 200) {
		const declared = LENGTH.exec(latin.slice(marker, keyword));
		if (declared) {
			const end = start + Number(declared[1]);
			const tail = latin.slice(end, end + 11);
			if (/^\r?\n?endstream/.test(tail)) return end;
		}
	}
	const found = latin.indexOf("endstream", start);
	// The EOL in front of `endstream` is a delimiter, not payload (PDF 32000-1
	// §7.3.8.1). `/Length` knows where the data really stops; the search does not,
	// so it has to put the delimiter back.
	if (found > start && latin[found - 1] === "\n") {
		return latin[found - 2] === "\r" ? found - 2 : found - 1;
	}
	return found;
}

function decodeStream(raw: Uint8Array): string {
	try {
		return Buffer.from(inflateSync(raw)).toString("latin1");
	} catch {
		const digest = createHash("sha256").update(raw).digest("hex");
		return `${UNINFLATED}${raw.length}:${digest}`;
	}
}

function readStreams(bytes: Buffer, latin: string): string[] {
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const keyword = latin.indexOf("stream", from);
		if (keyword < 0) break;
		// "endstream" ends with "stream". Only a keyword at a token boundary opens
		// one, or a document whose first stream is skipped reads the file as one
		// giant unparsed blob and the gate compares nothing.
		if (latin.slice(keyword - 3, keyword) === "end") {
			from = keyword + "stream".length;
			continue;
		}
		let start = keyword + "stream".length;
		if (latin[start] === "\r") start += 1;
		if (latin[start] === "\n") start += 1;
		const end = streamEnd(latin, keyword, start);
		if (end < 0) break;
		out.push(decodeStream(bytes.subarray(start, end)));
		from = end;
	}
	return out;
}

/** Parse `bytes` into the layout-determined content the gate compares. */
export function readPdfContent(bytes: Uint8Array): PdfContent {
	const buf = Buffer.from(bytes);
	const latin = buf.toString("latin1");
	if (!latin.startsWith("%PDF-")) {
		throw new Error(
			`not a PDF: expected a %PDF- header, got ${JSON.stringify(latin.slice(0, 16))}`,
		);
	}
	return {
		// Via the shared harness, which reads `/Count` off the `/Type /Pages` root
		// and THROWS rather than guess. Counting `/Type /Page` objects is the
		// obvious implementation and the rejected one: uncompressed `/Info` and
		// `/Annots /URI` text can forge the token, and it measured 4 on a genuinely
		// 2-page document. `pages` is this gate's vacuity floor, so a forgeable
		// count is a forgeable floor.
		pages: countPdfPages(buf),
		mediaBoxes: [...latin.matchAll(MEDIA_BOX)].map((m) => squash(m[1])),
		fonts: [
			...[...latin.matchAll(BASE_FONT)].map((m) => m[1]),
			...[...latin.matchAll(FONT_MAP)].map((m) => squash(m[1])),
		],
		streams: readStreams(buf, latin),
	};
}

function firstLineDifference(committed: string, rendered: string): string {
	if (isUninflated(committed) || isUninflated(rendered)) {
		return [
			"  a stream did not inflate, so this compares COMPRESSED bytes, not",
			"  layout — the renderer's stream filter has changed, or this reader",
			"  mis-delimited the stream. Fix src/test/pdf-content.ts; do not",
			"  re-render against this failure.",
			`    committed: ${committed.slice(0, 120)}`,
			`    rendered:  ${rendered.slice(0, 120)}`,
		].join("\n");
	}
	const a = committed.split("\n");
	const b = rendered.split("\n");
	// `-1` means every line of the committed stream matched, so the rendered one
	// carries extra lines past its end — the difference is the first of those.
	const found = a.findIndex((line, i) => line !== b[i]);
	const at = found === -1 ? a.length : found;
	return [
		`  first differing drawing operator, line ${at + 1}:`,
		`    committed: ${JSON.stringify(a[at] ?? "<end of stream>")}`,
		`    rendered:  ${JSON.stringify(b[at] ?? "<end of stream>")}`,
	].join("\n");
}

/**
 * `null` when the committed file is what the layout renders today, otherwise a
 * description of the FIRST difference — the whole point being that a caller can
 * put it straight in an assertion message. A full diff of ~9,000 lines of PDF
 * operators tells nobody anything.
 */
export function describePdfDrift(
	committed: PdfContent,
	rendered: PdfContent,
): string | null {
	if (committed.pages !== rendered.pages) {
		return `  page count: committed ${committed.pages}, rendered ${rendered.pages}`;
	}
	if (committed.mediaBoxes.join("|") !== rendered.mediaBoxes.join("|")) {
		return `  page size: committed [${committed.mediaBoxes.join("], [")}], rendered [${rendered.mediaBoxes.join("], [")}]`;
	}
	if (committed.fonts.join("|") !== rendered.fonts.join("|")) {
		return `  fonts: committed ${committed.fonts.join(", ")}; rendered ${rendered.fonts.join(", ")}`;
	}
	if (committed.streams.length !== rendered.streams.length) {
		return `  stream count: committed ${committed.streams.length}, rendered ${rendered.streams.length}`;
	}
	for (const [i, stream] of committed.streams.entries()) {
		if (stream === rendered.streams[i]) continue;
		return `  stream ${i + 1} of ${committed.streams.length}:\n${firstLineDifference(stream, rendered.streams[i])}`;
	}
	return null;
}
