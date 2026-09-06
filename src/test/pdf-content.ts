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
 * ## Why not compare the bytes
 *
 * Both re-render options in the issue assumed a byte diff was reachable after
 * some normalisation. It is not, and the measurements are worth keeping:
 *
 * - Every render writes a fresh `/CreationDate` and a fresh trailer `/ID`, so
 *   two renders of an unchanged layout are never byte-identical.
 * - Worse, and the reason normalising those two fields is not enough: DEFLATE
 *   output is not portable. `timer.pdf`'s content stream INFLATES to bytes
 *   identical to a fresh render's, and compresses to 4838 bytes committed
 *   against 4472 fresh on this machine. A `git diff --exit-code` after
 *   `build:role-sheets` would therefore go red on a PR that changed nothing,
 *   whenever CI's zlib differs from the committer's — the exact CI step that
 *   trains everyone to ignore it.
 *
 * ## What this compares instead
 *
 * The DECOMPRESSED content streams: every drawing operator react-pdf emitted —
 * glyphs, colours, line widths, coordinates — plus page count, page size, and
 * the fonts the document declares. That is a strict superset of the extracted
 * text the issue proposed, so it also catches a purely visual change (a colour,
 * a border, a column width) that leaves the wording alone. It is stable by
 * measurement, not by hope: two fresh renders of the same sheet produce
 * byte-identical content streams, and `@react-pdf/*` + `yoga-layout` are pinned
 * in `bun.lock`, so CI and a laptop render the same geometry.
 *
 * Deliberately NOT compared: `/CreationDate`, the trailer `/ID`, the xref table,
 * object offsets, and the compressed stream bytes. Each is a property of the
 * render, not of the layout.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/** The layout-determined content of one PDF. */
export interface PdfContent {
	/** `/Type /Page` objects — the sheet count. */
	pages: number;
	/** Each `/MediaBox`, whitespace-normalised, in file order. */
	mediaBoxes: string[];
	/** Every `/BaseFont` name and `/Font` resource map, in file order. */
	fonts: string[];
	/**
	 * Every stream, inflated. A stream that is not DEFLATE (an embedded image or
	 * font file) is reduced to `binary:<length>:<sha256>` — still drift-sensitive,
	 * just not readable in a failure message.
	 */
	streams: string[];
}

/** `/Type /Pages` is the tree root, not a sheet, so the boundary matters. */
const PAGE = /\/Type\s*\/Page(?![A-Za-z])/g;
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
		return `binary:${raw.length}:${digest}`;
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
		pages: (latin.match(PAGE) ?? []).length,
		mediaBoxes: [...latin.matchAll(MEDIA_BOX)].map((m) => squash(m[1])),
		fonts: [
			...[...latin.matchAll(BASE_FONT)].map((m) => m[1]),
			...[...latin.matchAll(FONT_MAP)].map((m) => squash(m[1])),
		],
		streams: readStreams(buf, latin),
	};
}

function firstLineDifference(committed: string, rendered: string): string {
	if (committed.startsWith("binary:") || rendered.startsWith("binary:")) {
		return `  committed: ${committed.slice(0, 120)}\n  rendered:  ${rendered.slice(0, 120)}`;
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
