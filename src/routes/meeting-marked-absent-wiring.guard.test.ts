// Route→component wiring pin for the own-card "marked absent" wording (#1344).
//
// `<MeetingAgenda>` says "You're marked absent." on the viewer's own card only
// for ids in `markedAbsentMemberIds`. What that list CONTAINS is the helper's
// job and is tested where it lives (`#/lib/marked-absent-member-ids`); a
// component test injects the prop itself and a route cannot be mounted in
// vitest, so what only this guard can pin is the WIRING: the route asks the
// helper, with the two PUBLIC values it derives from, and hands the answer to
// the ONE `<MeetingAgenda>` call site.
//
// What this guards: the list is made from `unavailableMemberIds` and
// `answeredRungs` (never from the roll or a new payload field: the loader
// payload reaches signed-out readers, the roll is members-only), and is the
// prop the agenda gets. Two same-typed values are in scope there and would each
// type-check: `unavailableMemberIds` itself (every unavailable member, so the
// copy would say "you said" for a roll-marked holder and the fix would be a
// no-op) and `contactedMemberIds`.
//
// It does NOT pin how the call is spelled: the call may sit inline in the prop
// or in a `const` the prop names, so a rewrite that keeps the wiring stays
// green. Inside `MeetingView` only (the route file holds other components), the
// tag's end and each prop's expression are found brace-aware (a prop value can
// hold `>`, `}` and nested elements), the same way `dialog-scroll.guard.test.ts`
// finds a tag.
//
// COMMENT-BLIND (`readSource`): every assertion is "must BE present", and the
// route explains this wiring in prose right beside it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

/**
 * `MeetingView`'s own text: its declaration to the first line that is a bare
 * `}` at column 0. The route holds more than one top-level function, so a
 * whole-file search would be satisfied by another component; Biome formats a
 * module-level function so its body closes at column 0, and nothing inside it
 * can start a line there.
 */
function meetingViewBody(src: string): string {
	const start = src.indexOf("function MeetingView(");
	if (start === -1) throw new Error("no `function MeetingView(` in the route");
	const end = src.indexOf("\n}\n", start);
	if (end === -1) throw new Error("MeetingView has no closing column-0 brace");
	return src.slice(start, end + 2);
}

/**
 * The index just past a balanced `{ … }` whose `{` is at `open`, skipping
 * quoted strings. Throws rather than guessing when it never balances: an
 * apostrophe in JSX text inside a prop would otherwise open a phantom string,
 * and a guard that quietly reads the wrong span is the false pass to avoid.
 */
function endOfBraces(src: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let j = open; j < src.length; j++) {
		const c = src[j];
		if (quote) {
			if (c === quote && src[j - 1] !== "\\") quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return j + 1;
		}
	}
	throw new Error(`unbalanced "{" at offset ${open}`);
}

/**
 * Every `<Name …>` opening tag in `src`, whole (`<Name` to its closing `>`, the
 * `/>` of a self-closing one included), found at brace depth zero and skipping
 * quoted strings. `<NameSomethingElse` is not a match.
 */
