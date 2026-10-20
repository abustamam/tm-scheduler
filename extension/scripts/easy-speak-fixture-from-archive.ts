/**
 * Turns a saved Easy-Speak page into a committable fixture (#1272). **Deny by default.**
 *
 * The page is parsed into a DOM. EVERY text node and EVERY attribute value is replaced with a fake
 * unless it is on the allow-list below (`ALLOW_LIST`): the structural strings of the site (menu
 * labels, column headers, role names, button text), the URL shapes the walker reads, and a handful
 * of date/time/count shapes. Tag names, attribute names and the document's structure are never
 * touched. Nothing here looks for a name, a phone or an email to remove (an earlier regex rewriter
 * did, and real data kept getting past it); what is not known to be safe is replaced, so a shape
 * nobody thought of is replaced too.
 *
 * Fakes are deterministic within one run: the same real value maps to the same fake, so the
 * cross-references the walker follows (a person's id in a link and in a table) still line up.
 *
 * `fixtureViolations` (the test kit) then runs over the output as the second net. If it reports
 * anything the CLI writes nothing and exits non-zero. A pass is not clearance: a human still reads
 * every line of the output before it is committed (`__fixtures__/easy-speak/README.md`).
 *
 *   bun scripts/easy-speak-fixture-from-archive.ts <page.html> <out.html> [--contact-page]
 *   bun scripts/easy-speak-fixture-from-archive.ts --archive <pages.json> --page <url> <out.html>
 *
 * Run it from `extension/`. The input is raw member data: never commit it, never paste it anywhere.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAKE_NAMES, type FixtureCheckOptions, fixtureViolations, parseHtml, readFixture } from "../lib/easy-speak-test-kit";

// ------------------------------------------------------------------ the allow-list

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The structural strings of Easy-Speak that may stay in a text node, exactly as written (the
 * match is case-sensitive and on whole words). A reviewer reads this list in one place. NEVER add a
 * name, a club's own word, or a string only one club would show: add what every club's page says.
 * A phrase that is also a plausible surname ("May", "Page", "Small") must not be here; the dates
 * below are patterns for that reason.
 */
const STRUCTURAL_PHRASES: readonly string[] = [
	// page titles and headings
	"View agenda", "Request a Speech", "Visitors Introduced", "Club and Officer Information", "User List", "My Evaluations",
	"Role History", "Roles by Member", "Speech List", "Meeting List", "Mentoring", "Information on Speeches",
	// the header and the left panel
	"Mobile", "Welcome back", "Welcome", "Links", "Member",
	// the request-a-speech form
	"Title", "Workbook", "Select a workbook", "Requested", "1st Pref", "2nd Pref", "3rd Pref", "Missing", "Speech Title",
	"Speech", "Preferred Dates", "Required", "Speech introduction", "for Toastmaster", "Save", "Cancel", "Add Speaker", "Go",
	"Submit", "Distinguished Club status",
	// a chart and the speech list
	"Name", "First Associated with Club", "Visitors", "Percent", "Graph", "Action", "Last role", "TME", "PQ", "Edu", "EVTM",
	"Joke", "Speak", "AH", "TIM", "CSTSAA", "Time", "Assignment", "Pref", "Scheduled", "Requested and Scheduled Speeches",
	"Undecided workbook", "Recent speeches", "Completed", "Competition", "Other speeches",
	// a meeting
	"Previous", "Next", "This meeting is also available online", "Toastmaster Meeting", "Hour", "Hours", "Mins", "Days",
	"I didn't go to this meeting", "Venue", "Click here for a map", "Meet online", "Word of the Day", "Meeting Theme",
	"Actual meeting detail entered on", "This meeting is closed for changes", "Actual Attendance", "Total Attendance", "Online",
	"Inactive Member", "Guest Speaker", "Past Visitor", "Visitor", "Visitor From Another Club", "Past Member", "Did NOT Attend",
	"Attended", "Attended Online", "Meeting Award Recipients", "Ribbon", "Award", "Recipient", "Best Speaker Award",
	"Best Table Topics Award", "Best Evaluator Award", "Hide Speech Details", "Actual Meeting Roles", "Role", "CL", "Presenter",
	"Toastmaster", "Joke Master", "Speaker", "Ah Master", "Grammarian", "Timer", "Timer 2 - Online", "Vote Counter", "Listener",
	"Table Topic Master", "General Evaluator", "Evaluator", "Table Topics Speakers", "No speakers added yet",
	"Click on a name to see Contact Details or on a role to see the Knowledgebase article", "Meeting Manager",
	"Watch this meeting for changes", "E-mail meeting to a friend", "I am NOT attending this meeting", "Click here to join meeting",
	"Not Yet Chosen", "Last on-line changes in", "You may accept a vacant role", "Confirm Attendance", "Sign Up for Roles", "Accept",
	"TBA", "Unknown", "NOT Attending", "Attending", "Yes", "No",
	// the club page
	"Club Number", "Area", "Contact Information", "Phone Contact", "E-mail", "Club Website", "Timezone", "Ignoring Daylight-saving time",
	"Meeting Information", "Language", "English US", "Meetings", "Address", "Club type", "Community Club", "Sponsor", "Not applicable",
	"This club is", "Open to all interested persons", "Year round club", "The club uses meeting management", "through this site",
	"Last contribution", "Never", "Go to", "Next Meeting", "Subscribe to Web Calendar", "Display Neighbouring Clubs",
	"Information from the Toastmaster International website", "Indirectly based on TI website data", "Club DCP History",
	"Club Educational History", "May take some time to calculate", "Club Officers", "President", "Treasurer", "Secretary",
	"Sergeant at Arms", "Vice President Education", "Vice President Membership", "Vice President Public Relations",
	"Immediate Past President", "Distinguished Club", "Club",
	// the member list, the meeting list, mentoring
	"Last online", "Last note", "Paid until", "Contact Numbers", "Date Range", "Main Roles", "Meeting Award Winners", "Date",
	"Speakers", "Topicsmaster", "Joined Date", "Wants Mentee", "Mentor", "Mentee(s)", "Members", "No evaluations found",
	// Pathways: the public names of the paths, and the projects the committed pages show
	"Dynamic Leadership", "Effective Coaching", "Engaging Humor", "Innovative Planning", "Leadership Development",
	"Motivational Strategies", "Persuasive Influence", "Presentation Mastery", "Strategic Relationships", "Team Collaboration",
	"Visionary Communication", "Icebreaker", "Evaluation and Feedback", "Deliver Social Speeches", "Effective Body Language",
	"Impromptu Speech", "Using Descriptive Language", "The Power of Humor in an Impromptu Speech", "Competition speech",
	// credentials after a name
	"CC", "AC", "ACB", "ACS", "ACG", "ALB", "ALS", "DTM", "PM1", "PM2", "PM3", "PM4", "PM5", "EH1", "EH2", "EH3", "EH4", "EH5",
	"PI1", "PI2", "PI3", "PI4", "PI5",
	// the one lowercase word the header and the left panel put between a name and a club
	"at", "min",
];

