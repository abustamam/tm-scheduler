/** Short tenure string from a join date, e.g. "3 yrs" / "8 mo" / "6 wks". */
export function formatTenure(joinedAt: Date | string): string {
	const j = typeof joinedAt === "string" ? new Date(joinedAt) : joinedAt;
	const now = new Date();
	const months =
		(now.getFullYear() - j.getFullYear()) * 12 +
		(now.getMonth() - j.getMonth());
	if (months < 1) {
		const weeks = Math.max(
			1,
			Math.round((now.getTime() - j.getTime()) / 6048e5),
		);
		return `${weeks} wk${weeks === 1 ? "" : "s"}`;
	}
	if (months < 12) {
		return `${months} mo`;
	}
	const years = Math.floor(months / 12);
	return `${years} yr${years === 1 ? "" : "s"}`;
}

/** True when a member joined within the last ~90 days (the only "status" we can derive). */
export function isNewMember(joinedAt: Date | string): boolean {
	const j = typeof joinedAt === "string" ? new Date(joinedAt) : joinedAt;
	return Date.now() - j.getTime() < 90 * 24 * 60 * 60 * 1000;
}
