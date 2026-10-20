/**
 * Turns a saved Easy-Speak page into a committable fixture (#1272). **Deny by default.**
 *
 * The whole document is parsed (doctype, comments and head included). EVERY text node, comment and
 * attribute value is replaced with a fake unless it is on the allow-list (`ALLOW_LIST`, the only list
 * that decides what survives, and every list in it is a LITERAL one: an exact host, an exact page
 * name, an exact word). A regex shape that keeps free-form text (any word, any digit run, any
 * subdomain) is not an allow-list, so the shapes that remain are bounded to a date, a time or a one-
 * or two-digit count. Tag names and attribute names are checked too: an unknown one is renamed.
 * Nothing here looks for a name, a phone or an email to remove (an earlier regex rewriter did, and
 * real data kept getting past it); what is not known to be safe is replaced, so a shape nobody
 * thought of is replaced too. A value that merely LOOKS like a fake (a 900xxx id, a fake name, club
 * 4242) is replaced like any other: nothing is trusted for resembling the fixtures.
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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SP = String.raw`[\s ]+`;
const L = String.raw`\p{L}\p{N}\p{M}`;
const COLOR = "^#[0-9a-f]{3,8}[,;]?$";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIMEZONES = [
	"America/Los_Angeles", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Anchorage", "America/Toronto",
	"America/Vancouver", "America/Mexico_City", "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
	"Europe/Madrid", "Europe/Rome", "Asia/Singapore", "Asia/Tokyo", "Asia/Kolkata", "Asia/Dubai", "Asia/Hong_Kong", "Australia/Sydney",
	"Australia/Melbourne", "Australia/Perth", "Pacific/Auckland", "Pacific/Honolulu", "Africa/Johannesburg", "Africa/Lagos",
];

const TIME = String.raw`\d{1,2}:\d{2}(?:[\s ]?[ap]m)?`;
const TZ = TIMEZONES.map(esc).join("|");
const WEEKDAY = WEEKDAYS.join("|");
const MONTH = MONTHS.join("|");
const MONTH_SHORT = MONTH_ABBR.join("|");

/**
 * Date, time and count shapes, as regex sources. Month and weekday NAMES are only ever kept inside
 * one of these. None of them can hold a name: a count is one or two digits, a division one letter, a
 * timezone one of the literal zones above.
 */
const SHAPES: readonly string[] = [
	String.raw`(?:(?:${WEEKDAY})${SP})?\d{1,2}(?:st|nd|rd|th)${SP}(?:${MONTH})${SP}(?:19|20)\d{2}(?:${SP}at${SP}${TIME}(?:${SP}(?:${TZ}))?)?`,
	String.raw`Every${SP}(?:${WEEKDAY})${SP}at${SP}${TIME}`,
	String.raw`(?:${MONTH_SHORT})${SP}\d{2}${SP}\d{2},${SP}${TIME}`,
	String.raw`(?:${MONTH})${SP}\d{1,2},?${SP}(?:19|20)\d{2}`,
	String.raw`(?:${MONTH})${SP}(?:19|20)\d{2}`,
	String.raw`(?:19|20)\d{2}-\d{2}-\d{2}`,
	String.raw`(?:19|20)\d{2}-(?:19|20)\d{2}`,
	String.raw`[A-Z]{3,4}${SP}\(GMT[+\-−]\d{1,2}${SP}hrs\)`,
	String.raw`Division${SP}[A-Z]`,
	TZ,
	TIME,
	String.raw`\d{1,2}(?:st|nd|rd|th)`,
	String.raw`x\d{1,2}`,
	String.raw`\d{1,3}%`,
	// this generator's own placeholder word, so a second pass over its output changes nothing
	String.raw`redacted-\d{1,4}`,
];

/**
 * Everything that may survive, in one place. A reviewer reads this object; nothing else decides.
 * NEVER add a name, a club's own word, or a string only one club would show: add what every club's
 * page says. A phrase that is also a plausible surname ("May", "Page", "Small") must not be a phrase;
 * dates are shapes for that reason.
 */