/** Strings kept only when they are the WHOLE text node (a one-letter heading, a separator). */
const STRUCTURAL_EXACT_NODES: readonly string[] = ["P", "O", "N", "M", "?", "<", ">", "|", "/", "&", "-", "x", "Page", "of"];
/** Month names are kept only inside an `<option>`; elsewhere "May" is somebody's surname. */
const OPTION_ONLY = MONTHS;

/** Comments that may stay (the markup's own section markers); every other comment is emptied. */
const STRUCTURAL_COMMENTS: readonly string[] = [
	"start of Attendance", "End of Attendance", "start of Roles", "End of Roles", "Start of Table Topics Speakers", "End of Table Topics Speakers",
];

/** CSS classes the walker's selectors can name. An unlisted class is renamed `x`: a class is a string a page can carry data in. */
const CLASSES: readonly string[] = [
	"maintitle", "smalltitle", "gen", "genmed", "gensmall", "tabline", "tabActive", "tabSpace", "tabInactive", "genlarge", "post", "toprow",
	"reverse", "row1", "name", "forumline", "catHead", "cathead", "row2", "thLeft", "catTop", "reversetitle", "postbody", "postbody;gen",
	"nav", "subtitle", "bodyline", "cattitle", "catBottom", "thTop", "thRight", "thHead", "mainoption", "catbottom", "row3", "empty",
	"genmedium", "catLeft", "catRight", "cat",
];

/** The lowercase words of an `id`, `name` or `for` that is markup, not data: `post_button_1`, `status_div_<status>`. */
const ID_WORDS: readonly string[] = [
	"cached", "user", "club", "speech", "status", "workbook", "task", "title", "ready", "date", "date1", "date2", "date3", "introduction",
	"agenda", "ret", "save", "img", "portal", "left", "panel", "attend", "image", "image1", "post", "button", "text", "div", "attendance",
	"and", "roles", "txt", "hidespeeches", "accept", "speechdetail", "available", "y", "p", "v", "n", "m", "l", "s", "form2", "column", "email",
	"phone", "comment", "chk", "rec", "eval", "list", "mode", "awards", "start", "end", "month", "year", "null", "toastmaster", "submit",
	"bookspeechfrm", "meetingfrm",
];

const URL_HOSTS = /^(?:(?:www\.)?easy-speak\.org|(?:[a-z0-9-]+\.)*toastmasters\.org|(?:www\.)?marshalls\.org)$/i;
/** Path segments that are the site's own: a page name (`view_meeting.php`) or one of these. */
const PATH_WORDS: readonly string[] = ["mobile", "api", "v1", "tmtools", "reports", "images", "index.html", "my-evaluations", "eval"];
const PAGE_NAME = /^[A-Za-z_]{1,30}\.(?:php|html|aspx|cfm|cgi)$/;

/** Query parameters whose value is a person's id. */
const PERSON_PARAMS = /^(?:u|uid|user|userid|user_id|speaker|member|memberid|member_id|person|personid|pid)$/i;
const CLUB_PARAMS = /^(?:c|club|clubid|club_id|requestedclub|cached_club)$/i;
/** Query parameters that hold a small id or a count. */
const NUMBER_PARAMS = /^(?:t|s|k|page|ret|pr|z|r|chart|start_year|end_year|year|month)$/i;
const WORD_PARAMS = /^(?:mode|show|action|go|mon|sort|order|s)$/i;
const KNOWN_PARAMS = /^(?:u|uid|user|userid|user_id|speaker|member|memberid|member_id|person|personid|pid|h|d|c|club|clubid|club_id|requestedclub|t|s|k|page|ret|pr|z|r|chart|start_year|end_year|year|month|d|mode|show|action|go|mon|sort|order|id|p|m|n)$/i;

const CODE_WORDS: ReadonlySet<string> = new Set([
	"window", "open", "javascript", "void", "showStatus", "hideSpeeches", "tabTitle", "tabWorkbook", "tabDate", "return", "false", "true",
	"this", "document", "location", "href", "confirm", "submit", "function", "if", "else", "var", "let", "const", "null", "undefined",
	"history", "back", "forward", "close", "focus", "blur", "form", "value", "checked", "getElementById", "style", "display", "none",
	"block", "event", "preventDefault", "stopPropagation", "parent", "self", "top", "alert",
]);

/** Everything a reviewer needs to read, in one place. */
export const ALLOW_LIST = {
	phrases: STRUCTURAL_PHRASES,
	exactNodes: STRUCTURAL_EXACT_NODES,
	optionOnly: OPTION_ONLY,
	comments: STRUCTURAL_COMMENTS,
	classes: CLASSES,
	idWords: ID_WORDS,
	pathWords: PATH_WORDS,
	codeWords: [...CODE_WORDS],
	urlHosts: URL_HOSTS.source,
} as const;

