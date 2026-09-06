/**
 * Unit tests for the PDF reader behind the role-sheet artifact gate (#515).
 *
 * The gate itself (`src/server/role-sheet-artifacts.test.ts`) can only report
 * "these two agree" or "these two do not". That is a useful answer and a poor
 * test subject: it passes just as well if this reader returns empty everywhere,
 * which is exactly how a drift gate dies silently. So the parsing, the fallbacks
 * and the failure MESSAGE are pinned here, against PDFs built byte by byte.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	describePdfDrift,
	type PdfContent,
	readPdfContent,
} from "./pdf-content";

const TIMER_PDF = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"public",
	"role-sheets",
	"timer.pdf",
);

/** A PDF-shaped buffer: only the header and the objects this reader parses. */
function fakePdf(...objects: (string | Buffer)[]): Buffer {
	return Buffer.concat([
		Buffer.from("%PDF-1.3\n", "latin1"),
		...objects.map((o) =>
			typeof o === "string" ? Buffer.from(o, "latin1") : o,
		),
	]);
}

function streamObject(payload: Buffer, length: string, eol = "\n"): Buffer {
	return Buffer.concat([
		Buffer.from(`6 0 obj\n<<\n/Length ${length}\n>>\nstream\n`, "latin1"),
		payload,
		Buffer.from(`${eol}endstream\nendobj\n`, "latin1"),
	]);
}

const digest = (payload: Buffer) =>
	`binary:${payload.length}:${createHash("sha256").update(payload).digest("hex")}`;

const content: PdfContent = {
	pages: 1,
	mediaBoxes: ["0 0 612 792"],
	fonts: ["Helvetica"],
	streams: ["1 0 0 1 44 40 cm\n0 0 0 scn\nBT\nET"],
};
const withStreams = (...streams: string[]): PdfContent => ({
	...content,
	streams,
});

describe("readPdfContent", () => {
	it("reads a committed role sheet", () => {
		const parsed = readPdfContent(readFileSync(TIMER_PDF));
		expect(parsed.pages).toBe(1);
		expect(parsed.mediaBoxes).toEqual(["0 0 612 792"]);
		expect(parsed.fonts).toContain("Helvetica");
		expect(parsed.streams).toHaveLength(1);
		// Text is drawn as hex-encoded glyph runs, so the operator is the signal
		// that this is a real content stream and not an unparsed blob.
		expect(parsed.streams[0]).toContain(" TJ");
	});

	it("rejects anything that is not a PDF", () => {
		expect(() =>
			readPdfContent(Buffer.from("<html></html>", "latin1")),
		).toThrow(/not a PDF/);
	});

	it("counts pages without counting the /Pages tree root", () => {
		const parsed = readPdfContent(
			fakePdf(
				"1 0 obj\n<<\n/Type /Pages\n/Count 2\n>>\nendobj\n",
				"8 0 obj\n<<\n/Type /Page\n/MediaBox [0 0 612 792]\n>>\nendobj\n",
				"9 0 obj\n<<\n/Type /Page\n/MediaBox [0 0 595.28 841.89]\n>>\nendobj\n",
			),
		);
		expect(parsed.pages).toBe(2);
		expect(parsed.mediaBoxes).toEqual(["0 0 612 792", "0 0 595.28 841.89"]);
	});

	it("reads both the font names and the resource map that points at them", () => {
		const parsed = readPdfContent(
			fakePdf(
				"7 0 obj\n<<\n/Font <<\n/F1 10 0 R\n/F2 11 0 R\n>>\n>>\nendobj\n",
				"10 0 obj\n<<\n/BaseFont /Helvetica-Bold\n>>\nendobj\n",
				"11 0 obj\n<<\n/BaseFont /Helvetica-Oblique\n>>\nendobj\n",
			),
		);
		expect(parsed.fonts).toEqual([
			"Helvetica-Bold",
			"Helvetica-Oblique",
			"/F1 10 0 R /F2 11 0 R",
		]);
	});

	it("inflates a deflate stream", () => {
		const body = "1 0 0 -1 0 792 cm\nBT\n[<48656c6c6f>] TJ\nET";
		const payload = deflateSync(Buffer.from(body, "latin1"));
		const parsed = readPdfContent(
			fakePdf(streamObject(payload, String(payload.length))),
		);
		expect(parsed.streams).toEqual([body]);
	});

	it("digests a stream it cannot inflate rather than dropping it", () => {
		const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
		const parsed = readPdfContent(
			fakePdf(streamObject(payload, String(payload.length))),
		);
		expect(parsed.streams).toEqual([digest(payload)]);
	});

	it("trusts /Length over a literal 'endstream' inside the payload", () => {
		// Compressed bytes are arbitrary and can spell the terminator. Searching
		// for the keyword first would truncate the stream here, and a truncated
		// stream compares equal to a truncated stream — the gate would go quiet.
		const payload = Buffer.from("aaaa\nendstream\nbbbb", "latin1");
		const parsed = readPdfContent(
			fakePdf(streamObject(payload, String(payload.length))),
		);
		expect(parsed.streams).toEqual([digest(payload)]);
	});

	it("falls back to the keyword when /Length is an indirect reference", () => {
		const payload = Buffer.from("aaaa", "latin1");
		const parsed = readPdfContent(fakePdf(streamObject(payload, "12 0 R")));
		expect(parsed.streams).toEqual([digest(payload)]);
	});

	it("drops the CRLF delimiter too when it falls back to the keyword", () => {
		const payload = Buffer.from("aaaa", "latin1");
		const parsed = readPdfContent(
			fakePdf(streamObject(payload, "12 0 R", "\r\n")),
		);
		expect(parsed.streams).toEqual([digest(payload)]);
	});

	it("keeps the payload when nothing delimits the keyword", () => {
		const payload = Buffer.from("aaaa", "latin1");
		const parsed = readPdfContent(fakePdf(streamObject(payload, "12 0 R", "")));
		expect(parsed.streams).toEqual([digest(payload)]);
	});

	it("finds every stream in a multi-stream document", () => {
		const one = deflateSync(Buffer.from("first", "latin1"));
		const two = deflateSync(Buffer.from("second", "latin1"));
		const parsed = readPdfContent(
			fakePdf(
				streamObject(one, String(one.length)),
				streamObject(two, String(two.length)),
			),
		);
		expect(parsed.streams).toEqual(["first", "second"]);
	});
});