export const ALLOW_LIST = {
	/** Text, exactly as written (case-sensitive, whole words). */
	phrases: [
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
	],
	/** Kept only when they are the WHOLE text node (a one-letter heading, a separator). */
	exactNodes: ["P", "O", "N", "M", "?", "<", ">", "|", "/", "&", "-", "x", "Page", "of"],
	/** Month names are kept only inside an `<option>`; elsewhere "May" is somebody's surname. */
	optionOnly: MONTHS,
	/** A one- to three-digit number is kept only next to one of these (or as a whole text node): a count, never a house number. */
	/** A one-word field label whose value is the next text node ("Venue" then a bold place). It is never half of a person's name. */
	valueLabels: ["Venue"],
	countLabels: ["Area", "District", "Hour", "Hours", "Mins", "min", "Days"],
	weekdays: WEEKDAYS,
	months: MONTHS,
	monthAbbreviations: MONTH_ABBR,
	/** The only timezone names (a literal zone, never `Region/Anything`). */
	timezones: TIMEZONES,
	/** Date, time and count shapes (regex sources), bounded so none can hold a name. */
	shapes: SHAPES,
	/** Comments that may stay (the markup's own section markers); every other comment is emptied. */
	comments: ["start of Attendance", "End of Attendance", "start of Roles", "End of Roles", "Start of Table Topics Speakers", "End of Table Topics Speakers"],
	/** CSS classes the walker's selectors can name. An unlisted class is renamed `x`: a class is a string a page can carry data in. */
	classes: [
		"maintitle", "smalltitle", "gen", "genmed", "gensmall", "tabline", "tabActive", "tabSpace", "tabInactive", "genlarge", "post", "toprow",
		"reverse", "row1", "name", "forumline", "catHead", "cathead", "row2", "thLeft", "catTop", "reversetitle", "postbody", "postbody;gen",
		"nav", "subtitle", "bodyline", "cattitle", "catBottom", "thTop", "thRight", "thHead", "mainoption", "catbottom", "row3", "empty",
		"genmedium", "catLeft", "catRight", "cat",
	],
	/** The lowercase words of an `id`, `name` or `for` that is markup, not data: `post_button_1`, `status_div_<status>`. */
	idWords: [
		"cached", "user", "club", "speech", "status", "workbook", "task", "title", "ready", "date", "date1", "date2", "date3", "introduction",
		"agenda", "ret", "save", "img", "portal", "left", "panel", "attend", "image", "image1", "post", "button", "text", "div", "attendance",
		"and", "roles", "txt", "hidespeeches", "accept", "speechdetail", "available", "y", "p", "v", "n", "m", "l", "s", "form2", "column", "email",
		"phone", "comment", "chk", "rec", "eval", "list", "mode", "awards", "start", "end", "month", "year", "null", "toastmaster", "submit",
		"bookspeechfrm", "meetingfrm", "speaker",
	],
	/** Exact hosts (lower case). A subdomain that is not listed here is replaced with `example.test`. */
	hosts: [
		"easy-speak.org", "www.easy-speak.org", "dashboards.toastmasters.org", "www.toastmasters.org", "marshalls.org", "www.marshalls.org",
		"example.test", "fixture-speakers.example.test",
	],
	/** Exact page names the walker reads or the pages link to (case-sensitive); any other file name becomes `x`. */
	pageNames: [
		"request_speech.php", "profile.php", "view_meeting.php", "topic_view_users.php", "viewagenda.php", "portal.php", "kb.php", "privmsg.php",
		"orgdata.php", "payment.php", "clubdata.php", "webcal_subscribe.php", "neardata.php", "ClubReport.aspx", "DCP_Hist.cgi", "Club_Ed.cgi",
		"tm_objective.php", "meeting_list.php", "memberlist.php", "tm_all_speeches.php", "memberchart.php", "my_evaluations.php", "evaluations.php",
	],
	/** Exact path segments that are the site's own. */
	pathWords: ["mobile", "api", "v1", "tmtools", "reports", "images", "index.html", "my-evaluations", "eval", "join", "fixture"],
	/** Query parameters whose value is a person's id (mapped to a fake id). */
	personParams: ["u", "uid", "user", "userid", "user_id", "speaker", "member", "memberid", "member_id", "person", "personid", "pid"],
	/** Query parameters whose value is a club id (mapped to a fake id). */
	clubParams: ["c", "club", "clubid", "club_id", "requestedclub", "cached_club"],
	/** Query parameters whose value is a count or an id: one or two digits stay, a longer number is mapped to a fake id. */
	numberParams: ["t", "s", "k", "page", "ret", "pr", "z", "r", "chart", "h", "d", "start_year", "end_year", "year", "month"],
	/** Query parameters that may only carry one of these literal values. */
	paramValues: {
		mode: ["entertitle", "editprofile", "miniprofile", "viewprofile", "article", "post", "email"],
		action: ["watch", "confirmattendance", "acceptrole", "delete"],
		show: ["next"],
		go: ["Awards"],
		mon: ["cur"],
		sort: ["asc", "desc"],
		order: ["asc", "desc"],
	} as Record<string, string[]>,
	/** Query parameters with a rule of their own: `id` (person or club), `p`/`m` (coordinates), `n` (a venue name, scrubbed). */
	otherParams: ["id", "p", "m", "n"],
	/** The only URL fragments that stay. */
	fragments: ["top"],
	/** Words in a handler (`onclick`, `javascript:`) that are code, not data. */
	codeWords: [
		"window", "open", "javascript", "void", "showStatus", "hideSpeeches", "tabTitle", "tabWorkbook", "tabDate", "return", "false", "true",
		"this", "document", "location", "href", "confirm", "submit", "function", "if", "else", "var", "let", "const", "null", "undefined",
		"history", "back", "forward", "close", "focus", "blur", "form", "value", "checked", "getElementById", "style", "display", "none",
		"block", "event", "preventDefault", "stopPropagation", "parent", "self", "top", "alert",
	],
	/** String literals in a handler that stay (a window target) and the shape of a window-features string. */
	codeStrings: ["_blank", "_self", "_parent", "_top"],
	windowFeatures: "^[a-z]+=(?:yes|no|\\d{1,4})(?:,[a-z]+=(?:yes|no|\\d{1,4}))*$",
	/** HTML tags; an unknown (custom) tag name is replaced with `span`. */
	tags: [
		"html", "head", "body", "title", "meta", "link", "script", "style", "base", "a", "abbr", "acronym", "address", "area", "article", "aside",
		"b", "big", "blockquote", "br", "button", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt",
		"em", "fieldset", "figcaption", "figure", "font", "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "header",
		"hr", "i", "iframe", "img", "input", "ins", "kbd", "label", "legend", "li", "main", "map", "mark", "nav", "nobr", "noscript", "object",
		"ol", "optgroup", "option", "p", "param", "pre", "q", "s", "samp", "section", "select", "small", "span", "strike", "strong", "sub",
		"sup", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
	],
	/** Attribute names that stay, beyond the ones with a value rule below and any `on<event>` handler. An unknown name is renamed `data-x<n>`. */
	attributeNames: [
		"class", "id", "name", "for", "value", "href", "src", "action", "formaction", "poster", "background", "cite", "data", "longdesc",
		"codebase", "usemap", "title", "alt", "content", "placeholder", "label", "summary", "rel", "http-equiv", "style", "srcdoc", "aria-label",
	],
	/** Attribute values that stay, per attribute (regex sources, case-insensitive); anything else becomes an empty value. */
	attributeEnums: {
		charset: "^utf-8$",
		method: "^(?:get|post)$",
		type: "^(?:hidden|button|radio|submit|checkbox|text|password|textarea|select|reset)$",
		align: "^(?:left|right|center|justify)$",
		valign: "^(?:top|middle|bottom|baseline)$",
		colspan: "^\\d{1,3}$",
		rowspan: "^\\d{1,3}$",
		size: "^\\d{1,3}$",
		rows: "^\\d{1,3}$",
		cols: "^\\d{1,3}$",
		maxlength: "^\\d{1,4}$",
		border: "^\\d{1,2}$",
		cellpadding: "^\\d{1,3}$",
		cellspacing: "^\\d{1,3}$",
		width: "^\\d{1,4}%?$",
		height: "^\\d{1,4}%?$",
		wrap: "^(?:virtual|physical|off|soft|hard)$",
		color: COLOR,
		bgcolor: COLOR,
		text: COLOR,
		link: COLOR,
		vlink: COLOR,
		alink: COLOR,
		target: "^_[a-z]+$",
		scope: "^(?:col|row|colgroup|rowgroup)$",
		lang: "^[a-z]{2,3}(?:-[a-z]{2,4})?$",
		dir: "^(?:ltr|rtl)$",
		language: "^javascript$",
		xmlns: "^http://www\\.w3\\.org/1999/xhtml$",
		disabled: "^(?:|disabled)$",
		checked: "^(?:|checked)$",
		selected: "^(?:|selected)$",
		readonly: "^(?:|readonly)$",
		nowrap: "^(?:|nowrap)$",
		multiple: "^(?:|multiple)$",
		hidden: "^(?:|hidden)$",
	} as Record<string, string>,
	/** `rel` tokens, `http-equiv` values and `<meta content>` strings that stay (exact, case-insensitive). */
	relValues: ["stylesheet", "icon", "shortcut", "alternate", "canonical", "nofollow", "noopener", "noreferrer", "next", "prev"],
	httpEquivValues: ["content-type", "x-ua-compatible", "content-language"],
	metaContents: ["text/html; charset=utf-8", "text/html; charset=iso-8859-1", "ie=edge", "width=device-width, initial-scale=1"],
	/** The doctype identifiers that stay; any other is emptied. */
	doctypePublicIds: [
		"-//W3C//DTD HTML 4.01 Transitional//EN", "-//W3C//DTD HTML 4.01//EN", "-//W3C//DTD XHTML 1.0 Transitional//EN", "-//W3C//DTD XHTML 1.0 Strict//EN",
	],
	doctypeSystemIds: [
		"http://www.w3.org/TR/html4/loose.dtd", "http://www.w3.org/TR/html4/strict.dtd",
		"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd", "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd",
	],
	/** The bracketed words the site itself prints; any other `[word]` is a username. */
	bracketWords: ["[Show]", "[Hide]", "[M]", "[P]", "[O]", "[N]"],
};

