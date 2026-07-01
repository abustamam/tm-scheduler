/**
 * Pure (db-free) helpers for the VPE bulk roster import: parse a pasted block of
 * rows (CSV or tab-separated, so a spreadsheet copy/paste works) into structured
 * rows, and flag each row for preview (blank name, malformed email, likely
 * duplicate). Both the client preview UI (`_authed/index.tsx`) and the server
 * commit (`members-logic.ts#applyBulkImport`) use these so the rules stay in one
 * place. No `#/db` import here — safe in the client bundle.
 */
import { z } from "zod";

export interface ParsedRosterRow {
	name: string;
	email: string;
	phone: string;
	office: string;
}

/** Columns are `name, email, phone, office` (office optional). */
export function parseRosterText(text: string): ParsedRosterRow[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			// Tab-separated (spreadsheet paste) takes precedence; else comma (CSV).
			const cells = line.includes("\t") ? line.split("\t") : line.split(",");
			const [name = "", email = "", phone = "", office = ""] = cells.map((c) =>
				c.trim(),
			);
			return { name, email, phone, office };
		});
}

export function isValidEmail(email: string): boolean {
	return z.string().email().safeParse(email.trim()).success;
}

export type RowIssue = "blank-name" | "invalid-email" | "duplicate";

export interface PreviewRow extends ParsedRosterRow {
	issues: RowIssue[];
	/** True when the row has no issues and will be inserted on commit. */
	willImport: boolean;
}

/**
 * Annotate each parsed row with the issues that would stop it importing.
 * `existing` is the club's current roster (name + email) used for duplicate
 * detection; duplicates within the pasted batch are caught too. Matching is
 * case-insensitive on trimmed name and email.
 */
export function buildImportPreview(
	rows: ParsedRosterRow[],
	existing: { name: string; email: string | null }[],
): PreviewRow[] {
	const existingNames = new Set(
		existing.map((m) => m.name.trim().toLowerCase()).filter(Boolean),
	);
	const existingEmails = new Set(
		existing
			.map((m) => m.email?.trim().toLowerCase())
			.filter((e): e is string => Boolean(e)),
	);
	const seenNames = new Set<string>();
	const seenEmails = new Set<string>();

	return rows.map((row) => {
		const issues: RowIssue[] = [];
		const nameKey = row.name.trim().toLowerCase();
		const emailKey = row.email.trim().toLowerCase();

		if (!nameKey) issues.push("blank-name");
		if (emailKey && !isValidEmail(emailKey)) issues.push("invalid-email");

		const dupExisting =
			(Boolean(nameKey) && existingNames.has(nameKey)) ||
			(Boolean(emailKey) && existingEmails.has(emailKey));
		const dupBatch =
			(Boolean(nameKey) && seenNames.has(nameKey)) ||
			(Boolean(emailKey) && seenEmails.has(emailKey));
		if (dupExisting || dupBatch) issues.push("duplicate");

		if (nameKey) seenNames.add(nameKey);
		if (emailKey) seenEmails.add(emailKey);

		return { ...row, issues, willImport: issues.length === 0 };
	});
}