// ------------------------------------------------------------------ what the committed fixtures already carry

const fakePhrases = JSON.parse(readFixture("non-person-phrases.json")) as Record<string, string[] | string>;
/**
 * Invented values the committed fixtures already contain (fake people, the fixture club's place names
 * and the speech titles made up for it). Not structural: only here so a committed page passes through
 * the generator unchanged where it was already fake. A real page never matches them.
 */
const ALREADY_FAKE: readonly string[] = [
	...FAKE_NAMES,
	...((fakePhrases.fixturePlaces as string[]) ?? []),
	...((fakePhrases.speechTitlesAndThemes as string[]) ?? []),
];
const FAKE_USERNAME = (JSON.parse(readFixture("fake-names.json")) as { usernames: string[] }).usernames[0];
const FAKE_CLUB_IDS: readonly string[] = ["4242", "9999"];

// ------------------------------------------------------------------ the text scrubber

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SP = String.raw`[\s ]+`;
const phraseSource = (p: string) => esc(p).replace(/ /g, SP);
const L = String.raw`\p{L}\p{N}\p{M}`;
const WEEKDAY = WEEKDAYS.join("|");
const MONTH = MONTHS.join("|");
const MONTH_SHORT = MONTH_ABBR.join("|");
const TIME = String.raw`\d{1,2}:\d{2}(?:[\s ]?[ap]m)?`;
const TZ = String.raw`(?:America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian)/[A-Za-z_]+(?:/[A-Za-z_]+)?`;

/** Date, time and count shapes. Month and weekday NAMES are only ever kept inside one of these. */
const SHAPES: readonly string[] = [
	String.raw`(?:(?:${WEEKDAY})${SP})?\d{1,2}(?:st|nd|rd|th)${SP}(?:${MONTH})${SP}(?:19|20)\d{2}(?:${SP}at${SP}${TIME}(?:${SP}${TZ})?)?`,
	String.raw`Every${SP}(?:${WEEKDAY})${SP}at${SP}${TIME}`,
	String.raw`(?:${MONTH_SHORT})${SP}\d{2}${SP}\d{2},${SP}${TIME}`,
	String.raw`(?:${MONTH})${SP}\d{1,2},?${SP}(?:19|20)\d{2}`,
	String.raw`(?:${MONTH})${SP}(?:19|20)\d{2}`,
	String.raw`(?:19|20)\d{2}-\d{2}-\d{2}`,
	String.raw`(?:19|20)\d{2}-(?:19|20)\d{2}`,
	String.raw`[A-Z]{3,4}${SP}\(GMT[+\-−]\d{1,2}${SP}hrs\)`,
	String.raw`\(555\)${SP}010-\d{4}`,
	String.raw`Division${SP}[A-Z]`,
	TZ,
	TIME,
	String.raw`\d{1,2}(?:st|nd|rd|th)`,
	String.raw`x\d{1,3}`,
	String.raw`\d{1,3}%`,
];

const phrasesLongestFirst = [...STRUCTURAL_PHRASES, ...ALREADY_FAKE, FAKE_USERNAME].sort((a, b) => b.length - a.length);

// A separator inside a number that is a phone: space, dot, hyphen, the Unicode dashes and the non-breaking hyphen.
const PHONE_SEP = String.raw`\s(). ‐-―−\-`;
const SCAN = new RegExp(
	[
		`(?<keep>(?<![${L}_])(?:${phrasesLongestFirst.map(phraseSource).join("|")}|${SHAPES.join("|")})(?![${L}]))`,
		String.raw`(?<user>\[[^\[\]\s]{1,60}\])`,
		`(?<phone>(?<![${L}])(?:\\+|00)?\\(?\\d[\\d${PHONE_SEP}]{5,}\\d(?![${L}]))`,
		`(?<big>(?<![${L}])\\d{4,}(?![${L}]))`,
		`(?<small>(?<![${L}_])\\d{1,3}(?![${L}]))`,
	].join("|"),
	"gu",
);
const UPPER = /^\p{Lu}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const ADJACENT = /^[\s _'’-]*$/;
const NAME_SHAPE = /^\p{Lu}[\p{L}\p{M}'’-]*(?:[\s ]+\p{Lu}[\p{L}\p{M}'’.-]*)+$/u;
/** The bracketed words the site itself prints; any other `[word]` is a username. */
const BRACKET_WORDS = new Set(["[Show]", "[Hide]", "[M]", "[P]", "[O]", "[N]"]);

interface Hit {
	start: number;
	end: number;
	kind: "keep" | "repl";
	/** A kept phrase can be swallowed into an adjacent replaced name. */
	text: string;
	out: string;
}

/** Everything one run remembers, so one real value always becomes the same fake. */
export interface RewriteState {
	names: Map<string, string>;
	words: Map<string, string>;
	phones: Map<string, string>;
	people: Map<string, string>;
	numbers: Map<string, string>;
	usedNames: Set<string>;
	usedPeople: Set<string>;
	usedNumbers: Set<string>;
	nextPerson: number;
	nextClub: number;
	nextPhone: number;
	nextWord: number;
}

export function newRewriteState(): RewriteState {
	return {
		names: new Map(),
		words: new Map(),
		phones: new Map(),
		people: new Map(),
		numbers: new Map(),
		usedNames: new Set(),
		usedPeople: new Set(),
		usedNumbers: new Set(FAKE_CLUB_IDS),
		nextPerson: 900_001,
		nextClub: 4242,
		nextPhone: 1,
		nextWord: 1,
	};
}

const keyOf = (s: string) => s.replace(/[\s +]+/g, " ").trim().toLowerCase();

function fakeName(st: RewriteState, core: string): string {
	const k = keyOf(core);
	const have = st.names.get(k);
	if (have) return have;
	const next = FAKE_NAMES.find((n) => !st.usedNames.has(n));
	if (!next) throw new Error("the page has more distinct names than fake-names.json holds; add INVENTED names there, never real ones");
	st.usedNames.add(next);
	st.names.set(k, next);
	return next;
}

