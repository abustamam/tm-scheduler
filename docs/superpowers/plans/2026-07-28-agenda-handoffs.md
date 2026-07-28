# Agenda Hand-off Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generated agenda state who hands off to whom, so nobody at the front of the room has to guess whose cue it is.

**Architecture:** Hand-offs are ordinary `kind: "role"` beats with `minutes: 0` — no new beat kind, and no arithmetic changes, because `buildTimeline` already advances `cursor += 0` and `applyFlex` already sums `minutes`. Two small additions to the `Beat` type carry the variance: a reshaped `fallback` that swaps a beat's owner or detail when a role is absent, and a `renderUnowned` flag for beats that must print even when their owning role has no slot. The printed row model gains a `handoff` marker so the four print layouts can render transitions as a compact band, and the deck gains one slide kind.

**Tech Stack:** TypeScript (strict), Vitest, React 19, Biome (tabs, double quotes).

**Spec:** `docs/superpowers/specs/2026-07-28-agenda-handoffs-design.md`

**Issue:** #363

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/agenda-runsheet.ts` | Beat template + expansion to rows | Core: `BeatFallback`, `renderUnowned`, hand-off beats, vote/awards owners, `AgendaRow.handoff` |
| `src/lib/agenda-runsheet.test.ts` | Unit tests for the above | Rewrite the positive-duration test; new coverage |
| `src/lib/agenda-slides.ts` | Deck construction | New `handoff` slide; `caller` on the three vote slides |
| `src/lib/slide-layout.ts` | The one place deciding slide copy/layout | New `case "handoff"`; vote cases render the caller |
| `src/components/agenda/meeting-agenda-print.tsx` | Four print layouts | Compact band for `handoff` rows at 3 sites; unique row keys |
| `src/lib/agenda-parity.test.ts` | print ⇄ deck contract | Extend to hand-offs and the vote caller |

`meeting-present.tsx` and `deck-to-pptx.ts` need **no changes** — both consume only `SlideLayout`, never `slide.kind`.

---

## Task 1: Beat mechanics — `BeatFallback` and `renderUnowned`

Pure machinery. No beat uses the new capabilities yet, so behaviour is unchanged and every existing test must still pass.

**Files:**
- Modify: `src/lib/agenda-runsheet.ts:104-125` (the `Beat` type), `:695-784` (`expandRunSheet`)
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/agenda-runsheet.test.ts`:

```ts
describe("BeatFallback — owner and detail swap (#363)", () => {
	const TM = { roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day" };
	const TTM = { roleKey: "table_topics_master", roleName: "Table Topics Master" };

	const beat: Beat = {
		kind: "role",
		...TTM,
		role: "plain",
		detail: "Introduces the General Evaluator",
		minutes: 0,
		fallback: { unless: TTM, owner: TM },
	};

	it("keeps the beat's own owner when the `unless` role has a slot", () => {
		const slots = [slot({ roleKey: "table_topics_master", roleName: "Table Topics Master", category: "leadership", assigneeName: "Rasheed" })];
		expect(expandRunSheet(slots, [beat])).toEqual([
			{ who: "Table Topics Master · Rasheed", detail: "Introduces the General Evaluator", minutes: 0, marks: null },
		]);
	});

	it("swaps to the fallback owner when the `unless` role has no slot", () => {
		const slots = [slot({ roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" })];
		expect(expandRunSheet(slots, [beat])).toEqual([
			{ who: "Toastmaster of the Day · Faisal", detail: "Introduces the General Evaluator", minutes: 0, marks: null },
		]);
	});

	it("swaps only the detail when the fallback names no owner", () => {
		const withDetail: Beat = { ...beat, fallback: { unless: { roleKey: "timer", roleName: "Timer" }, detail: "Vote Best Speaker" } };
		const slots = [slot({ roleKey: "table_topics_master", roleName: "Table Topics Master", category: "leadership", assigneeName: "Rasheed" })];
		expect(expandRunSheet(slots, [withDetail])[0]).toMatchObject({
			who: "Table Topics Master · Rasheed",
			detail: "Vote Best Speaker",
		});
	});

	it("omits the beat when neither the owner nor the fallback owner has a slot", () => {
		expect(expandRunSheet([], [beat])).toEqual([]);
	});
});

describe("renderUnowned (#363)", () => {
	it("renders the bare role name when the owning role has no slot", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Vote Best Speaker",
			minutes: 1,
			renderUnowned: true,
		};
		expect(expandRunSheet([], [beat])).toEqual([
			{ who: "Toastmaster of the Day", detail: "Vote Best Speaker", minutes: 1, marks: null },
		]);
	});

	it("still prefers the assignee when the role IS held", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Vote Best Speaker",
			minutes: 1,
			renderUnowned: true,
		};
		const slots = [slot({ roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" })];
		expect(expandRunSheet(slots, [beat])[0].who).toBe("Toastmaster of the Day · Faisal");
	});

	it("omits an unowned beat WITHOUT the flag — the existing default is unchanged", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Opens meeting",
			minutes: 3,
		};
		expect(expandRunSheet([], [beat])).toEqual([]);
	});
});
```

Add `Beat` to the type import at the top of the file:

```ts
import type { AgendaRow, AgendaSlot, Beat } from "./agenda-runsheet";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "BeatFallback"`
Expected: FAIL — TypeScript rejects `fallback: { unless: ... }` and `renderUnowned` (not in the `Beat` type).

- [ ] **Step 3: Reshape `fallback` and add `renderUnowned`**

In `src/lib/agenda-runsheet.ts`, replace the `Beat` type (currently lines 104–125) with:

