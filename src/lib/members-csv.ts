/**
 * Pure helpers for importing the Toastmasters club-membership CSV export.
 * No DB access — unit-tested in isolation; the DB runner is
 * scripts/import-members.ts.
 */

/** Split one CSV line into fields, honoring double-quoted fields with commas. */
function splitLine(line: string): string[] {
	const out: string[] = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inQuotes) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
		} else if (c === '"') {
			inQuotes = true;
		} else if (c === ",") {
			out.push(field);
			field = "";
		} else {
			field += c;
		}
	}
	out.push(field);
	return out;
}

/** Parse CSV text (header row + data rows) into an array of keyed objects. */
export function parseCsv(text: string): Record<string, string>[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0) return [];
	const header = splitLine(lines[0]);
	return lines.slice(1).map((line) => {
		const cells = splitLine(line);
		const row: Record<string, string> = {};
		header.forEach((key, i) => {
			row[key] = (cells[i] ?? "").trim();
		});
		return row;
	});
}

export interface MappedMember {
	name: string;
	email: string | null;
	phone: string | null;
	joinedAt: Date | null;
	originalJoinDate: Date | null;
}

/** Only rows whose Toastmasters status is a paid membership are imported. */
export function isPaid(row: Record<string, string>): boolean {
	return row["Status (*)"] === "PaidMember";
}

/** Parse a Toastmasters M/D/YYYY string into a local-midnight Date, or null. */
export function parseMDY(value: string | undefined): Date | null {
	if (!value) return null;
	const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (!m) return null;
	const month = Number(m[1]);
	const day = Number(m[2]);
	const year = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return new Date(year, month - 1, day);
}

function nonEmpty(value: string | undefined): string | null {
	const v = (value ?? "").trim();
	return v === "" ? null : v;
}

/** Map one CSV row to the member fields we persist (Mobile Phone only). */
export function mapRow(row: Record<string, string>): MappedMember {
	return {
		name: (row.Name ?? "").trim(),
		email: nonEmpty(row.Email),
		phone: nonEmpty(row["Mobile Phone"]),
		joinedAt: parseMDY(row["Member of Club Since"]),
		originalJoinDate: parseMDY(row["Original Join Date"]),
	};
}

export interface ExistingMember {
	id: string;
	email: string | null;
	name: string;
}

export type Match =
	| { kind: "email"; id: string }
	| { kind: "name"; id: string }
	| { kind: "insert" }
	| { kind: "ambiguous" };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Decide how a CSV member reconciles against the club's existing members:
 * email match first, then exact normalized-name match, else insert. A name that
 * matches more than one existing member is ambiguous (skip — never guess).
 */
export function chooseMatch(
	incoming: { email: string | null; name: string },
	existing: ExistingMember[],
): Match {
	const email = norm(incoming.email);
	if (email !== "") {
		const hit = existing.find((e) => norm(e.email) === email);
		if (hit) return { kind: "email", id: hit.id };
	}
	const name = norm(incoming.name);
	const byName = existing.filter((e) => norm(e.name) === name);
	if (byName.length === 1) return { kind: "name", id: byName[0].id };
	if (byName.length > 1) return { kind: "ambiguous" };
	return { kind: "insert" };
}

/** Fill-only: keep a non-empty existing value; otherwise take the incoming one. */
export function fillOnly(
	existing: string | null,
	incoming: string | null,
): string | null {
	return existing && existing.trim() !== "" ? existing : incoming;
}