function fakeWord(st: RewriteState, core: string): string {
	const k = keyOf(core);
	const have = st.words.get(k);
	if (have) return have;
	const w = `redacted-${st.nextWord++}`;
	st.words.set(k, w);
	return w;
}

const fakeText = (st: RewriteState, core: string) => (NAME_SHAPE.test(core.trim()) ? fakeName(st, core) : fakeWord(st, core));

function fakePhone(st: RewriteState, digits: string): string {
	const have = st.phones.get(digits);
	if (have) return have;
	const p = `(555) 010-${String(st.nextPhone++).padStart(4, "0")}`;
	st.phones.set(digits, p);
	return p;
}

/** A person id: 900001-900999 is already fake and stays; any other id becomes the next unused one in that range. */
function fakePerson(st: RewriteState, id: string): string {
	if (!/^\d+$/.test(id)) return "x";
	const n = Number(id);
	if (n >= 900_001 && n <= 900_999) return id;
	const have = st.people.get(String(n));
	if (have) return have;
	while (st.usedPeople.has(String(st.nextPerson))) st.nextPerson += 1;
	const f = String(st.nextPerson++);
	st.usedPeople.add(f);
	st.people.set(String(n), f);
	return f;
}

/** A club id or number (or any other long number): the same number, however it is zero-padded, gets one fake. */
function fakeNumber(st: RewriteState, id: string): string {
	if (!/^\d+$/.test(id)) return "x";
	if (FAKE_CLUB_IDS.includes(id)) return id;
	const n = Number(id);
	if (n >= 900_001 && n <= 900_999) return id;
	let f = st.numbers.get(String(n));
	if (!f) {
		while (st.usedNumbers.has(String(st.nextClub))) st.nextClub += 1;
		f = String(st.nextClub++);
		st.usedNumbers.add(f);
		st.numbers.set(String(n), f);
	}
	return f.padStart(id.length, "0");
}

/** A run of digits that is not a date or a count: a phone if it looks like one, else an id. */
function replaceDigits(st: RewriteState, text: string, isBare: boolean): string {
	const digits = text.replace(/\D/g, "");
	if (/^(?:19|20)\d{2}[\s‐-―−-]+\d{1,2}[\s‐-―−-]+\d{1,2}$/.test(text.trim())) return text;
	if (digits.length < 7 || digits.length > 15) return isBare ? fakeNumber(st, digits) : fakePhone(st, digits);
	if (isBare && !/^0/.test(digits) && digits.length < 9) return fakeNumber(st, digits);
	if (/^555010\d{4}$/.test(digits.replace(/^1/, ""))) return text;
	return fakePhone(st, digits.replace(/^1(\d{10})$/, "$1"));
}