const A = ALLOW_LIST;
const FAKE_USERNAME = (JSON.parse(readFixture("fake-names.json")) as { usernames: string[] }).usernames[0];

const lowerSet = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
const CLASS_SET = new Set(A.classes);
const ID_WORD_SET = new Set(A.idWords);
const HOSTS = new Set(A.hosts);
const PAGE_NAMES = new Set(A.pageNames);
const PATH_WORDS = new Set(A.pathWords);
const PERSON_PARAMS = lowerSet(A.personParams);
const CLUB_PARAMS = lowerSet(A.clubParams);
const NUMBER_PARAMS = lowerSet(A.numberParams);
const KNOWN_PARAMS = new Set([...PERSON_PARAMS, ...CLUB_PARAMS, ...NUMBER_PARAMS, ...Object.keys(A.paramValues), ...A.otherParams]);
const CODE_WORDS = new Set(A.codeWords);
const COUNT_LABELS = new Set(A.countLabels);
const VALUE_LABELS = new Set(A.valueLabels);
const TAGS = new Set(A.tags);
const REL_VALUES = lowerSet(A.relValues);
const HTTP_EQUIV = lowerSet(A.httpEquivValues);
const META_CONTENTS = lowerSet(A.metaContents);
const ENUMS = new Map(Object.entries(A.attributeEnums).map(([k, v]) => [k, new RegExp(v, "i")]));
const ATTRIBUTE_NAMES = new Set([...A.attributeNames, ...ENUMS.keys()]);
const WINDOW_FEATURES = new RegExp(A.windowFeatures);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "background", "cite", "data", "longdesc", "codebase", "usemap"]);

// ------------------------------------------------------------------ the text scrubber

const SPACE_WORDS = (p: string) => esc(p).replace(/ /g, SP);
const PHRASES = [...A.phrases].sort((a, b) => b.length - a.length);
// A separator inside a number that is a phone: space, dot, slash, hyphen, the Unicode dashes and the non-breaking hyphen.
const PHONE_SEP = String.raw`\s(). ‐-―−\-/`;
const PHONE_SOURCE = String.raw`(?<![${L}])(?:\+|00)?\(?\d[\d${PHONE_SEP}]{5,}\d(?![${L}])`;
const DATE_ONLY = /^(?:(?:19|20)\d{2}[\s‐-―−-]+\d{1,2}[\s‐-―−-]+\d{1,2}|(?:19|20)\d{2}[\s‐-―−-]+(?:19|20)\d{2})$/;
/** Characters outside any real page: they bracket a fake phone while the text is scrubbed, so it is not scrubbed twice. */
const OPEN = "";
const CLOSE = "";

const SCAN = new RegExp(
	[
		`(?<tok>${OPEN}[^${CLOSE}]*${CLOSE})`,
		`(?<keep>(?<![${L}_])(?:${PHRASES.map(SPACE_WORDS).join("|")}|${SHAPES.join("|")})(?![${L}]))`,
		String.raw`(?<user>\[[^\[\]\s]{1,60}\])`,
		`(?<phone>${PHONE_SOURCE})`,
		`(?<big>(?<![${L}])\\d{4,}(?![${L}]))`,
		`(?<small>(?<![${L}_])\\d{1,3}(?![${L}]))`,
	].join("|"),
	"gu",
);
const UPPER = /^\p{Lu}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const ADJACENT = /^[\s ,.'’_-]*$/;
const NAME_SHAPE = /^\p{Lu}[\p{L}\p{M}'’-]*(?:[\s ]+\p{Lu}[\p{L}\p{M}'’.-]*)+$/u;
const BRACKET_WORDS = new Set(A.bracketWords);

/** Everything one run remembers, so one real value always becomes the same fake. */
export interface RewriteState {
	names: Map<string, string>;
	words: Map<string, string>;
	phones: Map<string, string>;
	people: Map<string, string>;
	numbers: Map<string, string>;
	nextName: number;
	nextPerson: number;
	nextNumber: number;
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
		nextName: 0,
		nextPerson: 900_001,
		nextNumber: 4242,
		nextPhone: 1,
		nextWord: 1,
	};
}

const keyOf = (s: string) => s.replace(/[\s +]+/g, " ").trim().toLowerCase();

