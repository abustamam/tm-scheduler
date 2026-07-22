import { describe, expect, it } from "vitest";
import type { Slide } from "./agenda-slides";
import { slideLayout } from "./slide-layout";

const contentHeader = (slide: Slide) => {
	const l = slideLayout(slide);
	return l.chrome === "content" ? l.header : `splash:${l.tone}`;
};

describe("slideLayout headers (no 'Session', title-only)", () => {
	it("maps section titles without the word Session", () => {
		expect(
			contentHeader({
				kind: "wordOfDay",
				word: "Synergy",
				definition: null,
				example: null,
			}),
		).toBe("Word of the Day");
		expect(
			contentHeader({ kind: "evalIntro", name: "Riyaz", time: "4–6 minutes" }),
		).toBe("Speech Evaluation");
		expect(
			contentHeader({
				kind: "generalEvaluation",
				name: "Riyaz",
				time: "2 minutes",
			}),
		).toBe("General Evaluation");
		expect(
			contentHeader({ kind: "awards", categories: ["Best Speaker"] }),
		).toBe("Award Presentation");
	});

	it("titles the reminders slide 'Announcements'", () => {
		expect(contentHeader({ kind: "reminders", text: "Bring a guest" })).toBe(
			"Announcements",
		);
	});

	it("speech header uses the slide's ordinal label", () => {
		expect(
			contentHeader({
				kind: "speech",
				label: "First Speech",
				speaker: "Jagpal",
				title: null,
				projectLevel: null,
				time: "5–7 minutes",
				link: null,
			}),
		).toBe("First Speech");
	});
});

