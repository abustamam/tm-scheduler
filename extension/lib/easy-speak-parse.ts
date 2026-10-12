/**
 * Pure Easy-Speak page parsers for the export mode (#1047). Each takes a parsed
 * `Document` (the content script passes `new DOMParser().parseFromString(...)`,
 * the tests pass a linkedom one) and returns a section of the bundle.
 *
 * Easy-Speak is 2000s table markup with no stable ids, so everything here keys
 * on the labels a person reads ("Role", "Table Topics Speakers", "Meeting
 * Award Recipients") and on the numeric `u=` in a profile link. A page that is
 * not what it should be returns null or throws; it never returns a half-bundle.
 *
 * Phone numbers and emails: `parseMemberList` reads the name, status and id of
 * each row and nothing else. The contact columns are never touched.
 */
import type {
	EsAttendance,
	EsEvaluation,
	EsGuestCategory,
	EsMeeting,
	EsMentor,
	EsPerson,
	EsPersonRef,
	EsRole,
	EsRoleSpeech,
	ParsedSpeechRow,
	RequestFormInfo,
} from "./easy-speak-bundle";
import { norm } from "./easy-speak-text";

type El = Element;

/**
 * The page is not the page it should be: the structure a parser reads is absent
 * (an error page, a login form, a different page served for the URL). Distinct from
 * a page that has the structure and genuinely nothing in it, which parses to an
 * empty result. The walk turns this into a WalkError naming the page, inside
 * `parse`, so the page is never cached.
 */
export class PageShapeError extends Error {}

function requireShape(found: unknown, what: string): void {
	if (!found) throw new PageShapeError(`it does not show ${what}`);
}

// ------------------------------------------------------------------ helpers

const text = (el: El | null | undefined): string => norm(el?.textContent);

/** Easy-Speak prints credentials after a comma: "Avery Alderfinch, DTM PDD". They are not part of the name. */
export function stripCredentials(name: string): string {
	return norm(name).replace(/,\s*[A-Z]{2,4}(?:\s+[A-Z]{2,4})*$/, "");
}

function closest(el: El | null, tag: string): El | null {
	let n: El | null = el;
	const up = tag.toUpperCase();
	while (n && n.tagName.toUpperCase() !== up) n = n.parentElement;
	return n;
}

/** The table's own rows: not the rows of a table nested in a cell. */
function ownRows(table: El): El[] {
	return Array.from(table.querySelectorAll("tr")).filter(
		(tr) => closest(tr.parentElement, "table") === table,
	);
}

function cells(tr: El): El[] {
	return Array.from(tr.children);
}

const PERSON_LINK =
	/(?:privmsg|profile)\.php\?mode=(?:post|miniprofile|viewprofile)&(?:amp;)?u=(\d+)/;

/** The `u=` of a profile link. The id sits in `href` or, for a popup link, in `onclick`. */
function personFrom(a: El): EsPersonRef | null {
	const m = PERSON_LINK.exec(
		`${a.getAttribute("href") ?? ""} ${a.getAttribute("onclick") ?? ""}`,
	);
	const name = stripCredentials(text(a));
	if (!m || !name) return null;
	return { esUserId: m[1], name };
}

function firstPerson(scope: El): EsPersonRef | null {
	for (const a of Array.from(scope.querySelectorAll("a"))) {
		const p = personFrom(a);
		if (p) return p;
	}
	return null;
}

function allPeople(scope: El): EsPersonRef[] {
	const out: EsPersonRef[] = [];
	for (const a of Array.from(scope.querySelectorAll("a"))) {
		const p = personFrom(a);
		if (p) out.push(p);
	}
	return out;
}

const nullIfBlank = (s: string): string | null => (s === "" ? null : s);

/**
 * The first link under `scope` whose href matches `re`. Not `a[href*="..."]`:
 * a quoted attribute selector holding `?` and `&` is where DOM implementations
 * differ, and this must read the same in Chrome, Firefox and the tests' DOM.
 */
