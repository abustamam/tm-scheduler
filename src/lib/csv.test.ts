// `toCsv` (#915): the format the club export writes. Each assertion is on the
// exact bytes, because a spreadsheet reads bytes, and a looser check (contains,
// parses back to something) passes on the mistakes that matter here: a missing
// BOM, an LF line ending, a guard applied after quoting.
import { describe, expect, it } from "vitest";
import { CSV_BOM, type CsvColumn, csvCell, toCsv } from "./csv";

type Row = { a: string | number | null; b?: string | null };
const COLS: CsvColumn<Row>[] = [
	{ header: "a", value: (r) => r.a },
	{ header: "b", value: (r) => r.b },
];

describe("toCsv", () => {
	it("starts with a UTF-8 BOM and ends every record, header included, with CRLF", () => {
		const out = toCsv([{ a: "x", b: "y" }], COLS);
		expect(out.startsWith(CSV_BOM)).toBe(true);
		expect(CSV_BOM).toBe("\uFEFF");
		expect(out).toBe(`${CSV_BOM}a,b\r\nx,y\r\n`);
	});

	it("writes the header row for a table with no rows", () => {
		expect(toCsv([], COLS)).toBe(`${CSV_BOM}a,b\r\n`);
	});

	it("writes null and undefined as an empty cell", () => {
		expect(toCsv([{ a: null }], COLS)).toBe(`${CSV_BOM}a,b\r\n,\r\n`);
	});

	it("keeps non-ASCII text as-is (the BOM is what makes Excel read it)", () => {
		expect(toCsv([{ a: "José Ñúñez" }], COLS)).toContain("José Ñúñez,");
	});
});

describe("csvCell quoting (RFC 4180)", () => {
	it("leaves a plain cell bare", () => {
		expect(csvCell("plain text")).toBe("plain text");
	});

	it("quotes a cell with a comma", () => {
		expect(csvCell("Smith, Jane")).toBe('"Smith, Jane"');
	});

	it("quotes a cell with a double quote and doubles the quote", () => {
		expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
	});

	it("quotes a cell with a newline, LF or CRLF", () => {
		expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
		expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
	});

	// A reader may split an opened .csv on a semicolon or a tab as well as a
	// comma. Quoting keeps the cell whole whichever it picks, so what follows
	// the separator never becomes a cell of its own, unguarded.
	it("quotes a cell with a semicolon", () => {
		expect(csvCell("Ann;Lee")).toBe('"Ann;Lee"');
	});

	it("quotes a cell with a tab", () => {
		expect(csvCell("Ann\tLee")).toBe('"Ann\tLee"');
	});

	it("keeps a separator-then-trigger cell as ONE quoted cell", () => {
		for (const sep of [";", "\t", ","]) {
			expect(csvCell(`Ann${sep}=1+1`)).toBe(`"Ann${sep}=1+1"`);
		}
	});

	it("writes numbers bare, negative ones included", () => {
		expect(csvCell(42)).toBe("42");
		expect(csvCell(-5)).toBe("-5");
	});
});

describe("csvCell injection guard", () => {
	it("exports =SUM(A1) as '=SUM(A1)", () => {
		expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
	});

	it.each(["+1", "-1+1", "@SUM(A1)"])("prefixes %s", (v) => {
		expect(csvCell(v)).toBe(`'${v}`);
	});

	it("looks past leading whitespace, tab and CR", () => {
		expect(csvCell(" =1")).toBe("' =1");
		// Tab and CR also force quoting; the guard lands INSIDE the quotes.
		expect(csvCell("\t=1")).toBe(`"'\t=1"`);
		expect(csvCell("\r=1")).toBe(`"'\r=1"`);
	});

	it("guards before quoting, so the ' is inside the quotes", () => {
		expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
	});

	// Excel with an East Asian input locale reads the full-width operators as
	// the ASCII ones. Written as escapes so the source shows which code point
	// each case is.
	it.each([
		["\uFF1DSUM(A1)", "full-width ="],
		["\uFF0B1", "full-width +"],
		["\uFF0D1", "full-width -"],
		["\uFF20SUM(A1)", "full-width @"],
		[" \uFF1D1", "full-width = after a space"],
	])("prefixes %s (%s)", (v) => {
		expect(csvCell(v)).toBe(`'${v}`);
	});

	it("prefixes a cell that starts with a bare tab or CR, whatever follows", () => {
		expect(csvCell("\tplain")).toBe(`"'\tplain"`);
		expect(csvCell("\rplain")).toBe(`"'\rplain"`);
	});

	it("leaves a plain decimal number bare, negative ones included", () => {
		expect(csvCell("-5.00")).toBe("-5.00");
		expect(csvCell("60.50")).toBe("60.50");
		expect(csvCell("-5")).toBe("-5");
		// Not a plain number, so still guarded.
		expect(csvCell("-5+1")).toBe("'-5+1");
		expect(csvCell("+14155550100")).toBe("'+14155550100");
		expect(csvCell("-5.00 ")).toBe("'-5.00 ");
	});

	it("leaves a cell with a trigger character later on alone", () => {
		expect(csvCell("a=b")).toBe("a=b");
		expect(csvCell("jane@example.com")).toBe("jane@example.com");
	});
});
