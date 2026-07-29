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
				presenter: null,
			}),
		).toBe("Word of the Day");
		expect(
			contentHeader({
				kind: "evaluatorEvaluation",
				name: "Riyaz",
				time: "2 minutes",
			}),
		).toBe("Evaluation of the Evaluators");
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

	it("vote-speaker asks for speaking time only when the club runs a Timer (#367)", () => {
		const lines = (hasTimer: boolean) => {
			const l = slideLayout({
				kind: "voteSpeaker",
				names: ["Jagpal", "Farhanaaz"],
				hasTimer,
				caller: null,
			});
			if (l.chrome !== "content" || l.body.form !== "centered")
				throw new Error("expected centered");
			return l.body.lines;
		};
		expect(lines(true)).toEqual([
			{ role: "head", text: "Ask for speaking time." },
			{ role: "head", text: "Please Vote for Best Speaker:" },
			{ role: "name", text: "Jagpal" },
			{ role: "name", text: "Farhanaaz" },
		]);
		// The Best-Speaker vote beat's fallback drops the timer's-report clause on
		// the same signal; the vote itself still happens. Without this, a club with
		// no Timer prints "Toastmaster · Opens voting for Best Speaker" while the
		// deck tells the presenter to call for a report from a role nobody holds.
		expect(lines(false)).toEqual([
			{ role: "head", text: "Please Vote for Best Speaker:" },
			{ role: "name", text: "Jagpal" },
			{ role: "name", text: "Farhanaaz" },
		]);
	});

	it("vote-table-topics asks for the times only when the club runs a Timer (#367)", () => {
		const lines = (hasTimer: boolean) => {
			const l = slideLayout({
				kind: "voteTableTopics",
				hasTimer,
				caller: null,
			});
			if (l.chrome !== "content" || l.body.form !== "centered")
				throw new Error("expected centered");
			return l.body.lines;
		};
		expect(lines(true)).toEqual([
			{ role: "head", text: "Ask for Table Topics times." },
			{ role: "head", text: "Please Vote for Best Table Topic Speaker:" },
		]);
		// The Best-Table-Topics vote beat's fallback drops the same clause when
		// there is no Timer.
		expect(lines(false)).toEqual([
			{ role: "head", text: "Please Vote for Best Table Topic Speaker:" },
		]);
	});

	it("vote-evaluator asks for the timer's report only when the club runs a Timer (#367)", () => {
		const lines = (hasTimer: boolean) => {
			const l = slideLayout({
				kind: "voteEvaluator",
				names: ["Riyaz"],
				hasTimer,
				caller: null,
			});
			if (l.chrome !== "content" || l.body.form !== "centered")
				throw new Error("expected centered");
			return l.body.lines.map((x) => x.text);
		};
		expect(lines(true)).toEqual([
			"Ask for timer’s report:",
			"Please Vote for Best Evaluator:",
			"Riyaz",
		]);
		// The run sheet drops the timer's-report clause the same way (#367); the
		// vote itself still happens.
		expect(lines(false)).toEqual(["Please Vote for Best Evaluator:", "Riyaz"]);
	});

	describe("handoff layout (#363)", () => {
		const centered = (slide: Slide) => {
			const l = slideLayout(slide);
			if (l.chrome !== "content" || l.body.form !== "centered")
				throw new Error("expected a centered content body");
			return l.body;
		};

		it("reads as a cue for the person handing over", () => {
			expect(
				slideLayout({
					kind: "handoff",
					from: { role: "Table Topics Master", name: "Rasheed" },
					to: "the General Evaluator",
				}),
			).toEqual({
				chrome: "content",
				header: "Hand-off",
				body: {
					form: "centered",
					lines: [
						{ role: "head", text: "Table Topics Master · Rasheed" },
						{ role: "head", text: "introduces the General Evaluator" },
					],
				},
			});
		});

		it("reads the same for a group target — the target is prose, not a role", () => {
			expect(
				centered({
					kind: "handoff",
					from: { role: "Toastmaster of the Day", name: "Faisal" },
					to: "the speakers",
				}),
			).toMatchObject({
				lines: [
					{ role: "head", text: "Toastmaster of the Day · Faisal" },
					{ role: "head", text: "introduces the speakers" },
				],
			});
		});

		it("names the caller above the vote prompt", () => {
			const layout = centered({
				kind: "voteSpeaker",
				names: ["Jagpal"],
				hasTimer: true,
				caller: { role: "Toastmaster of the Day", name: "Faisal" },
			});
			// The attribution comes first and muted; the instructions that follow are
			// unchanged, which the two lines below the slice pin.
			expect(layout.lines).toEqual([
				{ role: "muted", text: "Toastmaster of the Day · Faisal" },
				{ role: "head", text: "Ask for speaking time." },
				{ role: "head", text: "Please Vote for Best Speaker:" },
				{ role: "name", text: "Jagpal" },
			]);
		});

		it("names the caller on the other two vote slides too", () => {
			expect(
				centered({
					kind: "voteTableTopics",
					hasTimer: false,
					caller: { role: "Table Topics Master", name: "Rasheed" },
				}),
			).toMatchObject({
				lines: [
					{ role: "muted", text: "Table Topics Master · Rasheed" },
					{ role: "head", text: "Please Vote for Best Table Topic Speaker:" },
				],
			});
			expect(
				centered({
					kind: "voteEvaluator",
					names: ["Riyaz"],
					hasTimer: false,
					caller: { role: "General Evaluator", name: "Priya" },
				}),
			).toMatchObject({
				lines: [
					{ role: "muted", text: "General Evaluator · Priya" },
					{ role: "head", text: "Please Vote for Best Evaluator:" },
					{ role: "name", text: "Riyaz" },
				],
			});
		});
	});

	it("evaluation of the evaluators is the GE's evaluator-evaluation slide (#367)", () => {
		const l = slideLayout({
			kind: "evaluatorEvaluation",
			name: "Riyaz",
			time: "2 minutes",
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines.map((x) => x.text)).toEqual([
				"General Evaluator:",
				"Riyaz",
				"Time: 2 minutes",
			]);
		} else throw new Error("expected centered");
	});

	it("functionary intro team line lists filled roles only", () => {
		const l = slideLayout({
			kind: "functionaryIntro",
			owner: "General Evaluator",
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

	it("functionary intro names whichever role owns it (#367)", () => {
		const owned = (owner: string) =>
			slideLayout({ kind: "functionaryIntro", owner, name: "Riyaz", team: [] });
		for (const owner of ["Toastmaster of the Day", "General Evaluator"]) {
			const l = owned(owner);
			expect(l).toMatchObject({ chrome: "content", header: "Functionaries" });
			if (l.chrome === "content" && l.body.form === "centered") {
				expect(l.body.lines.map((x) => x.text)).toEqual([`${owner}:`, "Riyaz"]);
			} else {
				throw new Error("expected centered");
			}
		}
	});

	it("functionary reports lists each reporter, skipping open roles (#353)", () => {
		const l = slideLayout({
			kind: "functionaryReports",
			name: "Riyaz",
			team: [
				{ role: "Grammarian", name: "Priya" },
				{ role: "Ah-Counter", name: "— open —" },
				{ role: "Timer", name: "Bilal" },
			],
		});
		expect(l).toMatchObject({
			chrome: "content",
			header: "Functionary Reports",
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines.map((x) => x.text)).toEqual([
				"General Evaluator:",
				"Riyaz",
				"Grammarian: Priya",
				"Timer: Bilal",
			]);
		} else {
			throw new Error("expected centered");
		}
	});

	it("title splash carries the club's meeting number when set (#358)", () => {
		const l = slideLayout({
			kind: "title",
			clubName: "MCF",
			district: "District 39",
			clubNumber: "28677176",
			meetingNumber: 56,
			scheduledAt: new Date("2026-07-10T00:00:00Z"),
			timezone: "UTC",
		});
		expect(l.chrome).toBe("splash");
		if (l.chrome === "splash") {
			expect(l.sub.map((s) => s.text ?? "")).toContain("Meeting #56");
		}
	});

	it("title splash omits the meeting number when the club has none", () => {
		const l = slideLayout({
			kind: "title",
			clubName: "MCF",
			district: null,
			clubNumber: null,
			meetingNumber: null,
			scheduledAt: new Date("2026-07-10T00:00:00Z"),
			timezone: "UTC",
		});
		expect(l.chrome).toBe("splash");
		if (l.chrome === "splash") {
			expect(l.sub.map((s) => s.text ?? "").join(" ")).not.toContain(
				"Meeting #",
			);
		}
	});

	it("title splash sub carries district, club #, date, start time", () => {
		const l = slideLayout({
			kind: "title",
			clubName: "MCF",
			district: "District 39",
			clubNumber: "28677176",
			meetingNumber: null,
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
			presenter: null,
		});
		expect(l.chrome === "content" && l.body).toMatchObject({
			form: "word",
			word: "Synergy",
			definition: "cooperation",
			example: null,
			// No Grammarian on this club's roster ⇒ no attribution line at all.
			presenter: null,
		});
	});

	it("wordOfDay credits the Grammarian who presents it (#354)", () => {
		// The slide now sits inside the Toastmaster's opening, so the copy has to
		// say whose it is rather than letting its position imply the Toastmaster
		// (or, under MCF's variant, the General Evaluator) delivers it.
		const held = slideLayout({
			kind: "wordOfDay",
			word: "Synergy",
			definition: "cooperation",
			example: null,
			presenter: { role: "Grammarian", name: "Mona" },
		});
		expect(held.chrome === "content" && held.body).toMatchObject({
			form: "word",
			presenter: "Presented by the Grammarian · Mona",
		});

		// Unclaimed: still the Grammarian's, just nobody's yet — the role alone,
		// never "Presented by the Grammarian · — open —".
		const open = slideLayout({
			kind: "wordOfDay",
			word: "Synergy",
			definition: "cooperation",
			example: null,
			presenter: { role: "Grammarian", name: "— open —" },
		});
		expect(open.chrome === "content" && open.body).toMatchObject({
			presenter: "Presented by the Grammarian",
		});

		// The club's own name for the role, so a renamed Grammarian is credited
		// as the club calls them (#368).
		const renamed = slideLayout({
			kind: "wordOfDay",
			word: "Synergy",
			definition: "cooperation",
			example: null,
			presenter: { role: "Wordsmith", name: "Mona" },
		});
		expect(renamed.chrome === "content" && renamed.body).toMatchObject({
			presenter: "Presented by the Wordsmith · Mona",
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

	// #355. #354 made the standalone `wordOfDay` slide the PRESENTATION of the
	// word — full size, definition and example, credited to the Grammarian who
	// delivers it. This is the other half: a REMINDER, kept in front of the room
	// for the ten minutes the word is actually being used. No example, and no
	// presenter credit, because nobody is presenting it here.
	it("table topics reminds the room of the Word of the Day (#355)", () => {
		const l = slideLayout({
			kind: "tableTopics",
			master: "Rasheed",
			timing: "1–2 minutes per speaker",
			word: "Momentum",
			definition: "impetus gained by a moving object",
		});
		if (l.chrome === "content" && l.body.form === "bullets") {
			expect(l.body.items).toEqual([
				"Table Topic Master: Rasheed",
				"Impromptu Speeches",
				"Speaker time: 1–2 minutes per speaker",
				"Word of the Day: “Momentum”",
			]);
			// The definition rides under the word as a muted note rather than a
			// fourth 40pt bullet — it is context, not an instruction.
			expect(l.body.note).toBe("impetus gained by a moving object");
		} else throw new Error("expected bullets");
	});

	it("table topics shows the word with no definition, and neither when unset", () => {
		const wordOnly = slideLayout({
			kind: "tableTopics",
			master: "Rasheed",
			timing: "1–2 minutes per speaker",
			word: "Momentum",
			definition: null,
		});
		if (wordOnly.chrome === "content" && wordOnly.body.form === "bullets") {
			expect(wordOnly.body.items).toContain("Word of the Day: “Momentum”");
			expect(wordOnly.body.note).toBeNull();
		} else throw new Error("expected bullets");

		const none = slideLayout({
			kind: "tableTopics",
			master: "Rasheed",
			timing: "1–2 minutes per speaker",
			word: null,
			definition: null,
		});
		if (none.chrome === "content" && none.body.form === "bullets") {
			expect(none.body.items).toEqual([
				"Table Topic Master: Rasheed",
				"Impromptu Speeches",
				"Speaker time: 1–2 minutes per speaker",
			]);
			expect(none.body.note).toBeNull();
		} else throw new Error("expected bullets");
	});

	it("guest comments is a generic invitation, with no names on it (#352)", () => {
		// A first cut deliberately: the meeting's recorded guests could be named
		// here, but a guest who came without being booked in is the common case and
		// a slide that lists only the known ones reads as excluding the rest.
		const l = slideLayout({ kind: "guestComments" });
		expect(l.chrome === "content" && l.header).toBe("Guest Comments");
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines).toEqual([
				{ role: "head", text: "We’d love to hear from our guests." },
				{ role: "muted", text: "How did you find the meeting today?" },
			]);
		} else throw new Error("expected centered");
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