function findLink(scope: ParentNode, re: RegExp): El | null {
	for (const a of Array.from(scope.querySelectorAll("a"))) {
		if (re.test(a.getAttribute("href") ?? "")) return a;
	}
	return null;
}

function isoDate(s: string): string | null {
	const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s);
	return m ? m[1] : null;
}

// ------------------------------------------------------------------ the page's own identity

export interface Viewer {
	esUserId: string | null;
	username: string | null;
	name: string | null;
}

/**
 * Who is signed in, from the header every page carries:
 * "Welcome back Avery Alderfinch  [username]". A page with no username is not a
 * signed-in Easy-Speak page (the login form, an error), which is how the walk
 * notices a logged-out session.
 */
export function parseViewer(doc: Document): Viewer {
	const header = /Welcome back\s+(.+?)\s*\[([^\]]+)\]/.exec(
		norm(doc.body?.textContent),
	);
	const nameLink = doc.querySelector("span.name a");
	const req = findLink(doc, /request_speech\.php\?mode=entertitle&u=\d+/);
	const id = /[?&]u=(\d+)/.exec(req?.getAttribute("href") ?? "");
	return {
		esUserId: id ? id[1] : null,
		username: header ? header[2] : nullIfBlank(text(nameLink)),
		name: header ? stripCredentials(header[1]) : null,
	};
}

/** The Easy-Speak club id: every club page links `view_meeting.php?c=<id>&show=next`. */
export function parseEsClubId(doc: Document): string | null {
	const a = findLink(doc, /view_meeting\.php\?c=\d+/);
	const m = /[?&]c=(\d+)/.exec(a?.getAttribute("href") ?? "");
	if (m) return m[1];
	const hidden = doc.querySelector('input[name="cached_club"]');
	return nullIfBlank(norm(hidden?.getAttribute("value")));
}

// ------------------------------------------------------------------ club data

export interface ParsedClub {
	number: string | null;
	name: string | null;
	timezone: string | null;
}

function labelValue(doc: Document, label: string): El | null {
	for (const td of Array.from(doc.querySelectorAll("td"))) {
		if (text(td) === label) return td.nextElementSibling;
	}
	return null;
}