function fakeName(st: RewriteState, core: string): string {
	const k = keyOf(core);
	const have = st.names.get(k);
	if (have) return have;
	const next = FAKE_NAMES[st.nextName++];
	if (!next) throw new Error("the page has more distinct names than fake-names.json holds; add INVENTED names there, never real ones");
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

/** A person id: ANY id (a 900xxx one too) becomes the next id in 900001-900999, the same one every time. */
function fakePerson(st: RewriteState, id: string): string {
	if (!/^\d+$/.test(id)) return "x";
	const key = String(Number(id));
	const have = st.people.get(key);
	if (have) return have;
	const f = String(st.nextPerson++);
	st.people.set(key, f);
	return f;
}

/** A club id, a meeting id or any other long number: the same number, however it is zero-padded, gets one fake. */
function fakeNumber(st: RewriteState, id: string): string {
	if (!/^\d+$/.test(id)) return "x";
	const key = String(Number(id));
	let f = st.numbers.get(key);
	if (!f) {
		f = String(st.nextNumber++);
		st.numbers.set(key, f);
	}
	// a zero-padded input (00031415) keeps its width; an unpadded one never gains zeros
	return /^0/.test(id) ? f.padStart(id.length, "0") : f;
}

/** A run of digits that is not a date or a count: a phone if it looks like one, else an id. */
function replaceDigits(st: RewriteState, text: string, isBare: boolean): string {
	const digits = text.replace(/\D/g, "");
	if (DATE_ONLY.test(text.trim())) return text;
	if (digits.length < 7 || digits.length > 15) return isBare ? fakeNumber(st, digits) : fakePhone(st, digits);
	if (isBare && !/^0/.test(digits) && digits.length < 9) return fakeNumber(st, digits);
	return fakePhone(st, digits.replace(/^1(\d{10})$/, "$1"));
}

const isCapitalEdge = (word: string | undefined) => !!word && UPPER.test(word);
const lastWord = (s: string) => s.trim().split(/[\s '’-]+/).pop();
const firstWord = (s: string) => s.trim().split(/[\s '’-]+/)[0];

interface Hit {
	start: number;
	end: number;
	kind: "keep" | "repl" | "small";
	out: string;
}

interface Seg {
	start: number;
	end: number;
	replaced: boolean;
	out?: string;
	small?: boolean;
}

/** What `scrubDetailed` knows about an edge of the text, so a neighbouring text node can be judged against it. */
interface Edge {
	/** The text at this edge was an allowed phrase and was kept. */
	kept: boolean;
	/** The text at this edge was an unknown word run and was replaced. */
	replacedWord: boolean;
	/** The kept phrase at this edge starts (or ends) with a capital letter. */
	capital: boolean;
	/** The kept phrase is one word. Only a one-word phrase ("Timer") can be somebody's surname; a label ("Meeting Theme") cannot. */
	single: boolean;
}

interface Scrubbed {
	out: string;
	first: Edge | null;
	last: Edge | null;
}

function scanHits(st: RewriteState, text: string): Hit[] {
	const hits: Hit[] = [];
	for (const m of text.matchAll(SCAN)) {
		const g = m.groups ?? {};
		const start = m.index ?? 0;
		const raw = m[0];
		const end = start + raw.length;
		if (g.tok !== undefined || g.keep !== undefined) hits.push({ start, end, kind: "keep", out: raw });
		else if (g.user !== undefined) hits.push({ start, end, kind: "repl", out: BRACKET_WORDS.has(raw) ? raw : `[${FAKE_USERNAME}]` });
		else if (g.phone !== undefined) hits.push({ start, end, kind: "repl", out: replaceDigits(st, raw, /^\d+$/.test(raw)) });
		else if (g.big !== undefined) hits.push({ start, end, kind: "repl", out: replaceDigits(st, raw, true) });
		else hits.push({ start, end, kind: "small", out: raw });
	}
	return hits;
}

/**
 * Text with everything not on the allow-list replaced. Whitespace and punctuation between words are
 * kept. A one-word allowed phrase next to a replaced word run is replaced WITH it (`Timer, Dana`,
 * `dana Timer`: "Timer" is allowed, but a surname that is also a role must not survive on its own).
 * A one- to three-digit number stays only as a whole text node or next to a count label. `forceFirst`
 * / `forceLast` replace a kept phrase at that edge too (`Marlowe <b>Timer</b>` is two text nodes).
 */
function scrubDetailed(st: RewriteState, text: string, force: { first?: boolean; last?: boolean } = {}): Scrubbed {
	const hits = scanHits(st, text);
	const segs: Seg[] = [];
	let at = 0;
	const gap = (from: number, to: number) => {
		// a run of words is one piece of text; "&", "|" and "/" end it ("Tom & Jerry" is two pieces and keeps its "&")
		let start = from;
		for (const cut of [...text.slice(from, to).matchAll(/[&|/\\]+/g), null]) {
			const end = cut ? from + (cut.index ?? 0) : to;
			const s = text.slice(start, end);
			const first = s.search(LETTER_OR_DIGIT);
			if (first >= 0) {
				let last = s.length - 1;
				while (!LETTER_OR_DIGIT.test(s[last])) last -= 1;
				segs.push({ start: start + first, end: start + last + 1, replaced: true });
			}
			if (cut) start = end + cut[0].length;
		}
	};
	for (const h of hits) {
		gap(at, h.start);
		segs.push({ start: h.start, end: h.end, replaced: h.kind === "repl", out: h.kind === "repl" ? h.out : undefined, small: h.kind === "small" });
		at = h.end;
	}
	gap(at, text.length);
	segs.sort((x, y) => x.start - y.start);
	const label = (j: number, from: number, to: number) => {
		const s = segs[j];
		return !!s && !s.replaced && !s.small && COUNT_LABELS.has(text.slice(s.start, s.end)) && /^\s*$/.test(text.slice(from, to));
	};
	// a level ("#2-1 - Name", or "2 - Name" at the start of the text) is a one- or two-digit number in a fixed shape; it names no one
	const levelAt: [number, number][] = [...text.matchAll(/(?<![\p{L}\d])#\d{1,2}-\d{1,2}(?!\d)/gu)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
	const lead = /^\s*\d{1,2}(?=\s+-\s)/.exec(text);
	if (lead) levelAt.push([0, lead[0].length]);
	segs.forEach((s, i) => {
		if (!s.small) return;
		const whole = text.trim() === text.slice(s.start, s.end);
		const inLevel = levelAt.some(([from, to]) => s.start >= from && s.end <= to);
		const keep = whole || inLevel || label(i - 1, segs[i - 1]?.end ?? 0, s.start) || label(i + 1, s.end, segs[i + 1]?.start ?? 0);
		if (!keep) {
			s.replaced = true;
			s.out = "0";
		}
	});
	const kept = (s: Seg) => !s.replaced;
	const slice = (s: Seg) => text.slice(s.start, s.end);
	const oneWord = (s: Seg) => !/[\s ]/.test(slice(s).trim());
	const isGap = (s: Seg) => s.replaced && s.out === undefined;
	// A kept one-word phrase that starts with a capital ("Timer", "Mentor") is a plausible surname: next to a word run it joins it.
	const swallowable = (s: Seg | undefined): s is Seg => !!s && kept(s) && oneWord(s) && isCapitalEdge(firstWord(slice(s))) && /^\p{L}/u.test(slice(s));
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < segs.length; i++) {
			if (!isGap(segs[i])) continue;
			const prev = segs[i - 1];
			const next = segs[i + 1];
			if (swallowable(prev) && ADJACENT.test(text.slice(prev.end, segs[i].start))) {
				segs[i] = { start: prev.start, end: segs[i].end, replaced: true };
				segs.splice(i - 1, 1);
				changed = true;
				break;
			}
			if (swallowable(next) && ADJACENT.test(text.slice(segs[i].end, next.start))) {
				segs[i] = { start: segs[i].start, end: next.end, replaced: true };
				segs.splice(i + 1, 1);
				changed = true;
				break;
			}
		}
	}
	const wordish = (s: Seg) => !/\d/.test(slice(s)) && /\p{L}/u.test(slice(s));
	if (force.first && segs.length > 0 && kept(segs[0]) && wordish(segs[0])) segs[0] = { ...segs[0], replaced: true };
	const lastSeg = segs.length - 1;
	if (force.last && segs.length > 0 && kept(segs[lastSeg]) && wordish(segs[lastSeg])) segs[lastSeg] = { ...segs[lastSeg], replaced: true };
	const edge = (s: Seg | undefined, atEnd: boolean): Edge | null => {
		if (!s) return null;
		const core = slice(s);
		return {
			kept: kept(s),
			replacedWord: isGap(s),
			capital: isCapitalEdge(atEnd ? lastWord(core) : firstWord(core)),
			single: !/[\s ]/.test(core.trim()),
		};
	};
	let out = "";
	let pos = 0;
	for (const s of segs) {
		out += text.slice(pos, s.start);
		out += s.replaced ? (s.out ?? fakeText(st, slice(s))) : slice(s);
		pos = s.end;
	}
	return { out: out + text.slice(pos), first: edge(segs[0], false), last: edge(segs[lastSeg], true) };
}

const scrubText = (st: RewriteState, text: string): string => scrubDetailed(st, text).out;

// ------------------------------------------------------------------ URLs, code and attributes

function decodeLoose(s: string): string {
	try {
		return decodeURIComponent(s.replace(/\+/g, " "));
	} catch {
		return s;
	}
}

/** One or two digits stay (a flag, a page, a month); a longer number is an id and is mapped. */
function rewriteNumber(st: RewriteState, key: string, value: string): string {
	if (!/^-?\d+$/.test(value)) return "x";
	if (/year/.test(key) && /^(?:19|20)\d{2}$/.test(value)) return value;
	if (/^-?\d{1,2}$/.test(value)) return value;
	return fakeNumber(st, value.replace(/^-/, ""));
}

function rewriteParam(st: RewriteState, key: string, value: string, path: string): string {
	const k = key.toLowerCase();
	if (PERSON_PARAMS.has(k) || (k === "id" && !/ClubReport/i.test(path))) return fakePerson(st, value);
	if (CLUB_PARAMS.has(k) || k === "id") return fakeNumber(st, value);
	if (k === "p" || k === "m") return /^\(-?[\d.]+,-?[\d.]+\)(?:,\d{1,2})?$/.test(value) ? value.replace(/-?\d+\.\d+/g, "0.000000") : "x";
	if (k === "n") return encodeURIComponent(scrubText(st, decodeLoose(value)));
	if (NUMBER_PARAMS.has(k)) return rewriteNumber(st, k, value);
	return Object.hasOwn(A.paramValues, k) && A.paramValues[k].includes(value) ? value : "x";
}

function rewritePathSegment(st: RewriteState, seg: string): string {
	if (seg === "" || PAGE_NAMES.has(seg) || PATH_WORDS.has(seg)) return seg;
	if (/^\d+$/.test(seg)) return seg.length <= 2 ? seg : fakeNumber(st, seg);
	const ext = /\.(?:gif|png|jpe?g|svg|css|js|ico|json)$/i.exec(seg);
	return ext ? `x${ext[0].toLowerCase()}` : "x";
}

/** A URL with its host, path and every query value checked; the shape stays, every id and name in it is replaced. */
function rewriteUrl(st: RewriteState, value: string): string {
	const raw = value.trim();
	if (raw === "") return value;
	if (/^javascript:/i.test(raw)) return `javascript:${rewriteCode(st, raw.replace(/^javascript:/i, ""))}`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return "#";
	const m = /^(?:(https?:))?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw);
	if (!m) return "#";
	const [, scheme, host, path = "", query, frag] = m;
	let out = "";
	if (host !== undefined) out += `${scheme ?? ""}//${HOSTS.has(host.toLowerCase()) ? host : "example.test"}`;
	out += path
		.split("/")
		.map((seg) => rewritePathSegment(st, seg))
		.join("/");
	if (query !== undefined) {
		const pairs = query
			.split("&")
			.filter((kv) => kv !== "")
			.map((kv) => {
				const eq = kv.indexOf("=");
				const k = decodeLoose(eq < 0 ? kv : kv.slice(0, eq));
				const v = eq < 0 ? null : decodeLoose(kv.slice(eq + 1));
				if (!KNOWN_PARAMS.has(k.toLowerCase())) return v === null ? "x" : "x=x";
				return v === null ? k : `${k}=${rewriteParam(st, k, v, path)}`;
			});
		out += `?${pairs.join("&")}`;
	}
	if (frag !== undefined) out += A.fragments.includes(frag) ? `#${frag}` : "#";
	return out;
}

const JS_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

/** `\162`, `\x72`, `r` and `\u{72}` read as the letters they spell, so an escaped email is seen as an email. */
function decodeJsEscapes(s: string): string {
	return s.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([\s\S]))/g, (_m, ub?: string, u4?: string, x2?: string, oct?: string, ch?: string) => {
		const hex = ub ?? u4 ?? x2;
		if (hex !== undefined) {
			const cp = Number.parseInt(hex, 16);
			return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
		}
		if (oct !== undefined) return String.fromCharCode(Number.parseInt(oct, 8));
		return JS_ESCAPES[ch ?? ""] ?? ch ?? "";
	});
}

/**
 * An event handler or a `javascript:` URL. String literals are decoded (escapes included) and then
 * go through `rewriteUrl` (a URL) or `scrubText`; a bare word must be a known code word; every
 * number outside a string is a replaced id, or `0`.
 */
function rewriteCode(st: RewriteState, code: string): string {
	const bare = (s: string) =>
		s
			.replace(/\\/g, "")
			.replace(/[\p{L}_$][\p{L}\p{N}_$]*/gu, (w) => (CODE_WORDS.has(w) ? w : "x"))
			.replace(/\d+/g, (d) => (d.length === 1 ? d : d.length >= 4 ? fakePerson(st, d) : "0"));
	let out = "";
	let pos = 0;
	for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\]|\\[\s\S])*)\1/g)) {
		const idx = m.index ?? 0;
		out += bare(code.slice(pos, idx));
		const body = decodeJsEscapes(m[2]);
		let inner: string;
		if (A.codeStrings.includes(body) || WINDOW_FEATURES.test(body)) inner = body;
		else if (/\.(?:php|html|aspx|cfm|cgi)(?:[?#]|$)|^https?:\/\//i.test(body)) inner = rewriteUrl(st, body);
		else inner = scrubText(st, body);
		out += `${m[1]}${inner.replace(/[\\'"`]/g, "")}${m[1]}`;
		pos = idx + m[0].length;
	}
	return out + bare(code.slice(pos));
}

const FORM_PERSON = /user|member|person|speaker|uid|^rec\[/i;
const PERSON_IN_ATTR = /((?<![A-Za-z])(?<!(?<!%[0-9a-f])[0-9])(?:u|[a-z_]*(?:user|member|person|uid)[a-z_]*)(?:=|%3[dD])|attend_image1?\[|available\[|rec\[|available_)(\d+)/gi;

/** An `id`, `name` or `for`: the lowercase markup words stay, a person id inside is replaced, anything else goes through `scrubText`. */
function rewriteIdent(st: RewriteState, v: string): string {
	const withIds = v.replace(PERSON_IN_ATTR, (_m, pre: string, id: string) => `${pre}${fakePerson(st, id)}`);
	const parts = withIds.split(/([_\-[\]\s]+)/);
	let i = 0;
	let head = "";
	for (; i < parts.length; i++) {
		const p = parts[i];
		const isFakePerson = /^\d+$/.test(p) && [...st.people.values()].includes(p);
		if (i % 2 === 1 || p === "" || ID_WORD_SET.has(p.toLowerCase()) || /^\d{1,2}$/.test(p) || isFakePerson) head += p;
		else break;
	}
	return head + scrubText(st, parts.slice(i).join(""));
}

/** A form field's value: a person id maps like the same id in a link, a club or other long number maps, one or two digits stay. */
function rewriteFormValue(st: RewriteState, field: string, value: string): string {
	if (/^\d+$/.test(value)) {
		if (/year/i.test(field) && /^(?:19|20)\d{2}$/.test(value)) return value;
		if (/club/i.test(field)) return fakeNumber(st, value);
		if (FORM_PERSON.test(field)) return fakePerson(st, value);
		return value.length <= 2 ? value : fakeNumber(st, value);
	}
	return scrubText(st, value);
}

interface AttrContext {
	/** The field the value belongs to: the element's own ORIGINAL `name`, or an `<option>`'s select. */
	field: string;
}

function rewriteAttribute(st: RewriteState, ctx: AttrContext, name: string, rawValue: string): string {
	const value = rawValue.replace(/[]/g, "");
	const n = name.toLowerCase();
	const pattern = ENUMS.get(n);
	if (pattern) return pattern.test(value.trim()) ? value : "";
	if (n === "class") return value.split(/\s+/).filter(Boolean).map((c) => (CLASS_SET.has(c) ? c : "x")).join(" ");
	if (URL_ATTRS.has(n)) return rewriteUrl(st, value);
	if (/^on[a-z]+$/.test(n) || /^\s*javascript:/i.test(value)) return rewriteCode(st, value.replace(/^\s*javascript:/i, ""));
	if (n === "id" || n === "name" || n === "for") return rewriteIdent(st, value);
	if (n === "value") return rewriteFormValue(st, ctx.field, value);
	if (n === "style") return "";
	if (n === "srcdoc") return rewriteDocument(st, value);
	if (n === "rel") return value.split(/\s+/).filter((t) => REL_VALUES.has(t.toLowerCase())).join(" ");
	if (n === "http-equiv") return HTTP_EQUIV.has(value.trim().toLowerCase()) ? value : "";
	if (n === "content" && META_CONTENTS.has(value.trim().toLowerCase())) return value;
	return scrubText(st, value);
}

// ------------------------------------------------------------------ the page

const CREDENTIALS = /,\s*[A-Z]{2,4}(?:\s+[A-Z]{2,4})*$/;
const PERSON_LINK = /(?:[?&;]|^|\s)u=\d+/;

export interface RewriteOptions {
	/** Shared between pages of one run, so a person keeps one fake across them. */
	state?: RewriteState;
}

/** Block elements: text in two of these is never one name. Text under the nearest one is a group. */
const CONTAINERS = new Set(["td", "th", "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "body", "blockquote", "pre", "dd", "dt", "caption", "option", "title", "textarea", "label"]);
const RAW_TEXT = new Set(["textarea", "title"]);
const PHONE_RE = new RegExp(PHONE_SOURCE, "gu");

interface TextRef {
	node: Node;
	container: Element | null;
}

/** A phone is split across text nodes when inline tags or block elements cut it up; `\u0001` marks a table cell, which never joins its neighbour. */
function plausibleBlockPhone(match: string): boolean {
	const groups = match.split(/\D+/).filter(Boolean);
	const digits = groups.join("").length;
	return digits >= 9 && digits <= 15 && groups.length <= 5 && groups.filter((g) => g.length >= 3).length >= 2;
}

function phonesAcrossNodes(st: RewriteState, refs: TextRef[]) {
	const cell = (c: Element | null) => !!c && /^(?:td|th)$/i.test(c.tagName);
	let whole = "";
	const owner: number[] = [];
	refs.forEach((r, i) => {
		if (i > 0 && r.container !== refs[i - 1].container) {
			whole += cell(r.container) || cell(refs[i - 1].container) ? "\u0001" : "\n";
			owner.push(-1);
		}
		const t = r.node.nodeValue ?? "";
		whole += t;
		for (let k = 0; k < t.length; k++) owner.push(i);
	});
	const spans: { s: number; e: number; fake: string }[] = [];
	for (const m of whole.matchAll(PHONE_RE)) {
		const s = m.index ?? 0;
		const e = s + m[0].length;
		if (owner[s] === owner[e - 1]) continue;
		const add = (from: number, to: number) => {
			const digits = whole.slice(from, to).replace(/\D/g, "");
			spans.push({ s: from, e: to, fake: `${OPEN}${fakePhone(st, digits.replace(/^1(\d{10})$/, "$1"))}${CLOSE}` });
		};
		if (!m[0].includes("\n")) {
			const digits = m[0].replace(/\D/g, "");
			if (digits.length >= 7 && digits.length <= 15 && !DATE_ONLY.test(m[0])) add(s, e);
			continue;
		}
		// Several blocks of digits run together; a phone is the longest plausible run of whole blocks.
		const pieces = [...m[0].matchAll(/[^\n]+/g)].map((p) => ({ s: s + (p.index ?? 0), e: s + (p.index ?? 0) + p[0].length }));
		for (let i = 0; i < pieces.length - 1; ) {
			let taken = false;
			for (let j = Math.min(pieces.length - 1, i + 3); j > i && !taken; j--) {
				if (plausibleBlockPhone(whole.slice(pieces[i].s, pieces[j].e))) {
					add(pieces[i].s, pieces[j].e);
					i = j + 1;
					taken = true;
				}
			}
			if (!taken) i += 1;
		}
	}
	if (spans.length === 0) return;
	const out = refs.map(() => "");
	let si = 0;
	for (let at = 0; at < whole.length; at++) {
		const sp = spans[si];
		if (sp && at === sp.s) {
			out[owner[sp.s]] += sp.fake;
			at = sp.e - 1;
			si += 1;
		} else if (owner[at] >= 0) out[owner[at]] += whole[at];
	}
	refs.forEach((r, i) => {
		r.node.nodeValue = out[i];
	});
}

/** `&amp;` and friends undone, for the one element (textarea) whose text this parser keeps raw. */
const decodeEntities = (raw: string): string => parseHtml(`<div title="${raw.replace(/"/g, "&quot;")}"></div>`).querySelector("div")?.getAttribute("title") ?? raw;
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type ItemKind = "scrub" | "name" | "exact" | "fixed";

