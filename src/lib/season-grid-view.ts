import type { SeasonGridData } from "#/server/season-grid";

export type CellKind = "assigned" | "open" | "free" | "na" | "blank";

export interface ViewCell {
	meetingId: string;
	kind: CellKind;
	text: string;
	title: string;
	/** `role_slots.id` for a real slot cell (assigned/open/guest); null for a
	 *  blank cell or the read-only members orientation. Enables claim/release. */
	slotId: string | null;
	/** The member holding this slot (roles orientation only) — lets the grid
	 *  tell "yours" from "someone else's". null for open/guest/blank/members. */
	memberId: string | null;
	/** Members orientation, `free` cells only: this (member, meeting) pair is
	 *  in the admin-only `data.contacted` set — drives the outreach dot (#340). */
	contacted?: boolean;
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
	// Cell names resolve from the COMPLETE lookup (covers inactive members who
	// held a role in a past meeting); the members-orientation axis below still
	// derives its rows from the active-only `data.members`.
	const memberName = new Map(data.memberNames.map((m) => [m.id, m.name]));
	const guestName = new Map(data.guestNames.map((g) => [g.id, g.name]));
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
	const contactedSet = new Set(
		data.contacted.map((c) => `${c.memberId}:${c.meetingId}`),
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
						slotId: null,
						memberId: null,
					};
				// Guest-held cell (#151): resolve the guest name + "· Guest" marker.
				if (c.memberId === null && c.guestId !== null) {
					const gname = guestName.get(c.guestId) ?? "—";
					const label = `${gname} · Guest`;
					return {
						meetingId: m.id,
						kind: "assigned" as const,
						text: label,
						title: `${label} — ${row.label}`,
						slotId: c.slotId,
						memberId: null,
					};
				}
				if (c.memberId === null)
					return {
						meetingId: m.id,
						kind: "open" as const,
						text: "OPEN",
						title: `${row.label} — open`,
						slotId: c.slotId,
						memberId: null,
					};
				const name = memberName.get(c.memberId) ?? "—";
				return {
					meetingId: m.id,
					kind: "assigned" as const,
					text: name,
					title: `${name} — ${row.label}`,
					slotId: c.slotId,
					memberId: c.memberId,
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
				// Members orientation is read-only (a cell can aggregate several
				// slots), so it carries no actionable slotId.
				return {
					meetingId: m.id,
					kind: "assigned" as const,
					text,
					title: labels.join(", "),
					slotId: null,
					memberId: null,
				};
			}
			if (naSet.has(`${member.id}:${m.id}`))
				return {
					meetingId: m.id,
					kind: "na" as const,
					text: "NA",
					title: "Not available",
					slotId: null,
					memberId: null,
				};
			return {
				meetingId: m.id,
				kind: "free" as const,
				text: "·",
				title: contactedSet.has(`${member.id}:${m.id}`)
					? "Free · contacted"
					: "Free",
				slotId: null,
				memberId: null,
				contacted: contactedSet.has(`${member.id}:${m.id}`),
			};
		}),
	}));
}

export interface MemberMeetingStatus {
	declined: boolean;
	heldRoleLabels: string[];
}

/**
 * Per-meeting availability status for one member — drives the header
 * "Can't go" chip. `declined` mirrors the NA set; `heldRoleLabels` feeds the
 * release-and-mark confirm dialog when declining a meeting where the member
 * already holds roles.
 */
export function memberMeetingStatus(
	data: SeasonGridData,
	memberId: string | null,
): Map<string, MemberMeetingStatus> {
	const result = new Map<string, MemberMeetingStatus>();
	if (!memberId) return result;

	const labelByRow = new Map(
		data.rows.map((r) => [`${r.roleDefinitionId}:${r.slotIndex}`, r.label]),
	);
	const heldByMeeting = new Map<string, string[]>();
	for (const c of data.cells) {
		if (c.memberId !== memberId) continue;
		const label =
			labelByRow.get(`${c.roleDefinitionId}:${c.slotIndex}`) ?? "a role";
		const list = heldByMeeting.get(c.meetingId) ?? [];
		list.push(label);
		heldByMeeting.set(c.meetingId, list);
	}
	const declined = new Set(
		data.unavailable
			.filter((u) => u.memberId === memberId)
			.map((u) => u.meetingId),
	);

	for (const m of data.meetings) {
		result.set(m.id, {
			declined: declined.has(m.id),
			heldRoleLabels: heldByMeeting.get(m.id) ?? [],
		});
	}
	return result;
}
