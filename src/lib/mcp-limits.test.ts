/**
 * The MCP caps, asserted as VALUES (#776 item 1), and the body reader asserted
 * as a BOUND ON MEMORY rather than a status code (#776 item 7).
 *
 * The first half is the whole reason the three numbers moved out of the tool
 * modules: while they lived beside `db`, no test could import them, so nothing
 * in the suite disagreed with any value they might have had.
 *
 * The second half measures what the old check could not: how much of an
 * oversized body is read before the reader gives up. A 413 says nothing about
 * that — `await request.text()` followed by a length check returns the same 413
 * having buffered the whole thing.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_FIND_PEOPLE_RESULTS,
	MAX_GUEST_BOOK_ENTRIES,
	MAX_MCP_BODY_BYTES,
	parseDeclaredContentLength,
	readBodyWithinCap,
} from "./mcp-limits";

describe("the caps themselves (#776 item 1)", () => {
	it("are the values the tools were shipped with", () => {
		expect(MAX_GUEST_BOOK_ENTRIES).toBe(100);
		expect(MAX_FIND_PEOPLE_RESULTS).toBe(200);
		expect(MAX_MCP_BODY_BYTES).toBe(1_000_000);
	});

	it("are whole positive numbers — a cap of 0 or 1.5 is a bug, not a policy", () => {
		for (const cap of [
			MAX_GUEST_BOOK_ENTRIES,
			MAX_FIND_PEOPLE_RESULTS,
			MAX_MCP_BODY_BYTES,
		]) {
			expect(Number.isSafeInteger(cap)).toBe(true);
			expect(cap).toBeGreaterThan(0);
		}
	});
});

describe("parseDeclaredContentLength (#776 item 7)", () => {
	it("reads a plain byte count", () => {
		expect(parseDeclaredContentLength("0")).toEqual({ kind: "length", bytes: 0 });
		expect(parseDeclaredContentLength("2000000")).toEqual({
			kind: "length",
			bytes: 2_000_000,
		});
		// Header values arrive with incidental whitespace often enough to trim.
		expect(parseDeclaredContentLength(" 42 ")).toEqual({
			kind: "length",
			bytes: 42,
		});
	});

	it("says ABSENT rather than zero when there is no header", () => {
		// The old code read this as `Number("0")`, i.e. "a body of nothing", and
		// waved a chunked request of any size straight through.
		expect(parseDeclaredContentLength(null)).toEqual({ kind: "absent" });
		expect(parseDeclaredContentLength(undefined)).toEqual({ kind: "absent" });
		expect(parseDeclaredContentLength("   ")).toEqual({ kind: "absent" });
	});

	it("says MALFORMED rather than NaN for anything that is not digits", () => {
		// `Number("abc")` is NaN, and NaN is false against every comparison — so
		// the cheapest way past a `declared > MAX` check was to write nonsense.
		for (const raw of [
			"abc",
			"-1",
			"1.5",
			"1e6",
			"0x10",
			"10, 10",
			"1_000",
			// Beyond 2^53: a number this large cannot be compared exactly.
			"9007199254740993",
		]) {
			expect(parseDeclaredContentLength(raw), raw).toMatchObject({
				kind: "malformed",
			});
		}
	});
});

/** A POST whose body is a stream, plus a counter of how much was pulled. */
function streamingRequest(chunk: Uint8Array, chunks: number) {
	const pulled = { chunks: 0, bytes: 0, cancelled: false };
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			sent += 1;
			pulled.chunks += 1;
			pulled.bytes += chunk.byteLength;
			controller.enqueue(chunk);
		},
		cancel() {
			pulled.cancelled = true;
		},
	});
	const request = new Request("https://club.test/api/mcp", {
		method: "POST",
		body,
		// Required by undici for a streaming request body.
		duplex: "half",
	} as RequestInit & { duplex: "half" });
	return { request, pulled };
}

describe("readBodyWithinCap (#776 item 7)", () => {
	it("returns a body under the cap unchanged, with its true byte size", async () => {
		const text = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "whoami" });
		const res = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", { method: "POST", body: text }),
			MAX_MCP_BODY_BYTES,
		);
		expect(res).toEqual({
			kind: "body",
			text,
			bytes: new TextEncoder().encode(text).byteLength,
		});
	});

	it("counts BYTES, not UTF-16 code units", async () => {
		// "🎤" is 2 code units and 4 bytes. A cap read off `text.length` lets a
		// body ~3x the ceiling through; this one does not.
		const text = "🎤".repeat(10); // 20 code units, 40 bytes
		const under = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", { method: "POST", body: text }),
			40,
		);
		expect(under).toMatchObject({ kind: "body", bytes: 40 });

		const over = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", { method: "POST", body: text }),
			39,
		);
		expect(over).toEqual({ kind: "too-large" });
	});

	it("decodes a multi-byte character split across two chunks", async () => {
		// The streaming decoder is what keeps a chunk boundary inside a UTF-8
		// sequence from becoming two replacement glyphs in the parsed JSON.
		const bytes = new TextEncoder().encode('{"t":"🎤"}');
		const cut = 7; // lands inside the 4-byte sequence
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, cut));
				controller.enqueue(bytes.slice(cut));
				controller.close();
			},
		});
		const res = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
			MAX_MCP_BODY_BYTES,
		);
		expect(res).toMatchObject({ kind: "body", text: '{"t":"🎤"}' });
	});

	it("STOPS READING once the cap is crossed — the 413 is not the claim", async () => {
		// 1000 chunks of 64 KB is a ~64 MB body against a 1 MB cap. The old
		// handler answered 413 having held every byte of it; this one reads ~17
		// chunks and cancels the stream.
		const chunk = new Uint8Array(64 * 1024).fill(0x61);
		const { request, pulled } = streamingRequest(chunk, 1000);

		const res = await readBodyWithinCap(request, MAX_MCP_BODY_BYTES);

		expect(res).toEqual({ kind: "too-large" });
		// The ceiling plus at most a chunk in flight and one queued ahead.
		expect(pulled.bytes).toBeLessThanOrEqual(
			MAX_MCP_BODY_BYTES + 2 * chunk.byteLength,
		);
		// The measured control: without the cap this would be 1000.
		expect(pulled.chunks).toBeLessThan(20);
		expect(pulled.cancelled).toBe(true);
	});

	it("reports an unreadable body rather than throwing", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("connection reset"));
			},
		});
		const res = await readBodyWithinCap(
			new Request("https://club.test/api/mcp", {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
			MAX_MCP_BODY_BYTES,
		);
		expect(res).toEqual({ kind: "unreadable" });
	});
});