```ts
/**
 * An alternative owner and/or detail, used when `unless` has no slots this
 * meeting (#363). Generalises the old event-only `fallback`, which could only
 * name a replacement `who` as a bare string — a string that named a role which
 * does not exist ("Toastmaster", when the role is "Toastmaster of the Day") and
 * did not follow a club rename.
 *
 * Two jobs, one mechanism:
 * - `{ unless: TIMER, detail: … }` drops a vote beat's timer's-report clause at
 *   a club with no Timer — exactly the old behaviour.
 * - `{ unless: TABLE_TOPICS_ROLE, owner: TOASTMASTER_ROLE }` moves a hand-off to
 *   whoever is actually holding the room: with no Table Topics segment, the
 *   Toastmaster never gave the room away, so the Toastmaster introduces the
 *   General Evaluator rather than the row vanishing.
 */
export type BeatFallback = {
	/** The role whose ABSENCE triggers the fallback. */
	unless: BeatRole;
	/** Owning role for the fallback row; omitted ⇒ keep the beat's own owner. */
	owner?: BeatRole;
	/** Detail for the fallback row; omitted ⇒ keep the beat's own detail. */
	detail?: string;
};

export type Beat = (
	| {
			kind: "event";
			who: string;
			detail: string;
			minutes: number;
	  }
	| {
			kind: "role";
			roleKey: string;
			roleName: string;
			role: "plain" | "speaker" | "evaluator";
			detail: string;
			minutes: number;
			/** Render this beat even when the owning role has no slot this meeting,
			 *  as the bare role name with no assignee (#363). For beats that are
			 *  ABOUT a segment rather than about their owner — the three votes and
			 *  the awards. Without it a club that disabled Toastmaster of the Day
			 *  would lose the Best-Speaker vote from the printed agenda while
			 *  `buildSlideDeck` still projected the slide. */
			renderUnowned?: true;
	  }
) & {
	id?: BeatId;
	requiresAnyOf?: BeatRole[];
	requiresGroup?: RoleGroup;
	fallback?: BeatFallback;
	flex?: true;
	/** A 0-minute transition — "X introduces Y". Marks the row so the print
	 *  layouts can render it as a compact band rather than a full segment
	 *  block (#363). */
	handoff?: true;
};
```

- [ ] **Step 4: Apply the fallback in `expandRunSheet`**

In `expandRunSheet`, replace the `if (missingRequired) … else if (beat.kind === "event") … else { … }` body (currently lines 709–776) with:

```ts
		if (missingRequired) {
			// omitted
		} else if (beat.kind === "event") {
			const fb = beat.fallback;
			const useFallback =
				fb != null && !hasRole(slots, fb.unless.roleKey, fb.unless.roleName);
			rows.push({
				who: useFallback ? (fb.owner?.roleName ?? beat.who) : beat.who,
				detail: useFallback ? (fb.detail ?? detail) : detail,
				minutes: beat.minutes,
				marks: null,
			});
		} else {
			// A fallback may move the beat to a different owner (#363) — resolve the
			// owner BEFORE looking up slots, so the row binds to the right role.
			const fb = beat.fallback;
			const useFallback =
				fb != null && !hasRole(slots, fb.unless.roleKey, fb.unless.roleName);
			const owner =
				useFallback && fb.owner != null
					? fb.owner
					: { roleKey: beat.roleKey, roleName: beat.roleName };
			const beatDetail = useFallback ? (fb.detail ?? detail) : detail;
			const matching = slotsForRole(slots, owner.roleKey, owner.roleName);

			if (beat.role === "speaker") {
				const ordered = [...matching].sort((a, b) => a.slotIndex - b.slotIndex);
				const multi = ordered.length > 1;
				ordered.forEach((s, i) => {
					// The row's two numbers answer two different questions (#394), so
					// they read two different helpers: the marks need an assigned
					// RANGE (both ends, or none at all), while the clock needs an
					// ALLOWANCE, which a max alone states perfectly well. Same
					// `speechBookedMinutes` the deck projects, so the printed clock and
					// the projector cannot drift.
					const w = speechWindow(s);
					const marks = w
						? { green: w.min, yellow: (w.min + w.max) / 2, red: w.max }
						: null;
					rows.push({
						who: `${numbered(owner.roleName, i, multi)} · ${assigneeDisplay(s)}`,
						detail: s.speechTitle
							? `"${s.speechTitle}"${s.projectLevel ? ` · ${s.projectLevel}` : ""}`
							: beatDetail,
						minutes: speechBookedMinutes(s),
						marks,
					});
				});
			} else if (beat.role === "evaluator") {
				const ordered = orderEvaluators(matching, slots);
				const multi = ordered.length > 1;
				ordered.forEach((s, i) => {
					rows.push({
						who: `${numbered(owner.roleName, i, multi)} · ${assigneeDisplay(s)}`,
						detail: s.evaluates?.speakerName
							? `Evaluates ${s.evaluates.speakerName}`
							: beatDetail,
						minutes: beat.minutes,
						marks: null,
					});
				});
			} else if (matching.length === 0) {
				// Role not run by this club this meeting (#367/#368: disabled ⇒ no
				// slots generated). Normally omit rather than printing a ghost row —
				// unless the beat is about a SEGMENT rather than its owner (#363), in
				// which case the bare role name still carries the instruction.
				if (beat.renderUnowned) {
					rows.push({
						who: owner.roleName,
						detail: beatDetail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			} else {
				for (const s of matching) {
					rows.push({
						who: `${owner.roleName} · ${assigneeDisplay(s)}`,
						detail: beatDetail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			}
		}
```

- [ ] **Step 5: Update the three existing vote-beat fallback literals**

They still use the old shape. In `buildRunOfShow`, change each of the three vote beats' `fallback` from:

```ts
			fallback: {
				roleKey: "timer",
				who: "Toastmaster",
				detail: "Vote Best Speaker",
			},
```

to:

```ts
			fallback: {
				unless: { roleKey: "timer", roleName: "Timer" },
				owner: TOASTMASTER_ROLE,
				detail: "Vote Best Speaker",
			},
```

