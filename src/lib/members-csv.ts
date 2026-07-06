/**
 * Pure helpers for importing the Toastmasters club-membership CSV export.
 * No DB access — unit-tested in isolation; the DB runner is
 * scripts/import-members.ts.
 */
import { type OfficerPosition, parseOfficerPosition } from "#/lib/officers";

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
	// Strip a leading UTF-8 BOM so the first header ("Customer ID") keys cleanly.
	const withoutBom = text.replace(/^﻿/, "");
	const lines = withoutBom.split(/\r?\n/).filter((l) => l.trim() !== "");
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
	/** Toastmasters Customer ID (PN-…); null when the export omits it. */
	customerId: string | null;
	name: string;
	email: string | null;
	phone: string | null;
	joinedAt: Date | null;
	originalJoinDate: Date | null;
	/** CSV "Current Position" parsed to the officer-position enum, or null. */
	officerPosition: OfficerPosition | null;
	/** Raw trimmed "Current Position" value — kept so the importer can tell a
	 *  blank position (silent) from an unparseable one (logged as a warning). */
	currentPosition: string | null;
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

/** Map one CSV row to the person/member fields we persist (Mobile Phone only). */
export function mapRow(row: Record<string, string>): MappedMember {
	const currentPosition = nonEmpty(row["Current Position"]);
	return {
		customerId: nonEmpty(row["Customer ID"]),
		name: (row.Name ?? "").trim(),
		email: nonEmpty(row.Email),
		phone: nonEmpty(row["Mobile Phone"]),
		joinedAt: parseMDY(row["Member of Club Since"]),
		originalJoinDate: parseMDY(row["Original Join Date"]),
		officerPosition: parseOfficerPosition(currentPosition),
		currentPosition,
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

// ---------------------------------------------------------------------------
// Person identity resolution (ADR-0008 / #64)
// ---------------------------------------------------------------------------

/** An existing Person row, as seen when resolving an incoming import row. */
export interface ExistingPerson {
	id: string;
	customerId: string | null;
	email: string | null;
}

export type PersonMatch =
	| { kind: "customerId"; id: string }
	| { kind: "email"; id: string }
	// Non-blank email shared by 2+ distinct people — never auto-merge (spouses /
	// shared family emails). Caller creates a new distinct person.
	| { kind: "ambiguous" }
	| { kind: "insert" };

/**
 * Normalized non-blank emails that appear with 2+ distinct (normalized) names
 * within one import batch — i.e. a shared family/spouse email. Rows carrying
 * such an email must NEVER merge (into each other or an existing person); each
 * becomes a distinct person. This mirrors the migration backfill's global scan
 * so a single CSV can't silently fuse two people who share an email.
 */
export function batchSharedEmails(
	rows: { name: string; email: string | null }[],
): Set<string> {
	const namesByEmail = new Map<string, Set<string>>();
	for (const r of rows) {
		const email = norm(r.email);
		if (email === "") continue;
		const names = namesByEmail.get(email) ?? new Set<string>();
		names.add(norm(r.name));
		namesByEmail.set(email, names);
	}
	const shared = new Set<string>();
	for (const [email, names] of namesByEmail) {
		if (names.size > 1) shared.add(email);
	}
	return shared;
}

/**
 * Resolve an incoming import row to an existing Person by ADR-0008 precedence:
 *   1. Customer ID — exact match when the incoming row has one (always safe).
 *   2. Email — non-blank email resolving to exactly one existing person, and
 *      only among people whose Customer ID doesn't *conflict* with the incoming
 *      one (a different Customer ID means a different person). >1 candidate is
 *      ambiguous — never merge.
 *   3. Otherwise a new person.
 * Never matches on name.
 */
export function resolvePerson(
	incoming: { customerId: string | null; email: string | null },
	existing: ExistingPerson[],
): PersonMatch {
	const cid = norm(incoming.customerId);
	if (cid !== "") {
		const hit = existing.find((p) => norm(p.customerId) === cid);
		if (hit) return { kind: "customerId", id: hit.id };
	}
	const email = norm(incoming.email);
	if (email !== "") {
		const candidates = existing.filter((p) => {
			if (norm(p.email) !== email) return false;
			// Only merge into a person whose Customer ID is blank or equal — a
			// different stored Customer ID marks a distinct human.
			const pc = norm(p.customerId);
			return pc === "" || pc === cid;
		});
		if (candidates.length === 1) return { kind: "email", id: candidates[0].id };
		if (candidates.length > 1) return { kind: "ambiguous" };
	}
	return { kind: "insert" };
}