interface TextItem {
	node: Node;
	text: string;
	lead: string;
	trail: string;
	kind: ItemKind;
	/** The finished text of a `name`, `exact` or `fixed` item. */
	fixed: string | null;
	res: Scrubbed | null;
	forceFirst: boolean;
	forceLast: boolean;
}

const tagOf = (el: Element | null | undefined) => el?.tagName.toLowerCase() ?? "";

/** The parser hands back "Ren&eacute; Dup" as three text nodes; they are one piece of text. */
function mergeAdjacentText(doc: Document) {
	for (const el of [doc as unknown as Element, ...Array.from(doc.querySelectorAll("*"))]) {
		const kids = Array.from(el.childNodes ?? []);
		for (let i = kids.length - 1; i > 0; i--) {
			if (kids[i].nodeType === 3 && kids[i - 1].nodeType === 3) {
				kids[i - 1].nodeValue = `${kids[i - 1].nodeValue ?? ""}${kids[i].nodeValue ?? ""}`;
				el.removeChild(kids[i]);
			}
		}
	}
}

/** The doctype's identifiers can name anyone: only the W3C ones stay. */
function scrubDoctype(doc: Document) {
	for (const n of Array.from(doc.childNodes)) {
		if (n.nodeType !== 10) continue;
		const dt = n as unknown as { name: string; publicId: string; systemId: string };
		if ((dt.publicId && !A.doctypePublicIds.includes(dt.publicId)) || (dt.systemId && !A.doctypeSystemIds.includes(dt.systemId))) {
			dt.publicId = "";
			dt.systemId = "";
		}
		dt.name = "html";
	}
}