const isCapitalEdge = (word: string | undefined) => !!word && UPPER.test(word);
const lastWord = (s: string) => s.trim().split(/[\s '’-]+/).pop();
const firstWord = (s: string) => s.trim().split(/[\s '’-]+/)[0];

/**
 * A string of text with everything not on the allow-list replaced. Whitespace and punctuation between
 * words are kept. A word run next to an allowed capitalised phrase is replaced WITH it ("Dana Member":
 * "Member" is allowed, "Dana" is not, and a surname that is also a role must not survive on its own).
 */
export function scrubText(st: RewriteState, text: string): string {
	return scrubDetailed(st, text).out;
}

/** What `scrubDetailed` knows about an edge of the text, so a neighbouring text node can be judged against it. */
export interface Edge {
	/** The text at this edge was an allowed phrase and was kept. */
	kept: boolean;
	/** The text at this edge was an unknown capitalised word run and was replaced. */
	replacedCapital: boolean;
	/** The kept phrase at this edge starts (or ends) with a capital letter. */
	capital: boolean;
	/** The kept phrase is one word. Only a one-word phrase ("Timer") can be somebody's surname; a label ("Meeting Theme") cannot. */
	single: boolean;
}

export interface Scrubbed {
	out: string;
	first: Edge | null;
	last: Edge | null;
}

/**
 * `scrubText`, reporting what sits at each edge. `forceFirst` / `forceLast` replace a kept phrase at
 * that edge too: `Marlowe <b>Timer</b>` is two text nodes, and "Timer" is allowed on its own, but
 * not as the end of a name.
 */
export function scrubDetailed(st: RewriteState, text: string, force: { first?: boolean; last?: boolean } = {}): Scrubbed {
	const hits: Hit[] = [];
	for (const m of text.matchAll(SCAN)) {
		const g = m.groups ?? {};
		const start = m.index ?? 0;
		const raw = m[0];
		const end = start + raw.length;
		if (g.keep !== undefined) hits.push({ start, end, kind: "keep", text: raw, out: raw });
		else if (g.user !== undefined) {
			hits.push({ start, end, kind: "repl", text: raw, out: BRACKET_WORDS.has(raw) ? raw : `[${FAKE_USERNAME}]` });
		} else if (g.phone !== undefined) hits.push({ start, end, kind: "repl", text: raw, out: replaceDigits(st, raw, /^\d+$/.test(raw)) });
		else if (g.big !== undefined) hits.push({ start, end, kind: "repl", text: raw, out: replaceDigits(st, raw, true) });
		else hits.push({ start, end, kind: "keep", text: raw, out: raw });
	}
	// Gaps: what lies between hits and still has a letter or a digit in it.
	interface Seg {
		start: number;
		end: number;
		replaced: boolean;
		out?: string;
	}
	const segs: Seg[] = [];
	let at = 0;
	const gap = (from: number, to: number) => {
		const s = text.slice(from, to);
		const first = s.search(LETTER_OR_DIGIT);
		if (first < 0) return;
		let last = s.length - 1;
		while (!LETTER_OR_DIGIT.test(s[last])) last -= 1;
		segs.push({ start: from + first, end: from + last + 1, replaced: true });
	};
	for (const h of hits) {
		gap(at, h.start);
		segs.push({ start: h.start, end: h.end, replaced: h.kind === "repl", out: h.kind === "repl" ? h.out : undefined });
		at = h.end;
	}
	gap(at, text.length);
	segs.sort((x, y) => x.start - y.start);
	// A word run that is replaced swallows an adjacent kept capitalised phrase.
	const kept = (s: Seg) => !s.replaced;
	const oneWord = (s: Seg) => !/[\s\u00a0]/.test(text.slice(s.start, s.end).trim());
	const isGap = (s: Seg) => s.replaced && s.out === undefined;
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < segs.length; i++) {
			if (!isGap(segs[i])) continue;
			const core = text.slice(segs[i].start, segs[i].end);
			const prev = segs[i - 1];
			const next = segs[i + 1];
			if (prev && kept(prev) && oneWord(prev) && ADJACENT.test(text.slice(prev.end, segs[i].start)) && isCapitalEdge(lastWord(text.slice(prev.start, prev.end))) && isCapitalEdge(firstWord(core)) && LETTER_OR_DIGIT.test(text.slice(prev.start, prev.end))) {
				segs[i] = { start: prev.start, end: segs[i].end, replaced: true };
				segs.splice(i - 1, 1);
				changed = true;
				break;
			}
			if (next && kept(next) && oneWord(next) && ADJACENT.test(text.slice(segs[i].end, next.start)) && isCapitalEdge(firstWord(text.slice(next.start, next.end))) && isCapitalEdge(lastWord(core)) && /^\p{L}/u.test(text.slice(next.start, next.end))) {
				segs[i] = { start: segs[i].start, end: next.end, replaced: true };
				segs.splice(i + 1, 1);
				changed = true;
				break;
			}
		}
	}
	const wordish = (s: Seg) => !/\d/.test(text.slice(s.start, s.end)) && /\p{L}/u.test(text.slice(s.start, s.end));
	if (force.first && segs.length > 0 && kept(segs[0]) && wordish(segs[0])) segs[0] = { ...segs[0], replaced: true };
	if (force.last && segs.length > 0 && kept(segs[segs.length - 1]) && wordish(segs[segs.length - 1])) segs[segs.length - 1] = { ...segs[segs.length - 1], replaced: true };
	const edge = (s: Seg | undefined, atEnd: boolean): Edge | null => {
		if (!s) return null;
		const core = text.slice(s.start, s.end);
		const capital = isCapitalEdge(atEnd ? lastWord(core) : firstWord(core));
		return { kept: kept(s), replacedCapital: isGap(s) && capital, capital, single: !/[\s\u00a0]/.test(core.trim()) };
	};
	let out = "";
	let pos = 0;
	for (const s of segs) {
		out += text.slice(pos, s.start);
		out += s.replaced ? (s.out ?? fakeText(st, text.slice(s.start, s.end))) : text.slice(s.start, s.end);
		pos = s.end;
	}
	return { out: out + text.slice(pos), first: edge(segs[0], false), last: edge(segs[segs.length - 1], true) };
}

// ------------------------------------------------------------------ URLs, code and attributes

const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "%20");

function rewriteValue(st: RewriteState, name: string, value: string, path: string): string {
	if (PERSON_PARAMS.test(name) || (/^id$/i.test(name) && !/ClubReport/i.test(path))) return fakePerson(st, value);
	if (CLUB_PARAMS.test(name) || /^id$/i.test(name)) return fakeNumber(st, value);
	if (/^[pm]$/i.test(name)) return /^\(-?[\d.]+,-?[\d.]+\)(?:,\d+)?$/.test(value) ? value.replace(/-?\d+\.\d+/g, "0.000000") : "x";
	if (/^n$/i.test(name)) return enc(scrubText(st, decodeLoose(value)));
	if (/^s$/i.test(name)) return /^\d{1,8}$/.test(value) || /^[a-z]{1,12}$/.test(value) ? value : "x";
	if (/^[hd]$/i.test(name)) return /^\d{1,3}$/.test(value) ? value : "x";
	if (NUMBER_PARAMS.test(name)) return /^\d{1,8}$/.test(value) ? value : "x";
	if (WORD_PARAMS.test(name)) return /^[A-Za-z_]{1,20}$/.test(value) ? value : "x";
	return "x";
}

function decodeLoose(s: string): string {
	try {
		return decodeURIComponent(s.replace(/\+/g, " "));
	} catch {
		return s;
	}
}

/** A URL with its host, path and every query value checked; the shape stays, every id and name in it is replaced. */
export function rewriteUrl(st: RewriteState, value: string): string {
	const raw = value.trim();
	if (raw === "") return value;
	if (/^javascript:/i.test(raw)) return `javascript:${rewriteCode(st, raw.replace(/^javascript:/i, ""))}`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return "#";
	const m = /^(?:(https?:))?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw);
	if (!m) return "#";
	const [, scheme, host, path = "", query, frag] = m;
	let out = "";
	// example.test is reserved: a host there is already a fake, and its path is the fixture's own.
	const fakeHost = host !== undefined && /^(?:[a-z0-9-]+\.)*example\.test$/i.test(host);
	if (host !== undefined) out += `${scheme ?? ""}//${/^[a-z0-9.-]+$/i.test(host) && (URL_HOSTS.test(host) || fakeHost) ? host : "example.test"}`;
	out += path
		.split("/")
		.map((seg) => {
			if (seg === "" || (fakeHost && /^[a-z0-9_-]{1,40}$/.test(seg)) || PAGE_NAME.test(seg) || PATH_WORDS.includes(seg) || /^\d{1,3}$/.test(seg)) return seg;
			if (/^\d+$/.test(seg)) return "1";
			const ext = /\.(?:gif|png|jpe?g|svg|css|js|ico|json)$/i.exec(seg);
			return ext ? `x${ext[0].toLowerCase()}` : "x";
		})
		.join("/");
	if (query !== undefined) {
		out += `?${query
			.split("&")
			.filter((kv) => kv !== "")
			.map((kv) => {
				const eq = kv.indexOf("=");
				const k = decodeLoose(eq < 0 ? kv : kv.slice(0, eq));
				const v = eq < 0 ? null : decodeLoose(kv.slice(eq + 1));
				if (!KNOWN_PARAMS.test(k)) return v === null ? "x" : "x=x";
				return v === null ? k : `${k}=${rewriteValue(st, k, v, path)}`;
			})
			.join("&")}`;
	}
	if (frag !== undefined) out += /^[a-z_]{0,20}$/.test(frag) ? `#${frag}` : "#";
	return out;
}