describe("slideLayout bodies", () => {
	it("toastmaster body is the name only (header carries the role)", () => {
		const l = slideLayout({ kind: "toastmaster", name: "Faisal Ali" });
		expect(l).toMatchObject({ chrome: "content", header: "Toastmaster" });
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines).toEqual([{ role: "head", text: "Faisal Ali" }]);
		} else {
			throw new Error("expected centered body");
		}
	});

	it("speech is left bullets, project shown only when present", () => {
		const withProject = slideLayout({
			kind: "speech",
			label: "First Speech",
			speaker: "Jagpal",
			title: "AI",
			projectLevel: "Level 3",
			time: "5–7 minutes",
			link: null,
		});
		if (
			withProject.chrome === "content" &&
			withProject.body.form === "bullets"
		) {
			expect(withProject.body.items).toEqual([
				"Speaker: Jagpal",
				"Speech Title: “AI”",
				"Project: Level 3",
				"Time: 5–7 minutes",
			]);
		} else {
			throw new Error("expected bullets");
		}
		const noProject = slideLayout({
			kind: "speech",
			label: "First Speech",
			speaker: "Jagpal",
			title: null,
			projectLevel: null,
			time: "5–7 minutes",
			link: null,
		});
		if (noProject.chrome === "content" && noProject.body.form === "bullets") {
			expect(noProject.body.items).toEqual([
				"Speaker: Jagpal",
				"Time: 5–7 minutes",
			]);
		}
	});

	it("speech carries a link on the bullets body only when set (#175)", () => {
		const withLink = slideLayout({
			kind: "speech",
			label: "First Speech",
			speaker: "Jagpal",
			title: "AI",
			projectLevel: null,
			time: "5–7 minutes",
			link: "https://acme.com/deck",
		});
		if (withLink.chrome === "content" && withLink.body.form === "bullets") {
			expect(withLink.body.link).toBe("https://acme.com/deck");
			// The "Link: Presentation" line is rendered from body.link, not an item.
			expect(withLink.body.items).not.toContain("Link: Presentation");
		} else {
			throw new Error("expected bullets");
		}
		const noLink = slideLayout({
			kind: "speech",
			label: "First Speech",
			speaker: "Jagpal",
			title: null,
			projectLevel: null,
			time: "5–7 minutes",
			link: null,
		});
		if (noLink.chrome === "content" && noLink.body.form === "bullets") {
			expect(noLink.body.link).toBeNull();
		}
	});

	it("vote-speaker shows the two prompts then bulleted names", () => {
		const l = slideLayout({
			kind: "voteSpeaker",
			names: ["Jagpal", "Farhanaaz"],
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines).toEqual([
				{ role: "head", text: "Ask for speaking time." },
				{ role: "head", text: "Please Vote for Best Speaker:" },
				{ role: "name", text: "Jagpal" },
				{ role: "name", text: "Farhanaaz" },
			]);
		} else {
			throw new Error("expected centered");
		}
	});

	it("GE team line lists filled roles only", () => {
		const l = slideLayout({
			kind: "geIntro",
			name: "Riyaz",
			team: [
				{ role: "Grammarian", name: "Priya" },
				{ role: "Timer", name: "— open —" },
			],
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			const muted = l.body.lines
				.filter((x) => x.role === "muted")
				.map((x) => x.text);
			expect(muted.join("")).toContain("Grammarian: Priya");
			expect(muted.join("")).not.toContain("open");
		} else {
			throw new Error("expected centered");
		}
	});

	it("title splash sub carries district, club #, date, start time", () => {
		const l = slideLayout({
			kind: "title",
			clubName: "MCF",
			district: "District 39",
			clubNumber: "28677176",
			scheduledAt: new Date("2026-07-10T00:00:00Z"),
			timezone: "UTC",
		});
		expect(l.chrome).toBe("splash");
		if (l.chrome === "splash") {
			expect(l.tone).toBe("light");
			expect(l.headline).toBe("MCF");
			const texts = l.sub.map((s) => s.text ?? "");
			expect(texts).toContain("District 39");
			expect(texts).toContain("Club #28677176");
			expect(texts.some((t) => t.startsWith("Start time:"))).toBe(true);
		}
	});

	it("thankYou splash is dark, gold headline, real next-meeting date", () => {
		const l = slideLayout({
			kind: "thankYou",
			meetingSchedule: "2nd Thu",
			nextMeetingAt: new Date("2026-07-23T18:00:00Z"),
			timezone: "UTC",
		});
		expect(l.chrome).toBe("splash");
		if (l.chrome === "splash") {
			expect(l.tone).toBe("dark");
			expect(l.headline).toBe("Thank You");
			const texts = l.sub.map((s) => s.text ?? "");
			expect(texts).toContain("Next Meeting:");
		}
	});

	it("thankYou falls back to meetingSchedule when there is no next meeting", () => {
		const l = slideLayout({
			kind: "thankYou",
			meetingSchedule: "2nd & 4th Thu",
			nextMeetingAt: null,
			timezone: "UTC",
		});
		if (l.chrome === "splash") {
			expect(l.sub.map((s) => s.text)).toContain("We meet 2nd & 4th Thu");
		}
	});

	it("toastmasterIntro shows only the parts present, spacer only when both", () => {
		const both = slideLayout({
			kind: "toastmasterIntro",
			theme: "Unity",
			word: "Synergy",
		});
		if (both.chrome === "content" && both.body.form === "centered") {
			expect(both.body.lines.map((l) => l.role)).toEqual([
				"head",
				"head",
				"spacer",
				"head",
				"head",
			]);
			expect(both.body.lines.map((l) => l.text)).toEqual([
				"Meeting Theme:",
				"“Unity”",
				undefined,
				"Word of the Day:",
				"“Synergy”",
			]);
		} else throw new Error("expected centered");

		const themeOnly = slideLayout({
			kind: "toastmasterIntro",
			theme: "Unity",
			word: null,
		});
		if (themeOnly.chrome === "content" && themeOnly.body.form === "centered") {
			expect(themeOnly.body.lines.some((l) => l.role === "spacer")).toBe(false);
			expect(themeOnly.body.lines.map((l) => l.text)).toEqual([
				"Meeting Theme:",
				"“Unity”",
			]);
		} else throw new Error("expected centered");
	});

	it("wordOfDay carries word/definition/example (nulls preserved)", () => {
		const l = slideLayout({
			kind: "wordOfDay",
			word: "Synergy",
			definition: "cooperation",
			example: null,
		});
		expect(l.chrome === "content" && l.body).toMatchObject({
			form: "word",
			word: "Synergy",
			definition: "cooperation",
			example: null,
		});
	});

	it("awards is a numbered list of the categories", () => {
		const l = slideLayout({
			kind: "awards",
			categories: ["Best Table Topic", "Best Evaluator", "Best Speaker"],
		});
		expect(l.chrome === "content" && l.body).toMatchObject({
			form: "numbered",
			items: ["Best Table Topic", "Best Evaluator", "Best Speaker"],
		});
	});

	it("reminders maps non-blank lines to trimmed muted lines, blanks to spacers", () => {
		const l = slideLayout({
			kind: "reminders",
			text: "  Bring a guest  \n\nRenew dues",
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines).toEqual([
				{ role: "muted", text: "Bring a guest" },
				{ role: "spacer" },
				{ role: "muted", text: "Renew dues" },
			]);
		} else throw new Error("expected centered");
	});
});