/** A custom tag name can carry data (`<rowan-tidewell>`): anything not in `ALLOW_LIST.tags` becomes a `span`. */
function normalizeTags(doc: Document) {
	for (const el of Array.from(doc.querySelectorAll("*"))) {
		if (TAGS.has(tagOf(el))) continue;
		const span = doc.createElement("span");
		for (const a of Array.from(el.attributes ?? [])) span.setAttribute(a.name, a.value);
		while (el.firstChild) span.appendChild(el.firstChild);
		el.replaceWith(span);
	}
}

/** Visit every node of the document (doctype and comments before <html> included): empty what must go and list the text. */
function collectText(doc: Document): { refs: TextRef[]; groups: Map<Element | null, Node[]> } {
	const refs: TextRef[] = [];
	const groups = new Map<Element | null, Node[]>();
	const walk = (n: Node) => {
		const t = n.nodeType;
		if (t === 8) {
			const body = (n.nodeValue ?? "").trim();
			n.nodeValue = A.comments.includes(body) ? n.nodeValue : "";
			return;
		}
		if (t === 4 || t === 7) {
			n.nodeValue = "";
			return;
		}
		if (t === 3) {
			const parent = n.parentElement as Element | null;
			const tag = tagOf(parent);
			if (tag === "script" || tag === "style") {
				n.nodeValue = "";
				return;
			}
			const raw = (n.nodeValue ?? "").replace(/[]/g, "");
			n.nodeValue = tag === "textarea" ? decodeEntities(raw) : raw;
			let c: Element | null = parent;
			while (c && !CONTAINERS.has(tagOf(c))) c = c.parentElement;
			refs.push({ node: n, container: c });
			const list = groups.get(c) ?? [];
			list.push(n);
			groups.set(c, list);
			return;
		}
		for (const c of Array.from(n.childNodes ?? [])) walk(c);
	};
	for (const c of Array.from(doc.childNodes)) walk(c);
	return { refs, groups };
}

