/**
 * A minimal CSV WRITER (#915), the counterpart to the importer's parser in
 * `members-csv.ts`. Pure and db-free, so the club export and its tests share
 * one statement of the format:
 *
 * - RFC 4180 quoting: a cell containing a comma, a double quote, CR or LF is
 *   wrapped in double quotes, and each quote inside it is doubled. A cell
 *   containing a semicolon or a tab is quoted too ({@link NEEDS_QUOTES}).
 * - CRLF between records (RFC 4180's line ending, and what Excel writes).
 * - A leading UTF-8 byte-order mark, because Excel otherwise reads a BOM-less
 *   file as the system code page and "José" opens as "JosÃ©".
 * - A CSV-injection guard: a cell whose first meaningful character is `=`, `+`,
 *   `-` or `@` (or their full-width forms), or which starts with a bare tab or
 *   CR, gets a leading `'`, so a spreadsheet shows it as text instead of
 *   evaluating it as a formula. "First meaningful" skips leading whitespace,
 *   which Excel also skips before deciding a cell is a formula — a guard that
 *   looked only at character 0 would let ` =HYPERLINK(…)` through. Member and
 *   guest names are typed by the public (a guest book, a claim link), so this
 *   is not theoretical. A plain decimal number (`-5.00`) is data and is left
 *   bare. The same guard applies to each piece of a cell that follows one of
 *   the characters in `SEPARATORS`.
 *
 * `null` and `undefined` become an empty cell. A file with no rows still has
 * its header row, so an empty table is visibly empty rather than malformed.
 */

/** One column: the header written on line 1, and how to read a row's cell. */
export interface CsvColumn<Row> {
	header: string;
	value: (row: Row) => string | number | boolean | null | undefined;
}

export const CSV_BOM = "\uFEFF";
const CRLF = "\r\n";

/**
 * What makes a spreadsheet treat a cell as a formula, or lets one through:
 *
 * - a LEADING tab or CR on its own. Excel strips them before deciding whether
 *   the rest is a formula, so they are the classic way past a guard that only
 *   looks at the first character; a cell that starts with one is prefixed
 *   whatever follows it;
 * - `=`, `+`, `-` or `@` after any leading whitespace;
 * - their FULL-WIDTH forms (U+FF1D, U+FF0B, U+FF0D, U+FF20). Excel with an East
 *   Asian input locale normalises them to the ASCII operators, so `＝SUM(A1)`
 *   typed into a guest book is a formula there.
 */
const TRIGGER_CHARS = "=+\\-@\\uFF1D\\uFF0B\\uFF0D\\uFF20";
const FORMULA_TRIGGER = new RegExp(`^(?:[\\t\\r]|\\s*[${TRIGGER_CHARS}])`);

/**
 * The characters a spreadsheet may break a line of a `.csv` at, depending on
 * its locale and how the file was opened: the semicolon, the tab, CR and LF.
 * A reader that breaks at one of them does not know about this file's quoting
 * (the quote that opened the cell was not at the start of ITS field), so each
 * piece after one starts a new cell of its own.
 */
const SEPARATORS = ";\\t\\r\\n";

/**
 * A separator whose following piece would be read as a formula: the next
 * character is not itself a separator (that one is handled on its own), and
 * after any whitespace comes one of {@link FORMULA_TRIGGER}'s operators. A
 * separator that starts a piece with a bare tab or CR is covered because tab
 * and CR are separators too.
 */
const SEGMENT_TRIGGER = new RegExp(
	`([${SEPARATORS}])(?![${SEPARATORS}])(?=\\s*[${TRIGGER_CHARS}])`,
	"g",
);

/**
 * A plain decimal number: `-5`, `60.50`. Data, not a formula, and it cannot
 * call anything, so it is emitted bare. Without this a refund of `-5.00`
 * exported as `'-5.00`, which a spreadsheet shows as text and will not sum.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * What makes a cell need quotes. RFC 4180's set (comma, quote, CR, LF), plus
 * the semicolon and the tab ({@link SEPARATORS}). Quoting keeps the cell whole
 * for a reader that honours it, which is not every reader; the per-piece guard
 * in {@link csvCell} is what covers the rest.
 */
const NEEDS_QUOTES = /[",;\t\r\n]/;

/**
 * One cell, escaped. Exported for the tests; callers want {@link toCsv}.
 *
 * The injection guard runs BEFORE quoting, so the `'` lands inside the quotes
 * (`"'=1,2"`), which is where a spreadsheet reads it.
 */
export function csvCell(
	value: string | number | boolean | null | undefined,
): string {
	if (value === null || value === undefined) return "";
	let text = String(value);
	// Numbers are data, not formulas: `-5` is a negative amount and must stay
	// numeric, whether it arrives as a number or as a formatted decimal string.
	// Only other strings can carry an injected formula.
	if (
		typeof value === "string" &&
		!PLAIN_NUMBER.test(text) &&
		FORMULA_TRIGGER.test(text)
	) {
		text = `'${text}`;
	}
	// And every piece after a separator gets the same guard, since a reader
	// that breaks the line there reads that piece as a cell of its own.
	text = text.replace(SEGMENT_TRIGGER, "$1'");
	if (NEEDS_QUOTES.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

/** Serialise rows to a CSV string: BOM, header line, one CRLF-ended record per row. */
export function toCsv<Row>(
	rows: readonly Row[],
	columns: readonly CsvColumn<Row>[],
): string {
	const lines = [columns.map((c) => csvCell(c.header)).join(",")];
	for (const row of rows) {
		lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
	}
	return `${CSV_BOM}${lines.join(CRLF)}${CRLF}`;
}
