/**
 * A minimal CSV WRITER (#915), the counterpart to the importer's parser in
 * `members-csv.ts`. Pure and db-free, so the club export and its tests share
 * one statement of the format:
 *
 * - RFC 4180 quoting: a cell containing a comma, a double quote, CR or LF is
 *   wrapped in double quotes, and each quote inside it is doubled.
 * - CRLF between records (RFC 4180's line ending, and what Excel writes).
 * - A leading UTF-8 byte-order mark, because Excel otherwise reads a BOM-less
 *   file as the system code page and "José" opens as "JosÃ©".
 * - A CSV-injection guard: a cell whose first meaningful character is `=`, `+`,
 *   `-` or `@` gets a leading `'`, so a spreadsheet shows it as text instead of
 *   evaluating it as a formula. "First meaningful" skips leading whitespace, tab
 *   and CR, which Excel also skips before deciding a cell is a formula — a guard
 *   that looked only at character 0 would let ` =HYPERLINK(…)` through. Member
 *   and guest names are typed by the public (a guest book, a claim link), so
 *   this is not theoretical.
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

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_TRIGGER = /^[\s]*[=+\-@]/;

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
	// numeric. Only strings can carry an injected formula.
	if (typeof value === "string" && FORMULA_TRIGGER.test(text)) {
		text = `'${text}`;
	}
	if (/[",\r\n]/.test(text)) {
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