function textItems(st: RewriteState, groups: Map<Element | null, Node[]>): TextItem[][] {
	const sequences: TextItem[][] = [];
	let prevText = "";
	for (const nodes of groups.values()) {
		const seq: TextItem[] = [];
		for (const n of nodes) {
			const parent = n.parentElement as Element | null;
			const tag = tagOf(parent);
			const text = n.nodeValue ?? "";
			const t = text.replace(/[\s ]+/g, " ").trim();
			if (t === "") continue;
			const item: TextItem = { node: n, text: t, lead: text.match(/^[\s ]*/)?.[0] ?? "", trail: text.match(/[\s ]*$/)?.[0] ?? "", kind: "scrub", fixed: null, res: null, forceFirst: false, forceLast: false };
			const pager = parent && /^Page \d{1,3} of \d{1,3}$/.test((parent.closest(".nav")?.textContent ?? parent.textContent ?? "").replace(/[\s ]+/g, " ").trim());
			const link = parent?.closest("a") ?? null;
			const linkAttrs = link ? `${link.getAttribute("href") ?? ""} ${link.getAttribute("onclick") ?? ""}` : "";
			const decodedAttrs = decodeLoose(linkAttrs.replace(/&amp;/g, "&"));
			if (pager || (tag === "option" && A.optionOnly.includes(t))) {
				item.kind = "fixed";
				item.fixed = t;
			} else if (A.exactNodes.includes(t)) {
				item.kind = "exact";
				item.fixed = t;
			} else if (link && /profile\.php\?mode=editprofile/.test(linkAttrs) && !/^Welcome back/.test(t)) {
				item.kind = "fixed";
				item.fixed = FAKE_USERNAME;
			} else if (link && /profile\.php\?mode=editprofile/.test(linkAttrs)) {
				const who = t.replace(/^Welcome back\s*/, "").replace(CREDENTIALS, "");
				item.kind = "fixed";
				item.fixed = `Welcome back ${fakeName(st, who)}`;
			} else if (link && PERSON_LINK.test(decodedAttrs) && !/^(?:Request a Speech\.\.\.|Accept|TBA)$/.test(t)) {
				const cred = CREDENTIALS.exec(t)?.[0] ?? "";
				item.kind = "name";
				item.fixed = `${fakeName(st, t.replace(CREDENTIALS, ""))}${cred ? scrubText(st, cred) : ""}`;
			} else if (prevText === "Club Number" && /^\d+$/.test(t)) {
				item.kind = "fixed";
				item.fixed = fakeNumber(st, t);
			} else {
				item.res = scrubDetailed(st, t);
			}
			prevText = t;
			seq.push(item);
		}
		sequences.push(seq);
	}
	return sequences;
}