Do the same for the Table Topics and Evaluator vote beats, keeping their own detail strings (`"Vote Best Table Topics"`, `"Vote Best Evaluator"`).

Note: these are still `kind: "event"` beats at this point, so `fb.owner?.roleName` yields `"Toastmaster of the Day"` where it previously yielded `"Toastmaster"`. Update the existing assertion in `agenda-runsheet.test.ts:627` ("reassigns the vote beats to the Toastmaster…") to expect `"Toastmaster of the Day"`. Task 2 replaces these beats entirely.

- [ ] **Step 6: Run the full unit suite**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run check`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "refactor(agenda): generalise beat fallback; add renderUnowned (#363)"
```

---

## Task 2: The vote beats move from the Timer to the segment leader

Gap G — the row that currently reads `Timer` and gives the person who must actually ask for the report no cue.

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (`buildRunOfShow`)
- Test: `src/lib/agenda-runsheet.test.ts:580-643` (rewrite the "Timer vote-beat fallback" describe block)

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe("expandRunSheet — Timer vote-beat fallback (#367)", …)` block with:

```ts
describe("expandRunSheet — vote beats are owned by the segment leader (#363)", () => {
	const full = () => [
		slot({ id: "tm", roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" }),
		slot({ id: "sp", roleKey: "speaker", roleName: "Speaker", category: "speaker", isSpeakerRole: true, assigneeName: "Jagpal" }),
		slot({ id: "ttm", roleKey: "table_topics_master", roleName: "Table Topics Master", category: "leadership", assigneeName: "Rasheed" }),
		slot({ id: "ev", roleKey: "evaluator", roleName: "Evaluator", category: "evaluator", assigneeName: "Sudheer" }),
		slot({ id: "ge", roleKey: "general_evaluator", roleName: "General Evaluator", category: "leadership", assigneeName: "Riyaz" }),
		slot({ id: "ti", roleKey: "timer", roleName: "Timer", category: "functionary", assigneeName: "Muhammad" }),
	];

	const voteRows = (rows: AgendaRow[]) => rows.filter((r) => /vote /i.test(r.detail));

	it("attributes each vote to the leader running that segment", () => {
		const rows = voteRows(expandRunSheet(full(), RUN_OF_SHOW));
		expect(rows.map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Calls for the Timer's report · vote Best Speaker"],
			["Table Topics Master · Rasheed", "Calls for the Timer's report · vote Best Table Topics"],
			["General Evaluator · Riyaz", "Calls for the Timer's report · vote Best Evaluator"],
		]);
	});

	it("drops the timer's-report clause, keeping the leader, when there is no Timer", () => {
		const noTimer = full().filter((s) => s.roleKey !== "timer");
		expect(voteRows(expandRunSheet(noTimer, RUN_OF_SHOW)).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Vote Best Speaker"],
			["Table Topics Master · Rasheed", "Vote Best Table Topics"],
			["General Evaluator · Riyaz", "Vote Best Evaluator"],
		]);
	});

	it("never gives the Timer a row of its own — the report is the leader's cue", () => {
		const rows = expandRunSheet(full(), RUN_OF_SHOW);
		expect(rows.filter((r) => r.who.startsWith("Timer"))).toEqual([]);
	});

	it("still prints the vote, unattributed, at a club that disabled its Toastmaster", () => {
		const noTm = full().filter((s) => s.roleKey !== "toastmaster_of_the_day");
		expect(voteRows(expandRunSheet(noTm, RUN_OF_SHOW))[0]).toMatchObject({
			who: "Toastmaster of the Day",
			detail: "Calls for the Timer's report · vote Best Speaker",
		});
	});

	it("omits a vote whose segment the club does not run", () => {
		const noTopics = full().filter((s) => s.roleKey !== "table_topics_master");
		expect(voteRows(expandRunSheet(noTopics, RUN_OF_SHOW)).map((r) => r.detail)).toEqual([
			"Calls for the Timer's report · vote Best Speaker",
			"Calls for the Timer's report · vote Best Evaluator",
		]);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "segment leader"`
Expected: FAIL — rows still read `who: "Timer"`.

- [ ] **Step 3: Convert the three vote beats**

In `buildRunOfShow`, replace each of the three `kind: "event"` vote beats. The Best-Speaker one becomes:

```ts
		{
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Calls for the Timer's report · vote Best Speaker",
			minutes: 1,
			renderUnowned: true,
			fallback: {
				unless: { roleKey: "timer", roleName: "Timer" },
				detail: "Vote Best Speaker",
			},
			requiresAnyOf: [SPEAKER_ROLE],
		},
```

The Table Topics one is identical but spread `...TABLE_TOPICS_ROLE`, detail `"Calls for the Timer's report · vote Best Table Topics"`, fallback detail `"Vote Best Table Topics"`, and `requiresAnyOf: [TABLE_TOPICS_ROLE]`.

The Evaluator one spreads `roleKey: "general_evaluator", roleName: "General Evaluator"`, detail `"Calls for the Timer's report · vote Best Evaluator"`, fallback detail `"Vote Best Evaluator"`, and `requiresAnyOf: [EVALUATOR_ROLE]`.

Note the Best-Table-Topics beat is owned by the Table Topics Master and gated on the same role, so its `requiresAnyOf` and its owner coincide — that is intentional and `renderUnowned` never fires for it.

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS. If `describe("buildRunOfShow")`'s beat-count or vote-gating assertions fail, update the expected counts — the beat count is unchanged (3 events became 3 roles) but `it("gates each vote beat on the segment it belongs to")` now reads `beat.kind === "role"`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "fix(agenda): the segment leader calls for the Timer's report, not the Timer (#363)"
```

---

## Task 3: The awards beat becomes role-bound

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (`buildRunOfShow`, the awards beat)
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("awards beat is role-bound (#363)", () => {
	it("names the Toastmaster who presents them", () => {
		const slots = [
			slot({ id: "tm", roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" }),
			slot({ id: "sp", roleKey: "speaker", roleName: "Speaker", category: "speaker", isSpeakerRole: true }),
		];
		const awards = expandRunSheet(slots, RUN_OF_SHOW).find((r) => r.detail.startsWith("Awards"));
		expect(awards?.who).toBe("Toastmaster of the Day · Faisal");
	});

	it("follows a club rename, because it binds by key not by string", () => {
		const slots = [
			slot({ id: "tm", roleKey: "toastmaster_of_the_day", roleName: "Master of Ceremonies", category: "leadership", assigneeName: "Faisal" }),
			slot({ id: "sp", roleKey: "speaker", roleName: "Speaker", category: "speaker", isSpeakerRole: true }),
		];
		const awards = expandRunSheet(slots, RUN_OF_SHOW).find((r) => r.detail.startsWith("Awards"));
		expect(awards?.who).toBe("Master of Ceremonies · Faisal");
	});

	it("still hands out awards at a club with no Toastmaster of the Day", () => {
		const slots = [slot({ id: "sp", roleKey: "speaker", roleName: "Speaker", category: "speaker", isSpeakerRole: true })];
		const awards = expandRunSheet(slots, RUN_OF_SHOW).find((r) => r.detail.startsWith("Awards"));
		expect(awards?.who).toBe("Toastmaster of the Day");
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "awards beat is role-bound"`
Expected: FAIL — `who` is the bare string `"Toastmaster"`.

- [ ] **Step 3: Convert the awards beat**

Replace it with:

```ts
		{
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: `Awards · ${AWARDS_TOKEN}`,
			minutes: 2,
			renderUnowned: true,
			requiresAnyOf: AWARD_CATEGORIES.map((a) => a.role),
		},
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "fix(agenda): name the Toastmaster who presents the awards (#363)"
```

---

## Task 4: The hand-off beats

Gaps B, B2, C, D, plus making #438's "Introduces the speakers" universal and 0-minute.

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (`AgendaRow`, `buildRunOfShow`, `expandRunSheet`)
- Test: `src/lib/agenda-runsheet.test.ts:43-196`

- [ ] **Step 1: Write the failing tests**

```ts
describe("hand-off beats — who introduces whom (#363)", () => {
	const nine = () => [
		slot({ id: "tm", roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" }),
		slot({ id: "ttm", roleKey: "table_topics_master", roleName: "Table Topics Master", category: "leadership", assigneeName: "Rasheed" }),
		slot({ id: "sp", roleKey: "speaker", roleName: "Speaker", category: "speaker", isSpeakerRole: true, assigneeName: "Jagpal" }),
		slot({ id: "ev", roleKey: "evaluator", roleName: "Evaluator", category: "evaluator", assigneeName: "Sudheer" }),
		slot({ id: "ge", roleKey: "general_evaluator", roleName: "General Evaluator", category: "leadership", assigneeName: "Riyaz" }),
		slot({ id: "ti", roleKey: "timer", roleName: "Timer", category: "functionary", assigneeName: "Muhammad" }),
	];
	const handoffs = (rows: AgendaRow[]) => rows.filter((r) => r.handoff === true);

	it("every hand-off books zero minutes", () => {
		for (const flag of [true, false]) {
			const rows = expandRunSheet(nine(), buildRunOfShow({ geIntroducesFunctionaries: flag }));
			expect(handoffs(rows).every((r) => r.minutes === 0)).toBe(true);
		}
	});

	it("states the full MCF chain, in order", () => {
		const rows = expandRunSheet(nine(), buildRunOfShow({ geIntroducesFunctionaries: true }));
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Introduces the General Evaluator"],
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			["Toastmaster of the Day · Faisal", "Introduces the Table Topics Master"],
			["Table Topics Master · Rasheed", "Introduces the General Evaluator"],
			["General Evaluator · Riyaz", "Introduces the speech evaluators"],
		]);
	});

	it("omits the opening GE introduction in the standard flow, where the GE has no early appearance", () => {
		const rows = expandRunSheet(nine(), buildRunOfShow({ geIntroducesFunctionaries: false }));
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			["Toastmaster of the Day · Faisal", "Introduces the Table Topics Master"],
			["Table Topics Master · Rasheed", "Introduces the General Evaluator"],
			["General Evaluator · Riyaz", "Introduces the speech evaluators"],
		]);
	});

	it("hands to the GE from the Toastmaster when the club runs no Table Topics", () => {
		const noTopics = nine().filter((s) => s.roleKey !== "table_topics_master");
		const rows = expandRunSheet(noTopics, RUN_OF_SHOW);
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			["Toastmaster of the Day · Faisal", "Introduces the General Evaluator"],
			["General Evaluator · Riyaz", "Introduces the speech evaluators"],
		]);
	});

	it("has the Toastmaster introduce the evaluators when the club runs no General Evaluator", () => {
		const noGe = nine().filter((s) => s.roleKey !== "general_evaluator");
		const rows = expandRunSheet(noGe, RUN_OF_SHOW);
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toContainEqual([
			"Toastmaster of the Day · Faisal",
			"Introduces the speech evaluators",
		]);
	});

	it("promises no segment the club does not run", () => {
		const bare = [slot({ id: "tm", roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" })];
		expect(handoffs(expandRunSheet(bare, RUN_OF_SHOW))).toEqual([]);
	});

	it("leaves the meeting one minute shorter under the MCF variant (the old handback booked a minute)", () => {
		const rows = expandRunSheet(nine(), buildRunOfShow({ geIntroducesFunctionaries: true }));
		const std = expandRunSheet(nine(), buildRunOfShow({ geIntroducesFunctionaries: false }));
		const total = (rs: AgendaRow[]) => rs.reduce((n, r) => n + r.minutes, 0);
		expect(total(rows)).toBe(total(std));
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "hand-off beats"`
Expected: FAIL — `r.handoff` is not a property of `AgendaRow`.

- [ ] **Step 3: Add `handoff` to `AgendaRow`**

In `src/lib/agenda-runsheet.ts`, extend the `AgendaRow` type (currently lines 57–65):

```ts
/** One rendered agenda row (no clock time yet — buildTimeline adds it). */
export type AgendaRow = {
	who: string; // "Speaker 1 · Rehanna Khan", "Sergeant-at-Arms", "Timer"
	detail: string;
	minutes: number; // duration this row contributes to the running clock
	marks: TimingMarks | null;
	/** True on the single squishy row (Table Topics). `applyFlex` resizes it. */
	flex?: boolean;
	/** True on a 0-minute transition row — "X introduces Y" (#363). The print
	 *  layouts render these as a compact band rather than a full segment block,
	 *  so a hand-off never reads as a duplicate of the row it precedes. */
	handoff?: boolean;
};
```

- [ ] **Step 4: Propagate the flag in `expandRunSheet`**

At the end of the `for (const beat of template)` loop, immediately before the existing `if (beat.flex && …)` block, add:

```ts
		// A hand-off beat marks every row it produced (a leadership role has one
		// slot in practice, but the loop above does not assume that).
		if (beat.handoff) {
			for (let i = startLen; i < rows.length; i++) {
				rows[i] = { ...rows[i], handoff: true };
			}
		}
```

- [ ] **Step 5: Add the hand-off beats to `buildRunOfShow`**

First add the two role constants the new beats need, next to the existing `TOASTMASTER_ROLE` declaration:

```ts
/** The General Evaluator, named once because four beats bind to it. */
const GENERAL_EVALUATOR_ROLE: BeatRole = {
	roleKey: "general_evaluator",
	roleName: "General Evaluator",
};
```

Replace the `handback` const (currently lines 370–381) with:

```ts
	/**
	 * MCF's variant only: the Toastmaster introduces the General Evaluator before
	 * handing them the room for the functionary introductions (#363). The
	 * standard flow has no early GE appearance, so there is nothing to introduce
	 * and this beat does not exist there.
	 *
	 * Gated on the GE, not on the functionaries: the row introduces a person, and
	 * a club with no General Evaluator has nobody to introduce.
	 */
	const geOpeningIntro: Beat[] = geIntroducesFunctionaries
		? [
				{
					kind: "role",
					...TOASTMASTER_ROLE,
					role: "plain",
					detail: "Introduces the General Evaluator",
					minutes: 0,
					handoff: true,
					requiresAnyOf: [GENERAL_EVALUATOR_ROLE],
				},
			]
		: [];
```

Then insert the beats. In the returned array:

1. Put `...geOpeningIntro` **before** the functionary-intro beat (it introduces the person who runs it), and delete the old `...handback` spread.
2. Immediately before the speaker beat, insert the now-universal speakers hand-off:

```ts
		{
			// Universal since #363. #438 added this for MCF only, reasoning that in
			// the standard flow the Toastmaster is already holding the room — but the
			// Table Topics hand-off below is added on exactly that reasoning, so
			// being explicit in both flows is the consistent choice. Gated on the
			// SPEAKERS: a row must never promise speakers a club is not running.
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Introduces the speakers",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [SPEAKER_ROLE],
		},
```

3. Immediately before the Table Topics beat, insert:

```ts
		{
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Introduces the Table Topics Master",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [TABLE_TOPICS_ROLE],
		},
```

4. Immediately after the Best-Table-Topics vote beat, insert the two hand-offs into the evaluation segment:

```ts
		{
			// The Table Topics Master is holding the room when the segment ends, so
			// they hand to the GE. With no Table Topics segment the Toastmaster never
			// gave the room away, so the fallback puts the hand-off back on them
			// rather than dropping it (#363).
			kind: "role",
			...TABLE_TOPICS_ROLE,
			role: "plain",
			detail: "Introduces the General Evaluator",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [GENERAL_EVALUATOR_ROLE],
			fallback: { unless: TABLE_TOPICS_ROLE, owner: TOASTMASTER_ROLE },
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			role: "plain",
			detail: "Introduces the speech evaluators",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [EVALUATOR_ROLE],
			fallback: { unless: GENERAL_EVALUATOR_ROLE, owner: TOASTMASTER_ROLE },
		},
```

Replace the two existing literal `{ roleKey: "general_evaluator", roleName: "General Evaluator" }` spreads in beats 11–13 with `...GENERAL_EVALUATOR_ROLE` so there is one definition.

- [ ] **Step 6: Rewrite the positive-duration test**

`agenda-runsheet.test.ts:48` asserts every beat has a positive duration, which hand-offs contradict by design. Replace that `it(…)` with:

```ts
	it("every beat has a non-negative duration, and only hand-offs are zero", () => {
		for (const flag of [true, false]) {
			for (const beat of buildRunOfShow({ geIntroducesFunctionaries: flag })) {
				expect(beat.minutes).toBeGreaterThanOrEqual(0);
				if (beat.minutes === 0) expect(beat.handoff).toBe(true);
				if (beat.handoff) expect(beat.minutes).toBe(0);
			}
		}
	});
```

- [ ] **Step 7: Update the remaining structural tests**

These three now describe the old shape and must be updated:

- `:43` `"returns 16 ordered beats…"` — recount after the insertions and update both the number and the title.
- `:107` `"the MCF variant differs from the default ONLY in beat 4's owner and the handback that follows it"` — the difference is now beat 4's owner plus the *opening* GE introduction that precedes it. Retitle and reassert.
- `:139` `"the default variant has no handback beat"` — no longer true; the speakers hand-off is universal. Replace with an assertion that both variants carry it.

- [ ] **Step 8: Run to verify pass**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): hand-off rows say who introduces whom (#363)"
```

---

## Task 5: Trailing clauses and wording

Gaps A, E, F (clauses rather than rows, following the source document) and L, M.

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (`buildRunOfShow`)
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("closing and opening hand-off clauses (#363)", () => {
	const detailFor = (rows: AgendaRow[], who: string) =>
		rows.filter((r) => r.who.startsWith(who)).map((r) => r.detail);

	const nine = () => [
		slot({ id: "tm", roleKey: "toastmaster_of_the_day", roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Faisal" }),
		slot({ id: "sp", roleKey: "speaker", roleName: "Speaker", category: "speaker", isSpeakerRole: true }),
		slot({ id: "ge", roleKey: "general_evaluator", roleName: "General Evaluator", category: "leadership", assigneeName: "Riyaz" }),
	];

	it("has the Sergeant-at-Arms introduce the President, and does not mention exits", () => {
		const rows = expandRunSheet(nine(), RUN_OF_SHOW);
		expect(detailFor(rows, "Sergeant-at-Arms")).toEqual([
			"Call to Order · phones silent · introduces the President",
		]);
	});

	it("has the General Evaluator return control to the Toastmaster", () => {
		const rows = expandRunSheet(nine(), RUN_OF_SHOW);
		expect(detailFor(rows, "General Evaluator")).toContain(
			"Overall meeting evaluation · returns control to the Toastmaster",
		);
	});

	it("has the Toastmaster hand over to the President after the awards", () => {
		const rows = expandRunSheet(nine(), RUN_OF_SHOW);
		expect(rows.find((r) => r.detail.startsWith("Awards"))?.detail).toBe(
			"Awards · Best Speaker · hands over to the President",
		);
	});

	it("closes on announcements, not elections", () => {
		const rows = expandRunSheet(nine(), RUN_OF_SHOW);
		expect(detailFor(rows, "President")).toContain(
			"Club business · announcements · adjourn",
		);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "closing and opening hand-off clauses"`
Expected: FAIL on all four.

- [ ] **Step 3: Apply the wording changes**

In `buildRunOfShow`, make these four edits:

| Beat | From | To |
|---|---|---|
| Sergeant-at-Arms | `"Call to Order · phones silent, exits noted"` | `"Call to Order · phones silent · introduces the President"` |
| GE overall evaluation | `"Overall meeting evaluation"` | `"Overall meeting evaluation · returns control to the Toastmaster"` |
| Awards | `` `Awards · ${AWARDS_TOKEN}` `` | `` `Awards · ${AWARDS_TOKEN} · hands over to the President` `` |
| President closing | `"Club business · elections · adjourn"` | `"Club business · announcements · adjourn"` |

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS. The `generalEvaluation` `BeatId` still resolves — `beatDuration` matches on `id`, not on `detail`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "fix(agenda): state the opening and closing hand-offs; drop exits and elections (#363)"
```

---

## Task 6: Print — the compact transition band

**Files:**
- Modify: `src/components/agenda/meeting-agenda-print.tsx` — `RunNarrative` (`:326`), `GridLayout` rows (`:748`), `TimingLayout` rows (`:1474`)
- Test: `src/components/agenda/meeting-agenda-print.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `meeting-agenda-print.test.tsx` (follow the existing render helper in that file for the `MeetingAgendaPrint` props):

```ts
describe("hand-off rows render as a transition band (#363)", () => {
	const rows: TimelineRow[] = [
		{ time: "7:20", who: "Table Topics Master · Rasheed", detail: "Calls for the Timer's report · vote Best Table Topics", minutes: 1, marks: null },
		{ time: "7:21", who: "Table Topics Master · Rasheed", detail: "Introduces the General Evaluator", minutes: 0, marks: null, handoff: true },
		{ time: "7:21", who: "General Evaluator · Riyaz", detail: "Introduces the speech evaluators", minutes: 0, marks: null, handoff: true },
		{ time: "7:21", who: "Evaluator 1 · Sudheer", detail: "Evaluates Jagpal Singh", minutes: 3, marks: null },
	];

	it("renders every row without duplicate React keys", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		renderPrint({ rows });
		expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("same key"), ...[]);
		spy.mockRestore();
	});

	it("shows the hand-off text on every layout", () => {
		const { container } = renderPrint({ rows });
		expect(container.textContent).toContain("Introduces the General Evaluator");
		expect(container.textContent).toContain("Introduces the speech evaluators");
	});

	it("does not repeat the clock stamp on a hand-off", () => {
		const { container } = renderPrint({ rows });
		const stamps = [...container.querySelectorAll("[data-row-time]")].map((n) => n.textContent);
		expect(stamps.filter((s) => s === "7:21")).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/components/agenda/meeting-agenda-print.test.tsx -t "transition band"`
Expected: FAIL — hand-off rows currently render as full blocks with repeated stamps.

- [ ] **Step 3: Add a shared band component**

Next to `RunNarrative` in `meeting-agenda-print.tsx`:

```tsx
/** A 0-minute hand-off (#363), rendered as a thin band rather than a full
 *  segment block: it repeats the clock time of the row that follows it, so an
 *  equally-weighted block reads as a duplicate. `who · detail` on one line
 *  keeps the holder's name without needing the beat's copy to be recased. */
function HandoffBand({
	row,
	scale,
}: {
	row: TimelineRow;
	scale: "sm" | "lg";
}) {
	const lg = scale === "lg";
	return (
		<div
			style={{
				display: "flex",
				gap: 6,
				padding: lg ? "4px 0 4px 15px" : "3px 0 3px 11px",
				borderLeft: `4px solid transparent`,
				fontSize: lg ? 11.5 : 10,
				color: MUTED,
				fontStyle: "italic",
			}}
		>
			<span aria-hidden>↳</span>
			<span>
				{row.who} · {row.detail}
			</span>
		</div>
	);
}
```

- [ ] **Step 4: Branch at all three row-rendering sites**

In `RunNarrative`, inside `rows.map((r, i) => { … })`, before the existing `return`:

```tsx
					if (r.handoff)
						return <HandoffBand key={`${i}-${r.who}`} row={r} scale={scale} />;
```

Change the existing key on the full-row `<div>` from `` key={`${r.time}-${r.who}`} `` to `` key={`${i}-${r.who}`} ``, and add `data-row-time` to the time cell so the test can count stamps:

```tsx
							<div data-row-time style={{ … }}>
								{r.time}
							</div>
```

Apply the same three edits — early-return band, index-based key, `data-row-time` — to the `GridLayout` loop at `:748` and the `TimingLayout` loop at `:1474`, passing `scale="sm"` for Grid and `scale="lg"` for Timing.

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run src/components/agenda/meeting-agenda-print.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/agenda/meeting-agenda-print.tsx src/components/agenda/meeting-agenda-print.test.tsx
git commit -m "feat(agenda): render hand-offs as a compact transition band on print (#363)"
```

---

## Task 7: Deck — the hand-off slide and the vote caller

**Files:**
- Modify: `src/lib/agenda-slides.ts` (the `Slide` union, `buildSlideDeck`), `src/lib/slide-layout.ts`
- Test: `src/lib/agenda-slides.test.ts`, `src/lib/slide-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

In `agenda-slides.test.ts`:

```ts
describe("hand-off slides (#363)", () => {
	it("projects each hand-off, in run-sheet order, naming both parties", () => {
		const deck = buildSlideDeck({ ...baseInput(), geIntroducesFunctionaries: true });
		expect(deck.filter((s) => s.kind === "handoff")).toEqual([
			{ kind: "handoff", from: { role: "Toastmaster of the Day", name: "Faisal" }, to: "the General Evaluator" },
			{ kind: "handoff", from: { role: "Toastmaster of the Day", name: "Faisal" }, to: "the speakers" },
			{ kind: "handoff", from: { role: "Toastmaster of the Day", name: "Faisal" }, to: "the Table Topics Master" },
			{ kind: "handoff", from: { role: "Table Topics Master", name: "Rasheed" }, to: "the General Evaluator" },
			{ kind: "handoff", from: { role: "General Evaluator", name: "Riyaz" }, to: "the speech evaluators" },
		]);
	});

	it("names the caller on each vote slide", () => {
		const deck = buildSlideDeck({ ...baseInput(), geIntroducesFunctionaries: true });
		const votes = deck.filter((s) => s.kind.startsWith("vote"));
		expect(votes.map((s) => (s as { caller: LegendEntry | null }).caller)).toEqual([
			{ role: "Toastmaster of the Day", name: "Faisal" },
			{ role: "Table Topics Master", name: "Rasheed" },
			{ role: "General Evaluator", name: "Riyaz" },
		]);
	});
});
```

In `slide-layout.test.ts`:

```ts
describe("handoff layout (#363)", () => {
	it("reads as a cue for the person handing over", () => {
		expect(slideLayout({ kind: "handoff", from: { role: "Table Topics Master", name: "Rasheed" }, to: "the General Evaluator" })).toEqual({
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

	it("names the caller above the vote prompt", () => {
		const layout = slideLayout({ kind: "voteSpeaker", names: ["Jagpal"], hasTimer: true, caller: { role: "Toastmaster of the Day", name: "Faisal" } });
		expect(layout).toMatchObject({
			body: { lines: [{ role: "muted", text: "Toastmaster of the Day · Faisal" }, { role: "head", text: "Ask for speaking time." }] },
		});
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/lib/agenda-slides.test.ts src/lib/slide-layout.test.ts`
Expected: FAIL — `"handoff"` is not in the `Slide` union.

- [ ] **Step 3: Extend the `Slide` union**

In `src/lib/agenda-slides.ts`, add to the union:

```ts
	| {
			/** A 0-minute hand-off beat (#363), projected so the person on deck has
			 *  the cue on screen at the moment they need it. `to` is prose ("the
			 *  General Evaluator", "the speakers") rather than a role reference,
			 *  because a hand-off's target is sometimes a group. */
			kind: "handoff";
			from: LegendEntry;
			to: string;
	  }
```

and add `caller: LegendEntry | null` to the shared `VoteTiming` type:

```ts
type VoteTiming = {
	hasTimer: boolean;
	/** Who calls for the report and the vote (#363) — the segment leader, the
	 *  same owner the run sheet's vote beat resolves to. `null` when the club
	 *  runs no such role, matching the run sheet's `renderUnowned` row. */
	caller: LegendEntry | null;
};
```

- [ ] **Step 4: Emit the slides in `buildSlideDeck`**

Add a helper above `buildSlideDeck`:

```ts
/** The role's holder as a `LegendEntry`, or null when the club runs no such
 *  role — the deck's equivalent of the run sheet's owner resolution. */
function holder(slots: AgendaSlot[], role: RoleRef): LegendEntry | null {
	const [s] = byRole(slots, role);
	return s ? { role: s.roleName, name: assigneeDisplay(s) } : null;
}

/** Push a hand-off slide when both the introducer and the target exist. */
function pushHandoff(
	deck: Slide[],
	from: LegendEntry | null,
	to: string,
	present: boolean,
): void {
	if (from != null && present) deck.push({ kind: "handoff", from, to });
}
```

Then, mirroring the run sheet's order exactly:

- Before the `functionaryIntro` push, when `geIntroducesFunctionaries`:
  `pushHandoff(deck, holder(slots, ROLE.toastmaster), "the General Evaluator", generalEvaluator.length > 0)`
- Before the speech slides: `pushHandoff(deck, holder(slots, ROLE.toastmaster), "the speakers", speakers.length > 0)`
- Before the Table Topics slide: `pushHandoff(deck, holder(slots, ROLE.toastmaster), "the Table Topics Master", tableTopics.length > 0)`
- After `voteTableTopics`: `pushHandoff(deck, holder(slots, ROLE.tableTopicsMaster) ?? holder(slots, ROLE.toastmaster), "the General Evaluator", generalEvaluator.length > 0)`
- Before the evaluation slides: `pushHandoff(deck, holder(slots, ROLE.generalEvaluator) ?? holder(slots, ROLE.toastmaster), "the speech evaluators", evaluators.length > 0)`

Add `caller` to each of the three existing vote pushes: `holder(slots, ROLE.toastmaster)`, `holder(slots, ROLE.tableTopicsMaster)`, `holder(slots, ROLE.generalEvaluator)` respectively.

- [ ] **Step 5: Add the layout cases**

In `src/lib/slide-layout.ts`, add a case to the switch:

```ts
		case "handoff":
			return content("Hand-off", {
				form: "centered",
				lines: [
					head(`${slide.from.role} · ${slide.from.name}`),
					head(`introduces ${slide.to}`),
				],
			});
```

and prepend the caller to each vote case's `lines`, e.g. for `voteSpeaker`:

```ts
			const lines: Line[] = [];
			if (slide.caller)
				lines.push(muted(`${slide.caller.role} · ${slide.caller.name}`));
			if (slide.hasTimer) lines.push(head("Ask for speaking time."));
```

Do the same in `voteTableTopics` and `voteEvaluator`.

- [ ] **Step 6: Run to verify pass**

Run: `bunx vitest run src/lib/agenda-slides.test.ts src/lib/slide-layout.test.ts src/lib/deck-to-pptx.test.ts src/components/agenda/meeting-present.test.tsx`
Expected: PASS. `meeting-present.tsx` and `deck-to-pptx.ts` need no edits — both consume only `SlideLayout`. Existing test fixtures that construct vote slides will need `caller` added.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/slide-layout.ts src/lib/agenda-slides.test.ts src/lib/slide-layout.test.ts src/lib/deck-to-pptx.test.ts src/components/agenda/meeting-present.test.tsx
git commit -m "feat(agenda): project hand-offs and name the vote caller on the deck (#363)"
```

---

## Task 8: Parity and the full gate

**Files:**
- Modify: `src/lib/agenda-parity.test.ts`

- [ ] **Step 1: Extend the parity harness**

The harness at `:535` maps every beat of the template to its slide, in order, for both club configs. Hand-off beats now have slides, so add them to that mapping rather than exempting them. Add:

```ts
	it("every hand-off beat has a slide, and vice versa", () => {
		for (const flag of [true, false]) {
			const template = buildRunOfShow({ geIntroducesFunctionaries: flag });
			const rows = expandRunSheet(NINE_ROLE_SLOTS, template).filter((r) => r.handoff);
			const deck = buildSlideDeck({ ...PARITY_INPUT, geIntroducesFunctionaries: flag });
			const slides = deck.filter((s) => s.kind === "handoff");
			expect(slides).toHaveLength(rows.length);
			rows.forEach((row, i) => {
				const s = slides[i] as Extract<Slide, { kind: "handoff" }>;
				expect(row.who).toBe(`${s.from.role} · ${s.from.name}`);
			});
		}
	});

	it("the vote caller matches the run sheet's vote-row owner", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet(NINE_ROLE_SLOTS, template).filter((r) => /vote /i.test(r.detail));
		const deck = buildSlideDeck({ ...PARITY_INPUT, geIntroducesFunctionaries: true });
		const votes = deck.filter((s) => s.kind.startsWith("vote")) as Array<{ caller: LegendEntry | null }>;
		expect(votes).toHaveLength(rows.length);
		rows.forEach((row, i) => {
			const c = votes[i].caller;
			expect(row.who).toBe(c ? `${c.role} · ${c.name}` : row.who);
		});
	});
```

Reuse whatever the file already names its nine-role fixture and deck input; the identifiers above are placeholders for those existing constants — read the top of `agenda-parity.test.ts` and use the real ones.

- [ ] **Step 2: Fix the section-order parity test**

`:557` asserts the run sheet and deck emit sections in the same order. Hand-off rows and slides are now interleaved, so extend the expected sequence rather than filtering them out — the point of the test is that both surfaces agree, and they now agree on more.

- [ ] **Step 3: Run the whole suite**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"
bun run test
```

Expected: PASS. `TEST_DATABASE_URL` matters — without it the DB integration suites silently skip.

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck && bun run check`
Expected: both clean. `bun run build` and `bun run test` do **not** type-check; `typecheck` is the only gate.

- [ ] **Step 5: Visual check against the source document**

```bash
bun run dev
```

Open a meeting on a club with `geIntroducesFunctionaries: true` and visit `/club/<clubId>/meeting/<id>/print`, then `/present`. Compare against the spec's expected agenda. Confirm on all four print layouts that the hand-off bands read as transitions and no clock stamp repeats.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agenda-parity.test.ts
git commit -m "test(agenda): parity covers hand-off slides and the vote caller (#363)"
```

---

## Self-Review Notes

**Spec coverage:** A→Task 5, B→Task 4, B2→Task 4, C→Task 4, D→Task 4, E→Task 5, F→Task 5 (clause) + Task 3 (owner), G→Task 2, L/M→Task 5, print band→Task 6, deck→Task 7, parity→Task 8. The `BeatFallback` and `renderUnowned` mechanics land in Task 1.

**Deliberately not covered:** the multi-slot leadership duplication recorded as an accepted trade-off in the spec, and the four deferred follow-ups (J, K, H, role-description drift), which are issues rather than tasks.

**Type consistency:** `BeatFallback.unless/owner/detail`, `Beat.renderUnowned`, `Beat.handoff`, `AgendaRow.handoff`, `Slide.handoff.from/to` and `VoteTiming.caller` are each defined once in the task that introduces them and used with the same names thereafter.