function openingTags(src: string, name: string): string[] {
	const tags: string[] = [];
	const OPEN = `<${name}`;
	for (let i = src.indexOf(OPEN); i !== -1; i = src.indexOf(OPEN, i + 1)) {
		if (/[A-Za-z0-9_]/.test(src[i + OPEN.length] ?? "")) continue;
		let quote: string | null = null;
		let closed = false;
		for (let j = i + OPEN.length; j < src.length; j++) {
			const c = src[j];
			if (quote) {
				if (c === quote && src[j - 1] !== "\\") quote = null;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") quote = c;
			else if (c === "{") j = endOfBraces(src, j) - 1;
			else if (c === ">") {
				tags.push(src.slice(i, j + 1));
				closed = true;
				break;
			}
		}
		if (!closed) throw new Error(`<${name} at offset ${i} never closes`);
	}
	return tags;
}

/**
 * The tag's own `name={expression}` props, in order, with the expression text
 * trimmed. Props of an element NESTED inside one of those expressions are not
 * the tag's own and are skipped with the expression that holds them, so a
 * `markedAbsentMemberIds={…}` on a child element cannot satisfy a check on the
 * tag. String-valued props are skipped whole.
 */
function ownProps(tag: string): Array<{ name: string; expr: string }> {
	const props: Array<{ name: string; expr: string }> = [];
	const NAME_AND_BRACE = /^\s+([A-Za-z_][\w-]*)=\{/;
	for (let i = 0; i < tag.length; i++) {
		const rest = tag.slice(i);
		const m = NAME_AND_BRACE.exec(rest);
		if (m) {
			const open = i + m[0].length - 1;
			const end = endOfBraces(tag, open);
			props.push({
				name: m[1] as string,
				expr: tag.slice(open + 1, end - 1).trim(),
			});
			i = end - 1;
			continue;
		}
		if (tag[i] === '"' || tag[i] === "'") {
			const close = tag.indexOf(tag[i] as string, i + 1);
			if (close === -1) throw new Error("unterminated string prop");
			i = close;
		}
	}
	return props;
}

const HELPER_CALL = String.raw`markedAbsentMemberIds\(\s*unavailableMemberIds\s*,\s*answeredRungs\s*,?\s*\)`;

describe("meeting marked-absent wiring (#1344)", () => {
	const src = readSource(ROUTE);
	const view = meetingViewBody(src);
	const agendaTags = openingTags(view, "MeetingAgenda");

	it("finds exactly one <MeetingAgenda> call site, inside MeetingView", () => {
		expect(
			agendaTags,
			"expected one <MeetingAgenda …> call site in MeetingView",
		).toHaveLength(1);
		// Not a second one elsewhere in the file that this guard would not look at.
		expect(openingTags(src, "MeetingAgenda")).toHaveLength(1);
	});

	it("imports the helper from its module, so the call is to the real one", () => {
		expect(src).toMatch(
			/import \{[^}]*\bmarkedAbsentMemberIds\b[^}]*\} from "#\/lib\/marked-absent-member-ids";/,
		);
	});

	it("passes the helper's answer, made from unavailableMemberIds and answeredRungs, as markedAbsentMemberIds", () => {
		const prop = ownProps(agendaTags[0] as string).find(
			(p) => p.name === "markedAbsentMemberIds",
		);
		expect(
			prop,
			"expected a markedAbsentMemberIds={…} prop on the <MeetingAgenda> tag",
		).toBeDefined();
		const expr = prop?.expr ?? "";

		// Inline: the call IS the prop's value.
		if (new RegExp(`^${HELPER_CALL}$`).test(expr)) return;

		// Or a `const` in MeetingView that the prop names.
		expect(
			expr,
			"expected the prop to be the helper call or an identifier bound to it",
		).toMatch(/^[A-Za-z_]\w*$/);
		expect(view).toMatch(new RegExp(`const ${expr} = ${HELPER_CALL}`));
	});
});

// The scanners decide what the three tests above look at, and a wrong one reads
// green. These pin them on small inputs so they cannot rot into decoration.
describe("the wiring guard's own scanners", () => {
	it("openingTags closes a tag at its depth-zero `>`, past a prop that holds `>` and `}`", () => {
		const tags = openingTags(
			`<A x={(e) => { const s = "}>"; return s; }} y={1} /><AB z={2} />`,
			"A",
		);
		expect(tags).toHaveLength(1);
		expect(tags[0]).toMatch(/y=\{1\} \/>$/);
	});

	it("ownProps skips a prop of a nested element and a string-valued prop", () => {
		const props = ownProps(
			`<A render={() => <B markedAbsentMemberIds={x} />} label="a b" markedAbsentMemberIds={y} />`,
		);
		expect(props.map((p) => p.name)).toEqual([
			"render",
			"markedAbsentMemberIds",
		]);
		expect(props[1]?.expr).toBe("y");
	});

	it("meetingViewBody stops at the function's own closing brace", () => {
		const body = meetingViewBody(
			"function MeetingView() {\n\treturn 1;\n}\n\nfunction Other() {\n\treturn 2;\n}\n",
		);
		expect(body).toContain("return 1");
		expect(body).not.toContain("Other");
	});
});