/** Name, number and timezone only. The page's contact rows and officer phone numbers are not read. */
export function parseClubData(doc: Document): ParsedClub {
	// The Name and Club Number rows are on every club's page, filled or not.
	const numberCell = labelValue(doc, "Club Number");
	requireShape(numberCell && labelValue(doc, "Name"), "the club's Club Number and Name rows");
	const num = /\d+/.exec(text(numberCell));
	// The cell reads "PST (GMT-8 hrs) Ignoring Daylight-saving time<br>America/Los_Angeles": the zone name abuts the word before it.
	const tz =
		/(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?/.exec(
			text(labelValue(doc, "Timezone")),
		);
	return {
		number: num ? num[0] : null,
		name: nullIfBlank(text(labelValue(doc, "Name"))),
		timezone: tz ? tz[0] : null,
	};
}

// ------------------------------------------------------------------ member list

export interface ParsedMemberList {
	people: Omit<EsPerson, "joined">[];
	pages: number;
}

/** Name, status and id from each row. The phone and email columns are never read. */
export function parseMemberList(doc: Document): ParsedMemberList {
	// The member table's column headers are there whether or not it has a row.
	requireShape(doc.querySelector('table.forumline th[id^="l_column_"]'), "the member list table");
	const people: Omit<EsPerson, "joined">[] = [];
	for (const status of Array.from(
		doc.querySelectorAll('span[id^="email_status_"]'),
	)) {
		const box = closest(status, "table");
		const a = box ? findLink(box, /mode=viewprofile/) : null;
		const who = a ? personFrom(a) : null;
		if (!who?.esUserId) continue;
		people.push({
			esUserId: who.esUserId,
			name: who.name,
			status: text(status),
		});
	}
	// Rows with no readable member at all is a page whose rows are not these: not an empty club.
	if (people.length === 0 && doc.querySelector('span[id^="email_status_"]')) {
		throw new PageShapeError("none of its member rows has a readable profile link");
	}
	const pg = /Page\s+(\d+)\s+of\s+(\d+)/.exec(norm(doc.body?.textContent));
	return { people, pages: pg ? Number(pg[2]) : 1 };
}

// ------------------------------------------------------------------ meeting list

export function parseMeetingList(doc: Document): string[] {
	// The date-range form is on the page for a year with no meetings too.
	requireShape(doc.querySelector('input[name="start_year"]'), "the meeting list's date-range form");
	const ids: string[] = [];
	for (const a of Array.from(doc.querySelectorAll("table.forumline a"))) {
		const m = /view_meeting\.php\?t=(\d+)/.exec(a.getAttribute("href") ?? "");
		if (m && !ids.includes(m[1])) ids.push(m[1]);
	}
	return ids;
}

// ------------------------------------------------------------------ one meeting

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

function pad(n: number, w = 2): string {
	return String(n).padStart(w, "0");
}

/** Offset of `tz` from UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * A club-local wall time as an instant. With an IANA zone it is converted to
 * UTC (`...Z`, daylight saving included); without one it is returned as the
 * local time it was, with no offset, rather than guessed.
 */
export function localToInstant(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	tz: string | null,
): string {
	const naive = `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`;
	if (!tz) return naive;
	try {
		const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
		let utc = guess - zoneOffsetMs(new Date(guess), tz);
		// The offset at the guess may differ from the offset at the answer across a DST change.
		utc = guess - zoneOffsetMs(new Date(utc), tz);
		return new Date(utc).toISOString();
	} catch {
		return naive;
	}
}

const TITLE_RE =
	/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([ap]m)(?:\s+([A-Za-z]+\/[A-Za-z_/]+))?/i;

function parseTitle(
	doc: Document,
	clubTimezone: string | null,
): string | null {
	for (const td of Array.from(doc.querySelectorAll("td.maintitle"))) {
		const m = TITLE_RE.exec(text(td));
		if (!m) continue;
		const month = MONTHS.indexOf(m[2].toLowerCase());
		if (month < 0) continue;
		let hour = Number(m[4]) % 12;
		if (m[6].toLowerCase() === "pm") hour += 12;
		return localToInstant(
			Number(m[3]),
			month + 1,
			Number(m[1]),
			hour,
			Number(m[5]),
			m[7] ?? clubTimezone,
		);
	}
	return null;
}

/** The labelled values in the venue block: "Venue", "Meet online:", "Word of the Day", "Meeting Theme". */
function venueBlock(doc: Document): Record<string, El> {
	const out: Record<string, El> = {};
	for (const span of Array.from(doc.querySelectorAll("span.gen"))) {
		if (!/^Venue\b/.test(text(span))) continue;
		let label: string | null = null;
		for (const node of Array.from(span.childNodes)) {
			if (node.nodeType === 3) {
				const t = norm(node.textContent);
				if (
					t === "Venue" ||
					t === "Meet online:" ||
					t === "Word of the Day" ||
					t === "Meeting Theme"
				) {
					label = t;
				}
			} else if (node.nodeType === 1 && label) {
				const el = node as El;
				if (el.tagName.toUpperCase() === "BR") continue;
				out[label] = el;
				label = null;
			}
		}
		break;
	}
	return out;
}

const ATTENDANCE_SECTIONS: Record<string, "member" | EsGuestCategory> = {
	Member: "member",
	"Inactive Member": "member",
	"Past Member": "member",
	"Guest Speaker": "guest_speaker",
	"Past Visitor": "past_visitor",
	Visitor: "visitor",
	"Visitor From Another Club": "visitor_other_club",
};

function planFromText(t: string): {
	plan: EsAttendance["plan"];
	record: EsAttendance["record"];
} {
	if (/^Attended Online$/i.test(t)) return { plan: null, record: "attended_online" };
	if (/^Attended$/i.test(t)) return { plan: null, record: "attended" };
	if (/^Did NOT Attend$/i.test(t)) return { plan: null, record: null };
	if (/^NOT Attending$/i.test(t)) return { plan: "not_attending", record: null };
	// Easy-Speak's "Online" reply is attendance; the contract has no online plan.
	if (/^(Attending|Online)$/i.test(t)) return { plan: "attending", record: null };
	if (/^(Tentative|Maybe)\b/i.test(t)) return { plan: "tentative", record: null };
	return { plan: "unknown", record: null };
}

/** The viewer's own row is a set of radio buttons (P, O, N, ?) instead of a word. */
const RADIO_PLAN: Record<string, EsAttendance["plan"]> = {
	"1": "attending",
	"6": "attending",
	"2": "not_attending",
	"5": "unknown",
};

function parseAttendance(doc: Document): {
	attendance: EsAttendance[];
	/** Every guest-section row; `signal` says the person replied or was recorded. */
	guests: (EsMeeting["guests"][number] & { signal: boolean })[];
} {
	const attendance: EsAttendance[] = [];
	const guests: (EsMeeting["guests"][number] & { signal: boolean })[] = [];
	for (const h of Array.from(doc.querySelectorAll("th.thTop > h3"))) {
		const section =
			ATTENDANCE_SECTIONS[text(h).replace(/\s*\(.*$/, "").trim()];
		const box = h.parentElement?.parentElement?.nextElementSibling;
		if (!section || !box) continue;
		for (const img of Array.from(
			box.querySelectorAll('img[name^="attend_image"]'),
		)) {
			const row = closest(img, "tr");
			const planCell = img.parentElement;
			const a = row?.querySelector("span.nav a");
			const id = /\[(\d+)\]/.exec(img.getAttribute("name") ?? "");
			if (!row || !planCell || !a || !id) continue;
			const name = stripCredentials(text(a));
			if (!name) continue;
			const who: EsPersonRef = { esUserId: id[1], name };
			const radios = Array.from(
				planCell.querySelectorAll('input[type="radio"]'),
			);
			let state: ReturnType<typeof planFromText>;
			if (radios.length > 0) {
				const on = radios.find((r) => r.hasAttribute("checked"));
				state = {
					plan: RADIO_PLAN[on?.getAttribute("value") ?? ""] ?? "unknown",
					record: null,
				};
			} else {
				state = planFromText(text(planCell));
			}
			attendance.push({ who, ...state });
			if (section !== "member") {
				const signal =
					state.record !== null ||
					state.plan === "attending" ||
					state.plan === "tentative";
				guests.push({ who, category: section, signal });
			}
		}
	}
	return { attendance, guests };
}

const TBA = /^(TBA)?$/i;

function parseMinutes(s: string): { min: number | null; max: number | null } {
	const m =
		/\(\s*(\d+)(?::(\d{2}))?(?:\s*-\s*(\d+)(?::(\d{2}))?)?\s*min/i.exec(s);
	if (!m) return { min: null, max: null };
	const min = Number(m[1]) + Number(m[2] ?? 0) / 60;
	const max = m[3] ? Number(m[3]) + Number(m[4] ?? 0) / 60 : min;
	return { min, max };
}

function parseSpeech(detail: El): EsRoleSpeech {
	const rows = ownRows(detail.querySelector("table") ?? detail);
	const title = text(rows[0]?.querySelector("td"));
	const projectCell = rows[1]?.querySelector("td");
	const project = text(projectCell?.querySelector("i"));
	const { min, max } = parseMinutes(text(projectCell));
	// "Presentation Mastery #1-5 - Evaluation and Feedback - 2": path, "#level-n", name.
	const m = /^(.*?)\s+#(\d+)-\d+\s*-\s*(.*)$/.exec(project);
	return {
		esSpeechId: null,
		title: TBA.test(title) ? null : title,
		path: m ? nullIfBlank(m[1]) : null,
		level: m ? Number(m[2]) : null,
		project: m ? nullIfBlank(m[3]) : nullIfBlank(project),
		minMin: min,
		maxMin: max,
		introduction: null,
	};
}

function parseRoles(doc: Document): EsRole[] {
	const head = Array.from(doc.querySelectorAll("th.thLeft")).find(
		(th) => text(th) === "Role",
	);
	const table = closest(head ?? null, "table");
	if (!table) return [];
	const roles: EsRole[] = [];
	for (const tr of ownRows(table)) {
		const tds = cells(tr);
		if (tds.length < 3 || !/\brow[12]\b/.test(tds[0].className)) continue;
		const label = tds[0].cloneNode(true) as El;
		for (const d of Array.from(label.querySelectorAll("div"))) d.remove();
		const role = text(label);
		if (!role) continue;
		const detail = tr.querySelector('div[id^="speechdetail_"]');
		roles.push({
			role,
			slot: roles.length + 1,
			holder: firstPerson(tds[2]),
			...(detail ? { speech: parseSpeech(detail) } : {}),
		});
	}
	// "1st Evaluator" evaluates the "1st Speaker".
	for (const r of roles) {
		const ev = /^(\d+)(?:st|nd|rd|th)\s+Evaluator$/i.exec(r.role);
		if (!ev) continue;
		const target = roles.find((s) =>
			new RegExp(`^${ev[1]}(?:st|nd|rd|th)\\s+Speaker$`, "i").test(s.role),
		);
		if (target) r.evaluates = target.slot;
	}
	return roles;
}

const AWARD_CATEGORIES: Record<string, EsMeeting["awards"][number]["category"]> = {
	"Best Speaker Award": "best_speaker",
	"Best Evaluator Award": "best_evaluator",
	"Best Table Topics Award": "best_table_topics",
};

function parseAwards(doc: Document): EsMeeting["awards"] {
	const out: EsMeeting["awards"] = [];
	for (const tr of Array.from(doc.querySelectorAll("tr"))) {
		const tds = cells(tr);
		if (tds.length < 2) continue;
		const category = AWARD_CATEGORIES[text(tds[0])];
		const who = category ? firstPerson(tds[1]) : null;
		if (category && who) out.push({ category, who });
	}
	return out;
}

/**
 * "Table Topics Speakers": a heading, then one row per speaker, then the
 * "Add Speaker" button row. A club that does not record them shows
 * "No speakers added yet" and this returns `[]`.
 */
function parseTableTopics(doc: Document): EsMeeting["tableTopics"] {
	const head = Array.from(doc.querySelectorAll("td")).find(
		(td) => text(td) === "Table Topics Speakers",
	);
	const table = closest(head ?? null, "table");
	if (!table) return [];
	const out: EsMeeting["tableTopics"] = [];
	for (const tr of ownRows(table)) {
		const who = firstPerson(tr);
		if (!who) continue;
		const topic = cells(tr)
			.filter((td) => !td.querySelector("a"))
			.map(text)
			.filter(Boolean)
			.join(" ");
		out.push({ who, topic: nullIfBlank(topic) });
	}
	return out;
}

function parseManager(doc: Document): string | null {
	for (const span of Array.from(doc.querySelectorAll("span.genmed"))) {
		if (!/^Meeting Manager\b/.test(text(span))) continue;
		const a = span.querySelector("b a");
		return a ? nullIfBlank(stripCredentials(text(a))) : null;
	}
	return null;
}

/**
 * One `view_meeting.php?t=N` page. Returns null when the page is not a meeting
 * (no dated title): a login form, an error, a deleted meeting.
 */
export function parseMeeting(
	doc: Document,
	esMeetingId: string,
	clubTimezone: string | null,
): EsMeeting | null {
	const startsAt = parseTitle(doc, clubTimezone);
	if (!startsAt) return null;
	const venue = venueBlock(doc);
	const place = venue.Venue;
	const wotd = venue["Word of the Day"] ? text(venue["Word of the Day"]) : "";
	const parsed = parseAttendance(doc);
	const attendance = parsed.attendance;
	const roles = parseRoles(doc);
	// A guest-section person is a guest of this meeting if they replied, were
	// recorded, or hold a role in it (a guest who is Toastmaster has not "replied").
	const holders = new Set(
		roles.map((r) => r.holder?.esUserId).filter((id): id is string => !!id),
	);
	const guests = parsed.guests
		.filter((g) => g.signal || (g.who.esUserId !== null && holders.has(g.who.esUserId)))
		.map(({ who, category }) => ({ who, category }));
	return {
		esMeetingId,
		startsAt,
		venue: place
			? nullIfBlank(text(place.querySelector("a") ?? place).replace(/\(Click here for a map\)/, "").trim())
			: null,
		joinUrl: nullIfBlank(
			norm(venue["Meet online:"]?.querySelector("a")?.getAttribute("href")),
		),
		theme: venue["Meeting Theme"] ? nullIfBlank(text(venue["Meeting Theme"])) : null,
		wordOfTheDay: /^(|Not Yet Chosen)$/i.test(wotd) ? null : wotd,
		manager: parseManager(doc),
		roles,
		attendance,
		guests,
		awards: parseAwards(doc),
		tableTopics: parseTableTopics(doc),
	};
}

// ------------------------------------------------------------------ speech list

const OWN_REQUEST =
	/request_speech\.php\?mode=entertitle&(?:amp;)?s=(\d+)&(?:amp;)?u=\d+/;

/** "2 - The Power of Humor in an Impromptu Speech - 2" is level 2, then the project's name. */
function splitAssignment(s: string): { level: number | null; project: string | null } {
	const m = /^(\d+)\s*-\s*(.*)$/.exec(s);
	if (!m) return { level: null, project: nullIfBlank(s === "-" ? "" : s) };
	return { level: Number(m[1]), project: nullIfBlank(m[2]) };
}

/**
 * The speech list: "Requested and Scheduled Speeches" (9 cells a row) then
 * "Recent speeches", which for this club is every completed speech (6 cells a
 * row). `level` is dropped here: the contract's speech request has no level.
 */
export function parseSpeechList(doc: Document): ParsedSpeechRow[] {
	const head = Array.from(doc.querySelectorAll("th")).find((th) =>
		/Information on Speeches/.test(text(th)),
	);
	const table = closest(head ?? null, "table");
	requireShape(table, "the speech list table");
	if (!table) return [];
	const out: ParsedSpeechRow[] = [];
	for (const tr of ownRows(table)) {
		const tds = cells(tr);
		if (tds.length !== 9 && tds.length !== 6) continue;
		if (tds[0].tagName.toUpperCase() === "TH") continue;
		const who = firstPerson(tds[0]);
		if (!who) continue;
		const workbook = text(tds[1]);
		const assignment = tds[2];
		const idMatch = /tm_objective\.php\?s=(\d+)/.exec(
			assignment.querySelector("a")?.getAttribute("href") ?? "",
		);
		const { project } = splitAssignment(text(assignment));
		const titleLink = tds[3].querySelector("a");
		const title = text(titleLink ?? tds[3]);
		const own = Array.from(tds[3].querySelectorAll("a"))
			.map((a) => OWN_REQUEST.exec(`${a.getAttribute("href") ?? ""} ${a.getAttribute("onclick") ?? ""}`))
			.find((m) => m !== null);
		const base = {
			esSpeechId: idMatch ? idMatch[1] : null,
			who,
			title: title === "" || title === "-" || /^TBA$/i.test(title) ? null : title,
			path: /^(Undecided workbook|-|)$/.test(workbook) ? null : workbook,
			project,
			introduction: null,
		};
		const requestFormPath = own
			? `request_speech.php?mode=entertitle&s=${own[1]}&u=${who.esUserId}`
			: null;
		if (tds.length === 9) {
			const sched = findLink(tds[8], /view_meeting\.php\?t=\d+/);
			const scheduledOn = isoDate(text(sched ?? tds[8]));
			out.push({
				request: {
					...base,
					requestedOn: isoDate(text(tds[4])),
					preferred: [5, 6, 7].map((i) => isoDate(text(tds[i]))),
					scheduledOn,
					status: scheduledOn ? "scheduled" : "requested",
				},
				meetingId: /[?&]t=(\d+)/.exec(sched?.getAttribute("href") ?? "")?.[1] ?? null,
				requestFormPath,
			});
		} else {
			const done = findLink(tds[4], /view_meeting\.php\?t=\d+/);
			out.push({
				request: {
					...base,
					requestedOn: null,
					preferred: [],
					scheduledOn: isoDate(text(tds[4])),
					status: "completed",
				},
				meetingId: /[?&]t=(\d+)/.exec(done?.getAttribute("href") ?? "")?.[1] ?? null,
				requestFormPath,
			});
		}
	}
	return out;
}

/** The request form for one speech: its title and, if the viewer may see it, the introduction. */
export function parseRequestForm(doc: Document): RequestFormInfo {
	requireShape(doc.querySelector('input[name="cached_speech"]'), "the speech request form");
	const val = (name: string) =>
		norm(doc.querySelector(`input[name="${name}"]`)?.getAttribute("value"));
	const title = text(doc.querySelector("#speech_title")) || val("cached_title");
	const intro =
		(doc.querySelector("#introduction")?.textContent ?? "").trim() ||
		val("cached_introduction");
	return {
		esSpeechId: nullIfBlank(val("cached_speech")),
		title: nullIfBlank(title),
		introduction: nullIfBlank(intro),
	};
}

// ------------------------------------------------------------------ member charts

function dataRows(doc: Document): El[] {
	return Array.from(doc.querySelectorAll("tr")).filter(
		(tr) => tr.children.length === 5 && /\brow[12]\b/.test(tr.children[0].className),
	);
}

/**
 * A member chart's own table: the `forumline` table whose first header is "Name"
 * and which carries every header in `headers`. Present with a header row and no
 * data rows is a chart with nothing in it (chart 7 for a member); absent is some
 * other page.
 */
function requireChartTable(doc: Document, headers: string[], opts: { meetingColumns?: boolean } = {}): void {
	const found = Array.from(doc.querySelectorAll("table.forumline")).some((t) => {
		const ths = Array.from(t.querySelectorAll("th"));
		const names = ths.map((th) => text(th));
		if (names[0] !== "Name") return false;
		if (!headers.every((h) => names.includes(h))) return false;
		return !opts.meetingColumns || ths.some((th) => findLink(th, /view_meeting\.php\?t=\d+/));
	});
	requireShape(found, "the member chart's table");
}

/** Chart 1, "Role History": kept only as a raw page, so only its shape is checked. */
export function checkRoleHistory(doc: Document): null {
	requireChartTable(doc, ["Last role"]);
	return null;
}

/** Chart 4, "Roles by member": kept only as a raw page, so only its shape is checked. */
export function checkRolesByMember(doc: Document): null {
	// One column per meeting, each headed by a link to it.
	requireChartTable(doc, [], { meetingColumns: true });
	return null;
}

/** The evaluations page: kept only as a raw page, so only its shape is checked. */
export function checkEvaluationsPage(doc: Document): null {
	requireShape(doc.querySelector("#eval-list"), "the evaluations list");
	return null;
}

export interface ParsedMentors {
	mentors: EsMentor[];
	joined: Map<string, string>;
}

/** Chart 8, "Mentoring": member, joined date, wants a mentee, mentor, mentees. */
export function parseMentoring(doc: Document): ParsedMentors {
	requireChartTable(doc, ["Wants Mentee?", "Mentor"]);
	const mentors: EsMentor[] = [];
	const joined = new Map<string, string>();
	for (const tr of dataRows(doc)) {
		const tds = cells(tr);
		const mentee = firstPerson(tds[0]);
		if (!mentee) continue;
		const date = isoDate(text(tds[1]));
		if (mentee.esUserId && date) joined.set(mentee.esUserId, date);
		const mentor = firstPerson(tds[3]);
		const want = text(tds[2]);
		const wantsMentee = want !== "" && !/^(no|n|0|false)$/i.test(want);
		// A member with no mentor who is not asking for one has nothing to say.
		if (mentor || wantsMentee) mentors.push({ mentee, mentor, wantsMentee });
	}
	return { mentors, joined };
}

/**
 * Chart 7, "Visitors Introduced": one row per member, with the visitors they
 * introduced. A bare count (no names) yields no pairs.
 */
export function parseVisitorsIntroduced(
	doc: Document,
): { visitor: EsPersonRef; introducedBy: EsPersonRef }[] {
	requireChartTable(doc, ["Visitors"]);
	const out: { visitor: EsPersonRef; introducedBy: EsPersonRef }[] = [];
	for (const tr of dataRows(doc)) {
		const tds = cells(tr);
		const by = firstPerson(tds[0]);
		if (!by) continue;
		const linked = allPeople(tds[2]);
		if (linked.length > 0) {
			for (const visitor of linked) out.push({ visitor, introducedBy: by });
			continue;
		}
		const t = text(tds[2]);
		if (t === "" || /^\d+$/.test(t)) continue;
		for (const name of t.split(",")) {
			const n = stripCredentials(name);
			if (n) out.push({ visitor: { esUserId: null, name: n }, introducedBy: by });
		}
	}
	return out;
}

// ------------------------------------------------------------------ evaluations (JSON)

interface EvalListItem {
	evaluation_id: number | string;
	direction?: string;
	status?: string;
	meeting_date?: string | null;
	evaluator_name?: string | null;
	speaker_name?: string | null;
}

interface EvalDetail {
	evaluation?: {
		evaluator_name?: string | null;
		submitted_date?: string | null;
		responses?: {
			field_type?: string;
			field_label?: string;
			text_value?: string | null;
		}[];
	};
}

/** The submitted evaluations in `/api/v1/evaluations.php/my-evaluations`: drafts are not evaluations yet. */
export function parseEvaluationList(json: unknown): EvalListItem[] {
	const list = (json as { evaluations?: unknown })?.evaluations;
	if (!Array.isArray(list)) return [];
	return (list as EvalListItem[]).filter(
		(e) => e && e.evaluation_id != null && e.status !== "draft",
	);
}

/**
 * One evaluation from its list row and detail JSON. The JSON names people but
 * gives no ids, so the refs carry `esUserId: null`; the exporter's own side is
 * named from the page header.
 */
export function parseEvaluation(
	item: EvalListItem,
	detail: unknown,
	exporterName: string,
): EsEvaluation {
	const d = (detail as EvalDetail | null)?.evaluation;
	// The detail is another site's API answer: a shape it should not have is a page-shape failure
	// the walk reports and does not cache, not a TypeError. A TypeError from here is a bug.
	// A 200 answer can still be an error object (`{"error": ...}`) or `null`: every real
	// evaluation (see the fixtures) is an `evaluation` object with a `responses` list, which may
	// be empty. Without them it is not an evaluation, and must not read as an empty one.
	if (d === null || d === undefined || typeof d !== "object" || Array.isArray(d)) {
		throw new PageShapeError("it has no evaluation object");
	}
	const responses = d.responses;
	if (!Array.isArray(responses)) {
		throw new PageShapeError(
			responses === undefined ? "it has no responses list" : "its responses are not a list",
		);
	}
	if (responses.some((r) => r === null || typeof r !== "object")) {
		throw new PageShapeError("one of its responses is not an object");
	}
	const text = responses
		.filter((r) => r.field_type === "text" && r.text_value)
		.map((r) => `${r.field_label ?? ""}: ${r.text_value}`.trim())
		.join("\n\n");
	const received = item.direction === "received";
	const ref = (name: string | null | undefined, fallback: string): EsPersonRef => ({
		esUserId: null,
		name: norm(name) || fallback,
	});
	return {
		esId: String(item.evaluation_id),
		speaker: received
			? ref(exporterName, exporterName)
			: ref(item.speaker_name, "Unknown"),
		evaluator: received
			? ref(item.evaluator_name ?? d?.evaluator_name, "Unknown")
			: ref(exporterName, exporterName),
		date: isoDate(item.meeting_date ?? d?.submitted_date ?? "") ?? "",
		text,
	};
}
