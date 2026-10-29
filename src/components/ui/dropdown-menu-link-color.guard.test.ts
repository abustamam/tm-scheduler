// A `<DropdownMenuItem asChild>` wrapping a `<Link>` / `<a>` must carry a `text-*`
// colour utility (#1370).
//
// `styles.css` paints every bare anchor through a rule in `@layer base`, and
// `DropdownMenuItem` sets a text colour only on focus, so an anchor item with no
// colour utility of its own renders link-teal beside its button-shaped peers.
// `text-inherit` wins by layer order; that is the sanctioned fix (no `:not()` arm,
// no `!important`, no change to the global rule — CODING_STANDARDS.md).
//
// Read direction: comment-blind (`#/test/guard-source`). Same reasoning as
// `text-link-layering`: a comment that spells `text-inherit` must not satisfy it.
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource, stripComments } from "#/test/guard-source";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) sourceFiles(p, out);
		else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
	}
	return out;
}

/** `text-*` utilities that are NOT a colour. */
const NON_COLOUR =
	/^text-(?:xs|sm|base|lg|\d*xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;

function hasColourUtility(tag: string): boolean {
	return tag.split(/[\s"'`{}(),]+/).some((tok) => {
		const base = tok.split(":").pop() ?? "";
		return base.startsWith("text-") && !NON_COLOUR.test(base);
	});
}

/** The opening tag starting at `from` (a `<`), skipping `>` inside `{…}`. */
function openingTag(src: string, from: number): string {
	let depth = 0;
	for (let i = from; i < src.length; i++) {
		const c = src[i];
		if (c === "{") depth++;
		else if (c === "}") depth--;
		else if (c === ">" && depth === 0) return src.slice(from, i + 1);
	}
	return src.slice(from);
}

function offenders(src: string): number[] {
	const lines: number[] = [];
	const re =
		/<DropdownMenuItem\b[^>]*\basChild\b[^>]*>(?:\s|\{\s*\})*<(Link|a)\b/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const tagStart = m.index + m[0].lastIndexOf("<");
		if (!hasColourUtility(openingTag(src, tagStart))) {
			lines.push(src.slice(0, m.index).split("\n").length);
		}
	}
	return lines;
}

describe("DropdownMenuItem asChild links carry a text colour (#1370)", () => {
	it("flags a link item with no colour utility, and ignores comments", () => {
		const bare = `<DropdownMenuItem asChild>\n<Link to="/x">x</Link>\n</DropdownMenuItem>`;
		expect(offenders(bare)).toEqual([1]);
		expect(
			offenders(
				`<DropdownMenuItem asChild><a href="/x" className="text-sm">x</a>`,
			),
		).toEqual([1]);
		expect(
			offenders(
				`<DropdownMenuItem asChild><Link className="text-inherit" to="/x">x</Link>`,
			),
		).toEqual([]);
		const commented = `<DropdownMenuItem asChild>{/* text-inherit */}<Link to="/x">x</Link>`;
		expect(offenders(stripComments(commented))).toEqual([1]);
	});

	it("every asChild link item in src/ has one", () => {
		const found: string[] = [];
		for (const file of sourceFiles(SRC)) {
			for (const line of offenders(readSource(file))) {
				found.push(`${relative(SRC, file)}:${line}`);
			}
		}
		expect(found).toEqual([]);
	});
});
