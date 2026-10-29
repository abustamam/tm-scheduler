// A `<DropdownMenuItem asChild>` whose child is a `<Link>` / `<a>` must carry a
// `text-*` colour utility (#1370). Only `<Link>` / `<a>` children are checked; an
// asChild item wrapping a `<button>` or any other element is not (buttons are not
// painted by the anchor rule).
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
	/^text-(?:\d*xs|sm|base|lg|\d*xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|\[(?:length:|[\d.]+(?:px|rem|em|%|vh|vw|ch|pt)\])[^\s]*)$/;

function hasColourUtility(tag: string): boolean {
	return tag.split(/[\s"'`{}]+/).some((tok) => {
		// strip variant prefixes (`hover:`), but not the `:` inside `text-[color:…]`
		const base = tok.replace(/^(?:[^:[\s]+:)+/, "").replace(/^\(+/, "");
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

/** Every `<DropdownMenuItem asChild>` whose child is a `<Link>` / `<a>`. */
function linkItems(src: string): { line: number; bare: boolean }[] {
	const out: { line: number; bare: boolean }[] = [];
	const re = /<DropdownMenuItem\b/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const item = openingTag(src, m.index);
		if (!/\basChild\b/.test(item)) continue;
		const after = src.slice(m.index + item.length);
		const child = /^(?:\s|\{\s*\})*<(?:Link|a)\b/.exec(after);
		if (!child) continue;
		const tag = openingTag(
			src,
			m.index + item.length + child[0].lastIndexOf("<"),
		);
		out.push({
			line: src.slice(0, m.index).split("\n").length,
			bare: !hasColourUtility(tag),
		});
	}
	return out;
}

function offenders(src: string): number[] {
	return linkItems(src)
		.filter((i) => i.bare)
		.map((i) => i.line);
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

	it("scans the item tag brace-aware: an arrow-function prop does not hide the item", () => {
		const arrow = `<DropdownMenuItem asChild onSelect={() => close()}>\n<Link to="/x">x</Link>`;
		expect(offenders(arrow)).toEqual([1]);
		expect(
			offenders(
				`<DropdownMenuItem asChild onSelect={() => close()}><Link className="text-inherit" to="/x">x</Link>`,
			),
		).toEqual([]);
	});

	it("treats arbitrary sizes and the size scale as non-colour", () => {
		for (const cls of [
			"text-[13px]",
			"text-2xs",
			"text-[length:var(--s)]",
			"text-sm",
		]) {
			expect(
				offenders(`<DropdownMenuItem asChild><a className="${cls}">x</a>`),
			).toEqual([1]);
		}
		for (const cls of [
			"text-[#123456]",
			"text-[color:var(--c)]",
			"text-inherit",
		]) {
			expect(
				offenders(`<DropdownMenuItem asChild><a className="${cls}">x</a>`),
			).toEqual([]);
		}
	});

	it("every asChild link item in src/ has one", () => {
		const found: string[] = [];
		const seen: Record<string, number> = {};
		for (const file of sourceFiles(SRC)) {
			const rel = relative(SRC, file);
			const items = linkItems(readSource(file));
			if (items.length) seen[rel] = items.length;
			for (const i of items) if (i.bare) found.push(`${rel}:${i.line}`);
		}
		expect(found).toEqual([]);
		// Vacuity floor: a regex that stops matching must not read green.
		expect(
			seen["components/club/meeting-export-menu.tsx"],
		).toBeGreaterThanOrEqual(5);
		for (const f of [
			"components/club/meeting-toolbar.tsx",
			"routes/_authed/schedule.tsx",
		]) {
			expect(seen[f], f).toBeGreaterThanOrEqual(1);
		}
	});
});