describe("describePdfDrift", () => {
	it("is null when the two agree", () => {
		expect(describePdfDrift(content, { ...content })).toBeNull();
	});

	it("names a page-count change first", () => {
		expect(describePdfDrift(content, { ...content, pages: 2 })).toContain(
			"page count: committed 1, rendered 2",
		);
	});

	it("names a page-size change", () => {
		expect(
			describePdfDrift(content, { ...content, mediaBoxes: ["0 0 595 842"] }),
		).toContain("page size: committed [0 0 612 792], rendered [0 0 595 842]");
	});

	it("names a font change", () => {
		expect(
			describePdfDrift(content, { ...content, fonts: ["Helvetica-Bold"] }),
		).toContain("fonts: committed Helvetica; rendered Helvetica-Bold");
	});

	it("names a stream-count change", () => {
		expect(
			describePdfDrift(content, withStreams(...content.streams, "extra")),
		).toContain("stream count: committed 1, rendered 2");
	});

	it("points at the first differing drawing operator", () => {
		// The real #515 failure shape: identical text, one column drawn wider.
		const drift = describePdfDrift(
			withStreams("BT\n95.019417 1 m\nET"),
			withStreams("BT\n97.599998 1 m\nET"),
		);
		expect(drift).toContain("stream 1 of 1");
		expect(drift).toContain("line 2");
		expect(drift).toContain('committed: "95.019417 1 m"');
		expect(drift).toContain('rendered:  "97.599998 1 m"');
	});

	it("says so when the rendered stream ends early", () => {
		const drift = describePdfDrift(withStreams("BT\nET"), withStreams("BT"));
		expect(drift).toContain("line 2");
		expect(drift).toContain('rendered:  "<end of stream>"');
	});

	it("says so when the committed stream ends early", () => {
		// The mirror case, and the one a `for` loop over the committed lines alone
		// would miss: every line the committed file has matches, and the layout has
		// grown one more.
		const drift = describePdfDrift(withStreams("BT"), withStreams("BT\nET"));
		expect(drift).toContain("line 2");
		expect(drift).toContain('committed: "<end of stream>"');
		expect(drift).toContain('rendered:  "ET"');
	});

	it("reports a binary stream by its digest rather than by line", () => {
		const drift = describePdfDrift(
			withStreams("binary:7:aaaa"),
			withStreams("binary:7:bbbb"),
		);
		expect(drift).toContain("committed: binary:7:aaaa");
		expect(drift).toContain("rendered:  binary:7:bbbb");
	});
});
