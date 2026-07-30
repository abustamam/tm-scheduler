import { describe, expect, it } from "vitest";
import type { HandoffTarget, Slide } from "./agenda-slides";
import { slideLayout, slideName } from "./slide-layout";

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
				owner: "General Evaluator",
				name: "Riyaz",
				time: "2 minutes",
			}),
		).toBe("Evaluation of the Evaluators");
		expect(
			contentHeader({
				kind: "generalEvaluation",
				owner: "General Evaluator",
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

	describe("slide headers name their own segment (#446)", () => {
		// Headers were already asserted for seven kinds via `contentHeader` above,
		// and for distinctness across hand-off targets (#363) — but never for a
		// vote slide, and never ACROSS kinds. The vote slides' BODIES were pinned
		// in full, down to the correct "Please Vote for Best Evaluator:" head line,
		// so the slide read as well covered while the one field nobody checked was
		// the one the grid uses: `slideName` returns `header` verbatim for the
		// jump-to-slide grid, so two kinds sharing one make that grid unusable for
		// the segment they collide on.
		it("gives each of the three votes its own header", () => {
			const headers = [
				contentHeader({
					kind: "voteSpeaker",
					names: ["Jagpal"],
					hasTimer: true,
					caller: null,
				}),
				contentHeader({
					kind: "voteTableTopics",
					hasTimer: true,
					caller: null,
				}),
				contentHeader({
					kind: "voteEvaluator",
					names: ["Riyaz"],
					hasTimer: true,
					caller: null,
				}),
			];
			expect(headers).toEqual([
				"Vote for Best Speaker",
				"Vote for Best Table Topic",
				"Vote for Best Evaluator",
			]);
			expect(new Set(headers).size).toBe(3);
		});

		it("does not let the Best-Evaluator vote borrow the evaluation's header", () => {
			const evaluation = contentHeader({
				kind: "evaluation",
				label: "Evaluation 1",
				evaluator: "Sudheer",
				speaker: "Jagpal",
				time: "3 minutes",
			});
			const vote = contentHeader({
				kind: "voteEvaluator",
				names: ["Riyaz"],
				hasTimer: true,
				caller: null,
			});
			expect(evaluation).toBe("Speech Evaluation");
			expect(vote).not.toBe(evaluation);
		});

		// The two tests above pin the one collision #446 was about. This one closes
		// the CROSS-KIND class: every kind gets the name the jump grid will show it
		// under, and no two KINDS may agree — read through `slideName`, the same
		// function the grid calls, so this binds to the real derivation and not a
		// copy of it. Keyed by `Slide["kind"]`, so a new slide kind does not compile
		// until it is listed here and its own name is checked against all the others
		// — the check that was missing when `voteEvaluator` was written.
		// `slide-layout.ts` already relied on this informally: `functionaryIntro`
		// carries a comment explaining its header avoids colliding with
		// "Toastmaster Intro", with nothing enforcing it until now.
		//
		// It samples ONE slide per kind, so it is deliberately blind to WITHIN-kind
		// repeats, of which the deck has two by design: one `evaluation` per
		// evaluator, and the two hand-offs into the General Evaluator, pinned at
		// agenda-slides.test.ts:683 as four distinct labels across five slides. The
		// property the grid really wants is that no two ADJACENT slides share a
		// name; that test is not here because it does not pass yet (see #458).
		it("gives every slide kind a name no other kind shares", () => {
			const team = [{ role: "Timer", name: "Riyaz" }];
			// Mapped rather than `Record<Slide["kind"], Slide>`: a Record only demands
			// the KEY exist, so a new kind could be satisfied with some other kind's
			// slide — listed, but with its real header never resolved or compared.
			// `Extract` pins each value to its own discriminant.
			const oneOfEach: { [K in Slide["kind"]]: Extract<Slide, { kind: K }> } = {
				title: {
					kind: "title",
					clubName: "MCF Toastmasters Club",
					district: "District 39",
					clubNumber: "28677176",
					meetingNumber: 55,
					scheduledAt: new Date("2026-07-09T02:00:00Z"),
					timezone: "America/Chicago",
				},
				toastmaster: { kind: "toastmaster", name: "Faisal" },
				handoff: {
					kind: "handoff",
					from: { role: "Toastmaster of the Day", name: "Faisal" },
					to: "the speakers",
				},
				toastmasterIntro: {
					kind: "toastmasterIntro",
					theme: "Momentum",
					word: "Synergy",
				},
				wordOfDay: {
					kind: "wordOfDay",
					word: "Synergy",
					definition: "combined action",
					example: null,
					presenter: null,
				},
				functionaryIntro: {
					kind: "functionaryIntro",
					owner: "General Evaluator",
					name: "Sudheer",
					team,
				},
				functionaryReports: {
					kind: "functionaryReports",
					owner: "General Evaluator",
					name: "Sudheer",
					team,
				},
				speech: {
					kind: "speech",
					label: "First Speech",
					speaker: "Jagpal",
					title: "On Momentum",
					projectLevel: null,
					time: "5–7 minutes",
					link: null,
				},
				voteSpeaker: {
					kind: "voteSpeaker",
					names: ["Jagpal"],
					hasTimer: true,
					caller: null,
				},
				tableTopics: {
					kind: "tableTopics",
					master: "Mona",
					timing: "1–2 minutes per speaker",
					word: null,
					definition: null,
				},
				voteTableTopics: {
					kind: "voteTableTopics",
					hasTimer: true,
					caller: null,
				},
				evaluation: {
					kind: "evaluation",
					label: "Evaluation 1",
					evaluator: "Sudheer",
					speaker: "Jagpal",
					time: "3 minutes",
				},
				voteEvaluator: {
					kind: "voteEvaluator",
					names: ["Riyaz"],
					hasTimer: true,
					caller: null,
				},
				evaluatorEvaluation: {
					kind: "evaluatorEvaluation",
					owner: "General Evaluator",
					name: "Sudheer",
					time: "3 minutes",
				},
				generalEvaluation: {
					kind: "generalEvaluation",
					owner: "General Evaluator",
					time: "5 minutes",
				},
				awards: { kind: "awards", categories: ["Best Speaker"] },
				guestComments: { kind: "guestComments" },
				reminders: { kind: "reminders", text: "Dues are due." },
				thankYou: {
					kind: "thankYou",
					meetingSchedule: "2nd & 4th Thursday",
					nextMeetingAt: null,
					timezone: "America/Chicago",
				},
			};

			const labels = Object.values(oneOfEach).map(slideName);
			// Report the offenders, not just a count — a bare size mismatch sends
			// the next person hunting through nineteen cases by hand.
			const duplicated = labels.filter((l, i) => labels.indexOf(l) !== i);
			expect(duplicated).toEqual([]);
			expect(new Set(labels).size).toBe(labels.length);
		});
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
				header: "Hand-off — General Evaluator",
				body: {
					form: "centered",
					lines: [
						{ role: "head", text: "Table Topics Master · Rasheed" },
						{ role: "head", text: "Introduces the General Evaluator" },
					],
				},
			});
		});

		it("names the segment in the header — four targets covering five hand-offs", () => {
			// `slideLabel` (meeting-present.tsx) labels the overview grid with the
			// header verbatim. One shared "Hand-off" would put five identical rows in
			// the one place a jump grid exists to help. Four headers, not five: the
			// two hand-offs INTO the General Evaluator are deliberately
			// indistinguishable here — they are the same transition, and the run
			// sheet separates them by beat id instead (#363).
			const header = (to: HandoffTarget) =>
				contentHeader({
					kind: "handoff",
					from: { role: "Toastmaster of the Day", name: "Faisal" },
					to,
				});
			expect([
				header("the speakers"),
				header("the Table Topics Master"),
				header("the General Evaluator"),
				header("the speech evaluators"),
			]).toEqual([
				"Hand-off — Speakers",
				"Hand-off — Table Topics",
				"Hand-off — General Evaluator",
				"Hand-off — Evaluators",
			]);
		});

		it("falls back to the bare header for an unmapped target", () => {
			// `HandoffTarget` makes an unmapped target unconstructible through the
			// type — adding one is now a compile error in `HANDOFF_HEADER` — so this
			// case is reachable only by casting past it. The cast IS the point: the
			// runtime `??` is a mid-meeting safety net for a target that arrives some
			// other way (stale serialized deck, a `to` widened in a later refactor).
			// A worse grid label must never take the deck down. Keep both.
			expect(
				contentHeader({
					kind: "handoff",
					from: { role: "Toastmaster of the Day", name: "Faisal" },
					to: "the Joke Master" as HandoffTarget,
				}),
			).toBe("Hand-off");
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
					{ role: "head", text: "Introduces the speakers" },
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
			// The attribution comes first, at `strong` — below the `head`
			// instructions it attributes, but never the smallest line on a slide
			// read off a projector. The instructions that follow are unchanged,
			// which the two lines below the slice pin.
			expect(layout.lines).toEqual([
				{ role: "strong", text: "Toastmaster of the Day · Faisal" },
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
					{ role: "strong", text: "Table Topics Master · Rasheed" },
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
					{ role: "strong", text: "General Evaluator · Priya" },
					{ role: "head", text: "Please Vote for Best Evaluator:" },
					{ role: "name", text: "Riyaz" },
				],
			});
		});
	});

	it("evaluation of the evaluators is the GE's evaluator-evaluation slide (#367)", () => {
		const l = slideLayout({
			kind: "evaluatorEvaluation",
			owner: "General Evaluator",
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

	/**
	 * The three slides that used to hardcode the literal "General Evaluator"
	 * (#363). At a club that runs no GE the Toastmaster of the Day covers the
	 * role, so every one of them has to announce the role that is ACTUALLY
	 * speaking — otherwise the wall credits somebody who does not exist.
	 */
	it("names the covering role on all three GE slides, never the literal 'General Evaluator'", () => {
		const owner = "Toastmaster of the Day";
		const texts = (slide: Slide) => {
			const l = slideLayout(slide);
			if (l.chrome !== "content" || l.body.form !== "centered")
				throw new Error("expected centered");
			return l.body.lines.map((x) => x.text);
		};

		expect(
			texts({
				kind: "evaluatorEvaluation",
				owner,
				name: "Schinthia",
				time: "2 minutes",
			}),
		).toEqual(["Toastmaster of the Day:", "Schinthia", "Time: 2 minutes"]);

		expect(
			texts({
				kind: "functionaryReports",
				owner,
				name: "Schinthia",
				team: [{ role: "Timer", name: "Bilal" }],
			}),
		).toEqual(["Toastmaster of the Day:", "Schinthia", "Timer: Bilal"]);

		// This one shows the role but not the holder, and always has — the header
		// names the segment, the first line names the role giving it. The slide
		// carries no holder at all, which is why there is no `name` to pass.
		expect(
			texts({
				kind: "generalEvaluation",
				owner,
				time: "2 minutes",
			}),
		).toEqual(["Toastmaster of the Day", "Closing Remarks", "Time: 2 minutes"]);
	});

	it("keeps naming the General Evaluator on the general-evaluation slide when there is one", () => {
		const l = slideLayout({
			kind: "generalEvaluation",
			owner: "General Evaluator",
			time: "2 minutes",
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines.map((x) => x.text)).toEqual([
				"General Evaluator",
				"Closing Remarks",
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
			owner: "General Evaluator",
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
