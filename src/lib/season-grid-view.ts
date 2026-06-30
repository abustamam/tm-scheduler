import type { SeasonGridData } from "#/server/season-grid";

export type CellKind = "assigned" | "open" | "free" | "na" | "blank";

export interface ViewCell {
	meetingId: string;
	kind: CellKind;
	text: string;
	title: string;
}

export interface ViewRow {
	id: string; // role row key or member id
	label: string;
	kind: "role" | "member";
	/** member id for member rows (for the profile link); undefined for role rows */
	memberId?: string;
	cells: ViewCell[];
}

export type Orientation = "roles" | "members";

export function projectGrid(
	data: SeasonGridData,
	orientation: Orientation,
): ViewRow[] {
	const memberName = new Map(data.members.map((m) => [m.id, m.name]));
	const rowByKey = new Map(
		data.rows.map((r) => [`${r.roleDefinitionId}:${r.slotIndex}`, r]),
	);
	const cellByKey = new Map(
		data.cells.map((c) => [
			`${c.meetingId}:${c.roleDefinitionId}:${c.slotIndex}`,
			c,
		]),
	);
	const naSet = new Set(
		data.unavailable.map((u) => `${u.memberId}:${u.meetingId}`),
	);

	if (orientation === "roles") {
		return data.rows.map((row) => ({
			id: `${row.roleDefinitionId}:${row.slotIndex}`,
			label: row.label,
			kind: "role" as const,
			cells: data.meetings.map((m) => {
				const c = cellByKey.get(
					`${m.id}:${row.roleDefinitionId}:${row.slotIndex}`,
				);
				if (!c)
					return {
						meetingId: m.id,
						kind: "blank" as const,
						text: "",
						title: "",
					};
				if (c.memberId === null)
					return {
						meetingId: m.id,
						kind: "open" as const,
						text: "OPEN",
						title: `${row.label} — open`,
					};
				const name = memberName.get(c.memberId) ?? "—";
				return {
					meetingId: m.id,
					kind: "assigned" as const,
					text: name,
					title: `${name} — ${row.label}`,
				};
			}),
		}));
	}

	// members orientation
	const cellsByMemberMeeting = new Map<string, typeof data.cells>();
	for (const c of data.cells) {
		if (c.memberId === null) continue;
		const key = `${c.memberId}:${c.meetingId}`;
		const list = cellsByMemberMeeting.get(key) ?? [];
		list.push(c);
		cellsByMemberMeeting.set(key, list);
	}

	return data.members.map((member) => ({
		id: member.id,
		label: member.name,
		kind: "member" as const,
		memberId: member.id,
		cells: data.meetings.map((m) => {
			const held = cellsByMemberMeeting.get(`${member.id}:${m.id}`) ?? [];
			if (held.length > 0) {
				const labels = held.map(
					(c) =>
						rowByKey.get(`${c.roleDefinitionId}:${c.slotIndex}`)?.label ??
						"role",
				);
				const codes = held.map(
					(c) =>
						rowByKey.get(`${c.roleDefinitionId}:${c.slotIndex}`)?.shortCode ??
						"?",
				);
				const text =
					held.length > 1
						? `${codes[0] ?? "?"} +${held.length - 1}`
						: (codes[0] ?? "?");
				return {
					meetingId: m.id,
					kind: "assigned" as const,
					text,
					title: labels.join(", "),
				};
			}
			if (naSet.has(`${member.id}:${m.id}`))
				return {
					meetingId: m.id,
					kind: "na" as const,
					text: "NA",
					title: "Not available",
				};
			return {
				meetingId: m.id,
				kind: "free" as const,
				text: "·",
				title: "Free",
			};
		}),
	}));
}
