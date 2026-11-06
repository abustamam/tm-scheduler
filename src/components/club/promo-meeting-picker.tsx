// The meeting <select> shared by the Promote sheet and the template editor's
// live preview. Option text is the meeting's date, then its theme.

import { Label } from "#/components/ui/label";
import { type FlyerMeeting, promoDate } from "#/lib/promo-template";

export function PromoMeetingPicker({
	id,
	meetings,
	timezone,
	value,
	onChange,
}: {
	id: string;
	meetings: readonly FlyerMeeting[];
	timezone: string;
	value: string;
	onChange: (id: string) => void;
}) {
	return (
		<div className="space-y-1">
			<Label htmlFor={id}>Meeting</Label>
			<select
				id={id}
				className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs md:text-sm dark:bg-input/30"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				{meetings.map((m) => (
					<option key={m.id} value={m.id}>
						{promoDate(m.scheduledAt, timezone)}
						{m.theme ? ` — ${m.theme}` : ""}
					</option>
				))}
			</select>
		</div>
	);
}