const NAME_EDGE: Edge = { kept: false, replacedWord: true, capital: true, single: false };
const firstEdge = (it: TextItem): Edge | null =>
	it.kind === "scrub" ? (it.res?.first ?? null) : it.kind === "name" ? NAME_EDGE : it.kind === "exact" ? { kept: true, replacedWord: false, capital: UPPER.test(it.text), single: true } : null;
const lastEdge = (it: TextItem): Edge | null =>
	it.kind === "scrub" ? (it.res?.last ?? null) : it.kind === "name" ? NAME_EDGE : it.kind === "exact" ? { kept: true, replacedWord: false, capital: UPPER.test(it.text), single: true } : null;

/** Replace the kept phrase at one edge of an item (it sits next to a replaced name in another text node). */
function forceEdge(st: RewriteState, it: TextItem, side: "first" | "last"): boolean {
	if (it.kind === "exact") {
		if (!/^\p{L}+$/u.test(it.text)) return false;
		it.kind = "name";
		it.fixed = fakeText(st, it.text);
		return true;
	}
	if (it.kind !== "scrub" || (side === "first" ? it.forceFirst : it.forceLast)) return false;
	if (side === "first") it.forceFirst = true;
	else it.forceLast = true;
	it.res = scrubDetailed(st, it.text, { first: it.forceFirst, last: it.forceLast });
	return true;
}

/** A name split across inline tags ("Marlowe <b>Timer</b>", "Eli <b>Page</b>"): an allowed word next to a replaced name is replaced too. */
function swallowAcrossNodes(st: RewriteState, sequences: TextItem[][]) {
	for (const seq of sequences) {
		for (let round = 0; round < 6; round++) {
			let changed = false;
			for (let k = 0; k + 1 < seq.length; k++) {
				const [a, b] = [seq[k], seq[k + 1]];
				if (lastEdge(a)?.replacedWord && firstEdge(b)?.kept && firstEdge(b)?.capital && firstEdge(b)?.single) changed = forceEdge(st, b, "first") || changed;
				// a field label ("Venue") followed by its value in another node stays; any other lone capitalised word before a replaced name is a plausible surname
				const label = a.kind === "scrub" && VALUE_LABELS.has(a.text.replace(/[\s\u00a0]+/g, " ").trim());
				if (!label && firstEdge(b)?.replacedWord && lastEdge(a)?.kept && lastEdge(a)?.capital && lastEdge(a)?.single) changed = forceEdge(st, a, "last") || changed;
			}
			if (!changed) break;
		}
	}
}

/** Every attribute, name and value, of every element. All originals are read BEFORE any is rewritten. */
function rewriteAttributes(st: RewriteState, doc: Document) {
	const els = Array.from(doc.querySelectorAll("*"));
	const snap = new Map<Element, { name: string; value: string }[]>(els.map((el) => [el, Array.from(el.attributes ?? []).map((a) => ({ name: a.name, value: a.value }))]));
	const nameOf = (el: Element | null | undefined) => snap.get(el as Element)?.find((a) => a.name.toLowerCase() === "name")?.value ?? "";
	for (const el of els) {
		const original = snap.get(el) ?? [];
		const field = tagOf(el) === "option" ? nameOf(el.closest("select")) : nameOf(el);
		let renamed = 0;
		for (const a of original) {
			const lower = a.name.toLowerCase();
			const known = ATTRIBUTE_NAMES.has(lower) || /^on[a-z]+$/.test(lower);
			const name = known ? a.name : `data-x${++renamed}`;
			// the parser writes an attribute value as it holds it, so a bare "&" would come out unescaped
			el.setAttribute(name, rewriteAttribute(st, { field }, name, a.value).replace(/[\uE000\uE001]/g, "").replace(/&/g, "&amp;"));
			if (name !== a.name) el.removeAttribute(a.name);
		}
	}
}

function rewriteDocument(st: RewriteState, html: string): string {
	const doc = parseHtml(html);
	scrubDoctype(doc);
	normalizeTags(doc);
	mergeAdjacentText(doc);
	const { refs, groups } = collectText(doc);
	phonesAcrossNodes(st, refs);
	// Text first: the person-link test reads the links' ORIGINAL attributes.
	const sequences = textItems(st, groups);
	swallowAcrossNodes(st, sequences);
	for (const seq of sequences) {
		for (const it of seq) {
			const text = `${it.lead}${it.fixed ?? it.res?.out ?? ""}${it.trail}`.replace(/[]/g, "");
			it.node.nodeValue = RAW_TEXT.has(tagOf(it.node.parentElement as Element | null)) ? escapeText(text) : text;
		}
	}
	for (const r of refs) {
		const t = r.node.nodeValue ?? "";
		if (t.includes(OPEN) || t.includes(CLOSE)) r.node.nodeValue = t.replace(/[]/g, "");
	}
	rewriteAttributes(st, doc);
	return doc.toString();
}

/** Saved page in, fixture page out. Pure: no file system. Throws only if fake-names.json runs out of names. */
export function rewriteEasySpeakPage(html: string, opts: RewriteOptions = {}): string {
	return rewriteDocument(opts.state ?? newRewriteState(), html);
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