/** An event handler or a `javascript:` URL: string literals that are URLs go through `rewriteUrl`, the rest through `scrubText`; a bare word must be a known one. */
export function rewriteCode(st: RewriteState, code: string): string {
	const bare = (s: string) =>
		s
			.replace(/[\p{L}_$][\p{L}\p{N}_$]*/gu, (w) => (CODE_WORDS.has(w) ? w : "x"))
			.replace(/\d{4,}/g, (d) => fakePerson(st, d));
	let out = "";
	let pos = 0;
	for (const m of code.matchAll(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
		const idx = m.index ?? 0;
		out += bare(code.slice(pos, idx));
		const body = m[2];
		const inner = /\.(?:php|html|aspx|cfm|cgi)(?:[?#]|$)|^https?:\/\//i.test(body) ? rewriteUrl(st, body) : scrubText(st, body);
		out += `${m[1]}${inner.replaceAll(m[1], "")}${m[1]}`;
		pos = idx + m[0].length;
	}
	return out + bare(code.slice(pos));
}

const ENUMS: Record<string, RegExp> = {
	charset: /^utf-8$/i,
	method: /^(?:get|post)$/i,
	type: /^(?:hidden|button|radio|submit|checkbox|text|password|textarea|select|reset)$/i,
	align: /^(?:left|right|center|justify)$/i,
	valign: /^(?:top|middle|bottom|baseline)$/i,
	colspan: /^\d{1,3}$/,
	rowspan: /^\d{1,3}$/,
	size: /^\d{1,3}$/,
	maxlength: /^\d{1,4}$/,
	border: /^\d{1,2}$/,
	cellpadding: /^\d{1,3}$/,
	cellspacing: /^\d{1,3}$/,
	width: /^\d{1,4}%?$/,
	height: /^\d{1,4}%?$/,
	wrap: /^(?:virtual|physical|off|soft|hard)$/i,
	color: /^#[0-9a-f]{3,8}[,;]?$/i,
	bgcolor: /^#[0-9a-f]{3,8}[,;]?$/i,
	target: /^_[a-z]+$/,
	disabled: /^(?:|disabled)$/i,
	checked: /^(?:|checked)$/i,
	selected: /^(?:|selected)$/i,
	readonly: /^(?:|readonly)$/i,
	nowrap: /^(?:|nowrap)$/i,
	multiple: /^(?:|multiple)$/i,
	hidden: /^(?:|hidden)$/i,
};
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "background", "cite", "data", "longdesc", "codebase", "usemap"]);
const FORM_PERSON = /user|member|person|speaker|^rec\[/i;
const PERSON_IN_ATTR = /((?<![A-Za-z])(?<!(?<!%[0-9a-f])[0-9])(?:u|[a-z_]*(?:user|member|person|uid)[a-z_]*)(?:=|%3[dD])|attend_image1?\[|available\[|rec\[|available_)(\d+)/gi;
const ID_WORD_SET = new Set(ID_WORDS);

/** An `id`, `name` or `for`: the lowercase markup words stay, a person id inside is replaced, anything else goes through `scrubText`. */
function rewriteIdent(st: RewriteState, v: string): string {
	const withIds = v.replace(PERSON_IN_ATTR, (_m, pre: string, id: string) => `${pre}${fakePerson(st, id)}`);
	const parts = withIds.split(/([_\-[\]\s]+)/);
	let i = 0;
	let head = "";
	for (; i < parts.length; i++) {
		const p = parts[i];
		if (i % 2 === 1 || p === "" || ID_WORD_SET.has(p.toLowerCase()) || /^\d{1,3}$/.test(p) || (/^\d+$/.test(p) && Number(p) >= 900_001 && Number(p) <= 900_999)) head += p;
		else break;
	}
	return head + scrubText(st, parts.slice(i).join(""));
}

function rewriteFormValue(st: RewriteState, fieldName: string, value: string): string {
	if (/^\d+$/.test(value)) {
		if (/year/i.test(fieldName) && /^(?:19|20)\d{2}$/.test(value)) return value;
		if (value.length <= 3) return value;
		if (/club/i.test(fieldName)) return fakeNumber(st, value);
		if (FORM_PERSON.test(fieldName)) return fakePerson(st, value);
		if (/speech|task|meeting|agenda/i.test(fieldName)) return value;
		return fakeNumber(st, value);
	}
	return scrubText(st, value);
}

export function rewriteAttribute(st: RewriteState, el: Element, name: string, value: string): string {
	const n = name.toLowerCase();
	if (n in ENUMS) return ENUMS[n].test(value.trim()) ? value : "";
	if (n === "class") return value.split(/\s+/).filter(Boolean).map((c) => (CLASSES.includes(c) ? c : "x")).join(" ");
	if (URL_ATTRS.has(n)) return rewriteUrl(st, value);
	if (n.startsWith("on") || /^\s*javascript:/i.test(value)) return rewriteCode(st, value.replace(/^\s*javascript:/i, ""));
	if (n === "id" || n === "name" || n === "for") return rewriteIdent(st, value);
	if (n === "value") {
		const field = el.getAttribute("name") ?? "";
		return rewriteFormValue(st, field, value);
	}
	return scrubText(st, value);
}

// ------------------------------------------------------------------ the page

const CREDENTIALS = /,\s*[A-Z]{2,4}(?:\s+[A-Z]{2,4})*$/;
const PERSON_LINK = /(?:[?&;]|^|\s)u=\d+/;

/** Fake ids and names the page already holds, so a new fake never collides with one of them. */
function preload(st: RewriteState, html: string) {
	for (const m of html.matchAll(/(?<!\d)900\d{3}(?!\d)/g)) st.usedPeople.add(m[0]);
	for (const n of FAKE_NAMES) if (html.includes(n)) st.usedNames.add(n);
	for (const m of html.matchAll(/(?<!\d)(?:42\d{2}|99\d{2})(?!\d)/g)) st.usedNumbers.add(m[0]);
}

export interface RewriteOptions {
	/** Shared between pages of one run, so a person keeps one fake across them. */
	state?: RewriteState;
}

/** Block elements: text in two of these is never one name or one phone. Text under the nearest one is a group. */
const CONTAINERS = new Set(["td", "th", "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "body", "blockquote", "pre", "dd", "dt", "caption", "option", "title", "textarea", "label"]);
const PHONE_ACROSS = new RegExp(`(?<![${L}])(?:\\+|00)?\\(?\\d[\\d${PHONE_SEP}]{5,}\\d(?![${L}])`, "gu");
const DATE_ONLY = /^(?:(?:19|20)\d{2}[\s\u2010-\u2015\u2212-]+\d{1,2}[\s\u2010-\u2015\u2212-]+\d{1,2}|(?:19|20)\d{2}[\s\u2010-\u2015\u2212-]+(?:19|20)\d{2})$/;

/** A phone split by inline tags (`<span>415</span>-<span>555</span>-<span>0199</span>`) is replaced across the nodes it spans. */
function phonesAcrossNodes(st: RewriteState, nodes: Node[]) {
	const texts = nodes.map((n) => n.nodeValue ?? "");
	const whole = texts.join("");
	const owner: number[] = [];
	texts.forEach((t, i) => {
		for (let k = 0; k < t.length; k++) owner.push(i);
	});
	const spans: { s: number; e: number; fake: string }[] = [];
	for (const m of whole.matchAll(PHONE_ACROSS)) {
		const s = m.index ?? 0;
		const e = s + m[0].length;
		if (owner[s] === owner[e - 1]) continue;
		const digits = m[0].replace(/\D/g, "");
		if (digits.length < 7 || digits.length > 15 || DATE_ONLY.test(m[0])) continue;
		spans.push({ s, e, fake: /^555010\d{4}$/.test(digits) ? m[0] : fakePhone(st, digits) });
	}
	if (spans.length === 0) return;
	const out = texts.map(() => "");
	let at = 0;
	for (const sp of spans) {
		for (; at < sp.s; at++) out[owner[at]] += whole[at];
		out[owner[sp.s]] += sp.fake;
		at = sp.e;
	}
	for (; at < whole.length; at++) out[owner[at]] += whole[at];
	nodes.forEach((n, i) => {
		n.nodeValue = out[i];
	});
}

interface TextItem {
	node: Node;
	text: string;
	lead: string;
	trail: string;
	/** Set when the text was handled specially (a person link, the header, a club number) or kept on sight. */
	fixed: string | null;
	res: Scrubbed | null;
	forceFirst: boolean;
	forceLast: boolean;
}

/** Saved page in, fixture page out. Pure: no file system. Throws only if fake-names.json runs out of names. */
export function rewriteEasySpeakPage(html: string, opts: RewriteOptions = {}): string {
	const st = opts.state ?? newRewriteState();
	preload(st, html);
	const doc = parseHtml(html);
	const root = doc.documentElement;
	if (!root) return "";
	// The parser hands back "Ren&eacute; Dup" as three text nodes; they are one piece of text.
	for (const el of [root, ...Array.from(doc.querySelectorAll("*"))]) {
		const kids = Array.from(el.childNodes ?? []);
		for (let i = kids.length - 1; i > 0; i--) {
			if (kids[i].nodeType === 3 && kids[i - 1].nodeType === 3) {
				kids[i - 1].nodeValue = `${kids[i - 1].nodeValue ?? ""}${kids[i].nodeValue ?? ""}`;
				el.removeChild(kids[i]);
			}
		}
	}
	const groups = new Map<Element | null, Node[]>();
	const collect = (n: Node) => {
		if (n.nodeType === 8) {
			const body = (n.nodeValue ?? "").trim();
			n.nodeValue = STRUCTURAL_COMMENTS.includes(body) ? n.nodeValue : "";
			return;
		}
		if (n.nodeType === 3) {
			const parent = n.parentElement as Element | null;
			const tag = parent?.tagName.toLowerCase() ?? "";
			if (tag === "script" || tag === "style") {
				n.nodeValue = "";
				return;
			}
			let c: Element | null = parent;
			while (c && !CONTAINERS.has(c.tagName.toLowerCase())) c = c.parentElement;
			const list = groups.get(c) ?? [];
			list.push(n);
			groups.set(c, list);
			return;
		}
		for (const c of Array.from(n.childNodes ?? [])) collect(c);
	};
	collect(root);
	for (const nodes of groups.values()) if (nodes.length > 1) phonesAcrossNodes(st, nodes);
	// Text first: the person-link test reads the links' ORIGINAL attributes.
	const sequences: TextItem[][] = [];
	let prevText = "";
	for (const nodes of groups.values()) {
		const seq: TextItem[] = [];
		for (const n of nodes) {
			const parent = n.parentElement as Element | null;
			const tag = parent?.tagName.toLowerCase() ?? "";
			const text = n.nodeValue ?? "";
			const t = text.replace(/[\s\u00a0]+/g, " ").trim();
			if (t === "") continue;
			const item: TextItem = { node: n, text: t, lead: text.match(/^[\s\u00a0]*/)?.[0] ?? "", trail: text.match(/[\s\u00a0]*$/)?.[0] ?? "", fixed: null, res: null, forceFirst: false, forceLast: false };
			const pager = parent && /^Page \d{1,4} of \d{1,4}$/.test((parent.closest(".nav")?.textContent ?? parent.textContent ?? "").replace(/[\s\u00a0]+/g, " ").trim());
			const link = parent?.closest("a") ?? null;
			const linkAttrs = link ? `${link.getAttribute("href") ?? ""} ${link.getAttribute("onclick") ?? ""}` : "";
			const decodedAttrs = decodeLoose(linkAttrs.replace(/&amp;/g, "&"));
			if (pager || STRUCTURAL_EXACT_NODES.includes(t) || (tag === "option" && OPTION_ONLY.includes(t))) {
				item.fixed = t;
			} else if (link && /profile\.php\?mode=editprofile/.test(linkAttrs) && !/^Welcome back/.test(t)) {
				item.fixed = FAKE_USERNAME;
			} else if (link && /profile\.php\?mode=editprofile/.test(linkAttrs)) {
				const who = t.replace(/^Welcome back\s*/, "").replace(CREDENTIALS, "");
				item.fixed = `Welcome back ${ALREADY_FAKE.includes(who) ? who : fakeName(st, who)}`;
			} else if (link && PERSON_LINK.test(decodedAttrs) && !/^(?:Request a Speech\.\.\.|Accept|TBA)$/.test(t)) {
				const cred = CREDENTIALS.exec(t)?.[0] ?? "";
				const core = t.replace(CREDENTIALS, "");
				item.fixed = `${ALREADY_FAKE.includes(core) ? core : fakeName(st, core)}${cred ? scrubText(st, cred) : ""}`;
			} else if (prevText === "Club Number" && /^\d+$/.test(t)) {
				item.fixed = fakeNumber(st, t);
			} else {
				item.res = scrubDetailed(st, t);
			}
			prevText = t;
			seq.push(item);
		}
		sequences.push(seq);
	}
	// A name split across inline tags ("Marlowe <b>Timer</b>"): an allowed phrase next to a replaced name is replaced too.
	for (const seq of sequences) {
		for (let round = 0; round < 6; round++) {
			let changed = false;
			for (let k = 0; k + 1 < seq.length; k++) {
				const a = seq[k];
				const b = seq[k + 1];
				if (!a.res || !b.res) continue;
				if (a.res.last?.replacedCapital && b.res.first?.kept && b.res.first.capital && b.res.first.single && !b.forceFirst) {
					b.forceFirst = true;
					b.res = scrubDetailed(st, b.text, { first: true, last: b.forceLast });
					changed = true;
				}
				if (b.res.first?.replacedCapital && a.res.last?.kept && a.res.last.capital && a.res.last.single && !a.forceLast) {
					a.forceLast = true;
					a.res = scrubDetailed(st, a.text, { first: a.forceFirst, last: true });
					changed = true;
				}
			}
			if (!changed) break;
		}
	}
	for (const seq of sequences) for (const it of seq) it.node.nodeValue = `${it.lead}${it.fixed ?? it.res?.out ?? ""}${it.trail}`;
	for (const el of Array.from(doc.querySelectorAll("*"))) {
		for (const a of Array.from(el.attributes ?? [])) {
			// linkedom writes an attribute value as it holds it, so a bare "&" would come out unescaped.
			el.setAttribute(a.name, rewriteAttribute(st, el, a.name, a.value).replace(/&/g, "&amp;"));
		}
	}
	return doc.toString();
}

export interface GenerateResult {
	html: string;
	/** What `fixtureViolations` reports on the output. Empty means the second net found nothing; a human still reads the file. */
	violations: string[];
}

/** The rewrite plus the second net. */
export function generateFixture(html: string, opts: RewriteOptions & FixtureCheckOptions = {}): GenerateResult {
	const { state, ...check } = opts;
	const out = rewriteEasySpeakPage(html, { state });
	return { html: out, violations: fixtureViolations(out, check) };
}

// ------------------------------------------------------------------ the command

function main(argv: string[]): number {
	const args = [...argv];
	const flag = (name: string) => {
		const i = args.indexOf(name);
		if (i < 0) return false;
		args.splice(i, 1);
		return true;
	};
	const value = (name: string): string[] => {
		const out: string[] = [];
		for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
			out.push(args[i + 1] ?? "");
			args.splice(i, 2);
		}
		return out;
	};
	const contactPage = flag("--contact-page");
	const archive = value("--archive")[0];
	const pageUrl = value("--page")[0];
	const original = {
		names: value("--real-name"),
		terms: value("--real-term"),
		clubIds: value("--real-club"),
		personIds: value("--real-person-id"),
	};
	let input: string;
	let outPath: string;
	if (archive) {
		const pages = (JSON.parse(readFileSync(archive, "utf8")) as { pages?: { url: string; html: string }[] }).pages ?? [];
		const hit = pages.filter((p) => pageUrl && p.url.includes(pageUrl));
		if (hit.length !== 1) {
			console.error(`--page ${pageUrl ?? "(missing)"} matched ${hit.length} pages in the archive; it must match exactly one`);
			return 2;
		}
		input = hit[0].html;
		outPath = args[0];
	} else {
		if (args.length !== 2) {
			console.error("usage: bun scripts/easy-speak-fixture-from-archive.ts <page.html> <out.html> [--contact-page] [--real-name N]...\n       bun scripts/easy-speak-fixture-from-archive.ts --archive <pages.json> --page <url> <out.html>");
			return 2;
		}
		input = readFileSync(args[0], "utf8");
		outPath = args[1];
	}
	if (!outPath) {
		console.error("no output path");
		return 2;
	}
	const result = generateFixture(input, { contactPage, original });
	if (result.violations.length > 0) {
		console.error("Nothing written. The output still carries:");
		for (const v of result.violations) console.error(`  - ${v}`);
		return 1;
	}
	writeFileSync(outPath, result.html);
	console.log(`wrote ${outPath}. Read every line before committing it: this is a net, not clearance.`);
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
