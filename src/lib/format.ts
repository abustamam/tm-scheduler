const dateFmt = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

export function formatMeetingDate(value: Date | string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return dateFmt.format(d);
}

export function formatMeetingTime(value: Date | string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return timeFmt.format(d);
}

