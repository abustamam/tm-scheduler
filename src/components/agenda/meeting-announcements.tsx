import { Megaphone } from "lucide-react";
import { announcementLines } from "#/lib/announcement-lines";

/**
 * Plain inline "Announcements" section for the on-screen meeting agenda (not a
 * highlighted callout). Renders nothing when there are no announcements.
 */
export function MeetingAnnouncements({
	text,
}: {
	text: string | null | undefined;
}) {
	const lines = announcementLines(text);
	if (lines.length === 0) return null;
	return (
		<section className="space-y-1.5">
			<h2 className="flex items-center gap-1.5 text-sm font-semibold">
				<Megaphone className="size-4 text-primary" aria-hidden />
				Announcements
			</h2>
			<ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
				{lines.map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id and can repeat
					<li key={`${i}-${line}`}>{line}</li>
				))}
			</ul>
		</section>
	);
}
