/**
 * Turns a saved Easy-Speak page into a committable fixture (#1272). **Deny by default. No digit survives.**
 *
 * The whole document is parsed (doctype, comments and head included). EVERY text node, comment and
 * attribute value is replaced with a fake unless it is on the allow-list (`ALLOW_LIST`, the only list
 * that decides what survives, and every list in it is a LITERAL one: an exact host, an exact page
 * name, an exact word). A regex shape that keeps free-form text (any word, any subdomain) is not an
 * allow-list. Tag names, attribute names and event-handler names are checked too: an unknown one is
 * renamed.
 *
 * **Digits (decision B, #1275).** Every digit run, in text, an attribute value, a URL or a handler,
 * is rewritten by one map: `fakeRun` is deterministic within one run (the same real run is the same
 * fake, so a meeting id in a link and in a table still line up), keeps the run's length, is one to
 * one, and never maps a run to itself or to any run the page itself carries. A date is shifted by a
 * whole number of weeks (so a weekday still matches), a time becomes another valid time. Person ids
 * become 900001-900999 (the second net's contract) and phones `(555) 010-xxxx`. Only a literal
 * allow-listed string keeps its digits (`ALLOW_LIST.phrases`, `layoutNumbers`, `pageNumbers`): there
 * is no shape rule that keeps a number because it is short or looks like a count, a level, a date
 * or a coordinate. The page's own structure that needs a shape (`#2-1 - Project`, `Page 1 of 3`) keeps
 * the shape and gets mapped digits: the walker needs consistency, not the real numbers.
 *
 * Nothing here looks for a name, a phone or an email to remove (an earlier regex rewriter did, and
 * real data kept getting past it); what is not known to be safe is replaced, so a shape nobody
 * thought of is replaced too. A value that merely LOOKS like a fake (a 900xxx id, a fake name) is
 * replaced like any other: nothing is trusted for resembling the fixtures.
 *
 * `fixtureViolations` (the test kit) then runs over the output as the second net. If it reports
 * anything the CLI writes nothing and exits non-zero. A pass is not clearance: a human still reads
 * every line of the output before it is committed (`__fixtures__/easy-speak/README.md`).
 *
 * The evaluations JSON is hand-written, not generated: this script refuses a JSON input (a clear
 * message, exit 2) rather than guess at a structure it does not rewrite.
 *
 *   bun scripts/easy-speak-fixture-from-archive.ts <page.html> <out.html> [--contact-page]
 *   bun scripts/easy-speak-fixture-from-archive.ts --archive <pages.json> --page <url> <out.html>
 *
 * Run it from `extension/`. The input is raw member data: never commit it, never paste it anywhere.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAKE_NAMES, type FixtureCheckOptions, fixtureViolations, parseHtml, readFixture } from "../lib/easy-speak-test-kit";

// ------------------------------------------------------------------ the allow-list

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SP = String.raw`[\s ]+`;
const L = String.raw`\p{L}\p{N}\p{M}`;

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
const YEAR = String.raw`(?:19|20)\d{2}`;
/** The zone abbreviations the site prints before `(GMT+n hrs)`. A literal list: any other three letters are a word, not a zone. */
const ZONE_ABBR = ["PST", "PDT", "MST", "MDT", "CST", "CDT", "EST", "EDT", "AKST", "AKDT", "HST", "UTC", "GMT", "BST", "CET", "CEST", "IST", "JST", "AEST", "AEDT", "NZST", "NZDT"];

interface DateShape {
	/** A regex source; its capture groups are what `render` reads. Month and weekday NAMES are only ever kept inside one of these. */
	src: string;
	/** The shape with its digits replaced: a date becomes a synthetic one, a time another time, any other number goes through `fakeRun`. `null`: it is date-shaped but not a date (`May 99, 2026`), so the WHOLE match is scrubbed. */
	render: (st: RewriteState, m: RegExpExecArray) => string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/**
 * Date, time and zone shapes. Each keeps its WORDS (a month, a weekday, a zone) and replaces its numbers:
 * none of them can hold a name (a count is digits, a zone is one of the literal abbreviations or zones above).
 */
const DATE_SHAPES: readonly DateShape[] = [
	{
		src: `(?:(${WEEKDAY})(${SP}))?(\\d{1,2})(?:st|nd|rd|th)(${SP})(${MONTH})(${SP})(${YEAR})(?:(${SP}at${SP})(${TIME})(?:(${SP})(${TZ}))?)?`,
		render: (st, m) => {
			const [raw, wd, sp1, day, sp2, month, sp3, year, at, time, sp4, tz] = m;
			const sh = shiftDate(st, Number(year), MONTHS.indexOf(month) + 1, Number(day));
			if (!sh) return null;
			return `${wd ? `${WEEKDAYS[(sh.dow + 6) % 7]}${sp1}` : ""}${ordinal(sh.d)}${sp2}${MONTHS[sh.m - 1]}${sp3}${sh.y}${at ? `${at}${fakeTime(st, time)}${tz ? `${sp4}${tz}` : ""}` : ""}`;
		},
	},
	{
		src: `Every(${SP})(${WEEKDAY})(${SP})at(${SP})(${TIME})`,
		render: (st, m) => `Every${m[1]}${m[2]}${m[3]}at${m[4]}${fakeTime(st, m[5])}`,
	},
	{
		src: `(${MONTH_SHORT})(${SP})(\\d{2})(${SP})(\\d{2}),(${SP})(${TIME})`,
		render: (st, m) => {
			const sh = shiftDate(st, 2000 + Number(m[5]), MONTH_ABBR.indexOf(m[1]) + 1, Number(m[3]));
			if (!sh) return null;
			return `${MONTH_ABBR[sh.m - 1]}${m[2]}${pad2(sh.d)}${m[4]}${pad2(sh.y % 100)},${m[6]}${fakeTime(st, m[7])}`;
		},
	},
	{
		src: `(${MONTH})(${SP})(\\d{1,2})(,?)(${SP})(${YEAR})`,
		render: (st, m) => {
			const sh = shiftDate(st, Number(m[6]), MONTHS.indexOf(m[1]) + 1, Number(m[3]));
			if (!sh) return null;
			return `${MONTHS[sh.m - 1]}${m[2]}${m[3].length === 2 ? pad2(sh.d) : sh.d}${m[4]}${m[5]}${sh.y}`;
		},
	},
	{
		src: `(${MONTH})(${SP})(${YEAR})`,
		render: (st, m) => {
			const sh = shiftDate(st, Number(m[3]), MONTHS.indexOf(m[1]) + 1, 15);
			return sh ? `${MONTHS[sh.m - 1]}${m[2]}${sh.y}` : null;
		},
	},
	{
		src: `(${YEAR})-(\\d{2})-(\\d{2})`,
		render: (st, m) => {
			const sh = shiftDate(st, Number(m[1]), Number(m[2]), Number(m[3]));
			return sh ? `${sh.y}-${pad2(sh.m)}-${pad2(sh.d)}` : null;
		},
	},
	{
		src: `(${YEAR})-(${YEAR})`,
		render: (st, m) => {
			const a = shiftDate(st, Number(m[1]), 6, 15);
			const b = shiftDate(st, Number(m[2]), 6, 15);
			return a && b ? `${a.y}-${b.y}` : null;
		},
	},
	{
		src: `(${ZONE_ABBR.join("|")})(${SP})\\(GMT([+\\-−])(\\d{1,2})(${SP})hrs\\)`,
		render: (st, m) => `${m[1]}${m[2]}(GMT${m[3]}${fakeRun(st, m[4])}${m[5]}hrs)`,
	},
	{ src: `(${TIME})`, render: (st, m) => fakeTime(st, m[1]) },
];
/** Shapes with no number in them: kept as they are. */
const KEEP_SHAPES: readonly string[] = [String.raw`Division${SP}[A-Z]`, TZ];
const DATE_RES = DATE_SHAPES.map((d) => new RegExp(`^${d.src}$`, "u"));

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
		"Toastmaster", "Joke Master", "Speaker", "Ah Master", "Grammarian", "Timer", "Timer 2 - Online", ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [`${ordinal(n)} Speaker`, `${ordinal(n)} Evaluator`]), "Vote Counter", "Listener",
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
	/** Month names are kept only inside an `<option>` of a month `<select>` (by its ORIGINAL name); elsewhere "May" is somebody's surname. */
	optionOnly: MONTHS,
	optionOnlySelects: ["month", "start_month", "end_month"],
	/** A one-word field label whose value is the next text node ("Venue" then a bold place). It is never half of a person's name. */
	valueLabels: ["Venue"],
	weekdays: WEEKDAYS,
	months: MONTHS,
	monthAbbreviations: MONTH_ABBR,
	/** The only timezone names (a literal zone, never `Region/Anything`). */
	timezones: TIMEZONES,
	/** Date, time and zone shapes (regex sources): their words stay, their numbers are replaced. None can hold a name. */
	shapes: [...KEEP_SHAPES, ...DATE_SHAPES.map((d) => d.src)],
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
	/** The names a `window.open` features string may carry (its values are `yes`, `no` or a mapped number). */
	windowFeatureNames: ["width", "height", "left", "top", "scrollbars", "resizable", "toolbar", "menubar", "location", "status", "directories", "titlebar"],
	/** Event-handler attribute names that stay. A LITERAL list: `on[a-z]+` would keep `onrowantidewell`. An unknown name is renamed `data-xN`. */
	handlerNames: [
		"onclick", "ondblclick", "onmouseover", "onmouseout", "onmouseenter", "onmouseleave", "onmousedown", "onmouseup", "onmousemove", "onfocus",
		"onblur", "onchange", "oninput", "onsubmit", "onreset", "onkeydown", "onkeyup", "onkeypress", "onload", "onunload", "onerror", "onselect",
		"onscroll",
	],
	/** Layout attributes whose value is a number. NO value stays: the walker reads none of them, so a number here is mapped like any other (a literal exception would be a place to hide digits). */
	layoutAttributes: ["colspan", "rowspan", "size", "rows", "cols", "maxlength", "border", "cellpadding", "cellspacing", "width", "height"],
	/** The only values of a radio button that stay, and only on `attendanceRadioField`: the walker reads the attendance plan from them (`RADIO_PLAN` in easy-speak-parse.ts: 1 and 6 attending, 2 not, 5 unknown). */
	radioValues: ["1", "2", "5", "6"],
	/** The ORIGINAL name of the attendance radios (`available[<person id>]`); a radio of any other field keeps nothing. */
	attendanceRadioField: String.raw`^available\[\d+\]$`,
	/** The pager ("Page 1 of 3") keeps its digits only inside the `.nav` element the walker reads, when the page is not past the count and both are one of these. */
	pageNumbers: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
	/** Attributes whose value is a colour: always emptied (a hex colour is a pattern, and a pattern is not a list). */
	colorAttributes: ["color", "bgcolor", "text", "link", "vlink", "alink"],
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
		wrap: "^(?:virtual|physical|off|soft|hard)$",
		target: "^_(?:blank|self|parent|top)$",
		scope: "^(?:col|row|colgroup|rowgroup)$",
		lang: "^(?:en|en-us|en-gb|en-au|en-ca|fr|es|de)$",
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
const HANDLERS = new Set(A.handlerNames);
const LAYOUT_ATTRS = new Set(A.layoutAttributes);
const PAGE_NUMBERS = new Set(A.pageNumbers);
const RADIO_VALUES = new Set(A.radioValues);
const ATTENDANCE_RADIO = new RegExp(A.attendanceRadioField);
const MONTH_SELECTS = new Set(A.optionOnlySelects);
const COLOR_ATTRS = new Set(A.colorAttributes);
const VALUE_LABELS = new Set(A.valueLabels);
const TAGS = new Set(A.tags);
const REL_VALUES = lowerSet(A.relValues);
const HTTP_EQUIV = lowerSet(A.httpEquivValues);
const META_CONTENTS = lowerSet(A.metaContents);
const ENUMS = new Map(Object.entries(A.attributeEnums).map(([k, v]) => [k, new RegExp(v, "i")]));
const ATTRIBUTE_NAMES = new Set([...A.attributeNames, ...ENUMS.keys(), ...A.layoutAttributes, ...A.colorAttributes]);
const WINDOW_FEATURE_NAMES = new Set(A.windowFeatureNames);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "background", "cite", "data", "longdesc", "codebase", "usemap"]);

// ------------------------------------------------------------------ the text scrubber

const SPACE_WORDS = (p: string) => esc(p).replace(/ /g, SP);
const PHRASES = [...A.phrases].sort((a, b) => b.length - a.length);
// A separator inside a number that is a phone: space, dot, slash, hyphen, the Unicode dashes and the non-breaking hyphen.
const PHONE_SEP = String.raw`\s(). ‐-―−\-/`;
const PHONE_SOURCE = String.raw`(?<![${L}])(?:\+|00)?\(?\d[\d${PHONE_SEP}]{5,}\d(?![${L}])`;
/** Characters outside any real page: they bracket a fake phone while the text is scrubbed, so it is not scrubbed twice. */
const OPEN = "";
const CLOSE = "";

const SCAN = new RegExp(
	[
		`(?<tok>${OPEN}\\(555\\) 010-\\d{4}${CLOSE})`,
		`(?<keep>(?<![${L}_])(?:${PHRASES.map(SPACE_WORDS).join("|")}|${KEEP_SHAPES.join("|")})(?![${L}]))`,
		...DATE_SHAPES.map((d, i) => `(?<date${i}>(?<![${L}_])(?:${d.src})(?![${L}]))`),
		String.raw`(?<user>\[[^\[\]\s]{1,60}\])`,
		`(?<phone>${PHONE_SOURCE})`,
		`(?<digits>(?<![${L}_])\\d+(?![${L}]))`,
	].join("|"),
	"gu",
);
const UPPER = /^\p{Lu}/u;
/** Content: a letter, a number, a mark, or ANY non-ASCII code point that is not a space or punctuation (a circled letter, a tag character, a private-use one). Only a space and punctuation are skipped. */
const CONTENT = /[\p{L}\p{N}\p{M}]|[^\x00-\x7f\s\p{P}\p{Z}]/u;
const ADJACENT = /^[\s ,.'’_/-]*$/;
const NAME_SHAPE = /^\p{Lu}[\p{L}\p{M}'’-]*(?:[\s ]+\p{Lu}[\p{L}\p{M}'’.-]*)+$/u;
const BRACKET_WORDS = new Set(A.bracketWords);

/** Everything one run remembers, so one real value always becomes the same fake. */
export interface RewriteState {
	names: Map<string, string>;
	words: Map<string, string>;
	phones: Map<string, string>;
	people: Map<string, string>;
	/** A real run of 4+ digits (a run with a leading zero is keyed exactly) to its fake: one to one, the same width, never itself. */
	numbers: Map<string, string>;
	times: Map<string, string>;
	/** Every run the pages of this run carry (no leading zeros): a fake is never one of them, so a fake never reads as real data. */
	reserved: Set<string>;
	/** Every word (lower case) any page of this run carries: a fake name never uses one. */
	pageWords: Set<string>;
	/** Every number a fake has been given out as, so a second real run never gets the same fake. */
	taken: Set<string>;
	/** One seeded derangement per short-id context and width (`t:3`): see `shortId`. */
	shortPerms: Map<string, number[]>;
	/** How many fresh short numbers this run has drawn (each draw is its own seeded stream). */
	fresh: number;
	/** Seeds the digit map and the date shift. A fresh random one by default, so a fake cannot be worked back to its real value from the source. */
	seed: string;
	/** The real "today" (a day number): dates before it stay before it, dates after it stay after it. */
	today: number;
	/** Every real date this run has met (a day number) and the synthetic day it became, sorted by the real one; see `fakeDay`. */
	dates: { real: number; fake: number; pivot?: boolean }[];
	/** Every real date the pages of this run carry (a day number), so a synthetic date is never one of them. */
	realDays: Set<number>;
	nextName: number;
	nextPerson: number;
	nextPhone: number;
	nextWord: number;
}

export interface RewriteStateOptions {
	seed?: string;
	/** The real "today" in ms; default `Date.now()`. Dates keep their side of it. */
	now?: number;
}

function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function newRewriteState(opts: RewriteStateOptions = {}): RewriteState {
	const seed = opts.seed ?? randomUUID();
	const today = Math.floor((opts.now ?? Date.now()) / 86_400_000);
	return {
		names: new Map(),
		words: new Map(),
		phones: new Map(),
		people: new Map(),
		numbers: new Map(),
		times: new Map(),
		reserved: new Set(),
		pageWords: new Set(),
		taken: new Set(),
		shortPerms: new Map(),
		fresh: 0,
		seed,
		today,
		dates: [{ real: today, fake: today, pivot: true }],
		realDays: new Set(),
		nextName: 0,
		nextPerson: 900_001,
		nextPhone: 1,
		nextWord: 0,
	};
}

/** Test hook: say that real run `real` is to become `fake` (the walker is signed in as one fixed club id). */
export function presetNumber(st: RewriteState, real: string, fake: string) {
	st.numbers.set(normRun(real), fake);
	st.taken.add(fake);
}

/** Seeded, so one run is repeatable; mulberry32 over a hash of the seed and a label. */
function rng(st: RewriteState, label: string): () => number {
	let a = hash32(`${st.seed}|${label}`);
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const keyOf = (s: string) => s.replace(/[\s +]+/g, " ").trim().toLowerCase();
const normRun = (r: string) => r.replace(/^0+(?=\d)/, "");

/** The lower-case words of a text, and the parts of a hyphenated or apostrophised one. */
const nameWords = (t: string): string[] => (t.normalize("NFKC").toLowerCase().match(/\p{L}[\p{L}\p{M}]*/gu) ?? []).filter((w) => w.length > 0);

function fakeName(st: RewriteState, core: string): string {
	const k = keyOf(core);
	const have = st.names.get(k);
	if (have) return have;
	// a fake name never shares a word with ANYTHING on the pages (a real name "Avery Quillon" must not become "Avery Alderfinch")
	let next: string | undefined;
	while ((next = FAKE_NAMES[st.nextName++]) !== undefined) {
		if (!nameWords(next).some((w) => st.pageWords.has(w))) break;
	}
	if (!next) throw new Error("the page has more distinct names than fake-names.json holds; add INVENTED names there, never real ones");
	st.names.set(k, next);
	return next;
}

/** `aa`, `ab`, ... : a placeholder word carries no digit, so it can never be a real number that survived. */
const letters = (n: number) => {
	let out = "";
	let k = n;
	do {
		out = String.fromCharCode(97 + (k % 26)) + out;
		k = Math.floor(k / 26) - 1;
	} while (k >= 0);
	return out;
};

function fakeWord(st: RewriteState, core: string): string {
	const k = keyOf(core);
	const have = st.words.get(k);
	if (have) return have;
	const w = `redacted-${letters(st.nextWord++)}`;
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

/** A person id: ANY id (a 900xxx one too) becomes the next id in 900001-900999 that no page of the run carries, the same one every time. */
function fakePerson(st: RewriteState, id: string): string {
	if (!/^\d+$/.test(id)) return "x";
	const key = normRun(id);
	const have = st.people.get(key);
	if (have) return have;
	let f: string;
	do f = String(st.nextPerson++);
	while (st.reserved.has(f) || st.taken.has(f));
	st.people.set(key, f);
	st.taken.add(f);
	return f;
}

/** `0042` -> `0043`: the next run of the same width, wrapping to `lo`. */
function nextRun(s: string, lo: string): string {
	const a = s.split("");
	for (let i = a.length - 1; i >= 0; i--) {
		if (a[i] !== "9") {
			a[i] = String(Number(a[i]) + 1);
			return a.join("");
		}
		a[i] = "0";
	}
	return lo;
}

/**
 * A run of 4 or more digits to one fake of the same width: the same real run is the same fake (every page of a
 * run), two real runs never share one, a fake is never its own input and, while there is room, never a run any
 * page of this run carries. A run with a leading zero is allocated over the FULL width (its zero prefix is not
 * copied) and keyed by its exact text. The start is seeded and the walk from it is deterministic, so a full
 * space throws instead of looping or merging two ids.
 */
function chooseRun(st: RewriteState, key: string, lead: boolean): string {
	const n = key.length;
	const r = rng(st, `run:${key}`);
	const lo = lead ? "0".repeat(n) : `1${"0".repeat(n - 1)}`;
	const size = lead ? 10 ** n : 9 * 10 ** (n - 1);
	const digits = (k: number) => Array.from({ length: k }, () => String(Math.floor(r() * 10))).join("");
	const first = lead ? digits(n) : String(1 + Math.floor(r() * 9)) + digits(n - 1);
	const ok = (c: string, strict: boolean) => c !== key && !st.taken.has(c) && !(strict && st.reserved.has(normRun(c)));
	for (const strict of [true, false]) {
		let c = first;
		// the strict pass only looks nearby (a page that carries most of the space has no run to avoid)
		const walk = Math.min(size, strict ? 2000 : 200_000);
		for (let i = 0; i < walk; i++) {
			if (ok(c, strict)) return c;
			c = nextRun(c, lo);
		}
	}
	throw new Error(`no fake left for a ${n}-digit run: the page carries more distinct ${n}-digit numbers than can be told apart`);
}

/**
 * A 1-3 digit run in a context the walker cross-references (a `t=` meeting id, an `s=` speech id, a club id): one
 * seeded DERANGEMENT per context and width, so the same short id is the same fake wherever THAT context carries
 * it, two ids never share a fake, and no id maps to itself. It is not shared with any other context.
 */
function shortId(st: RewriteState, ctx: string, run: string): string {
	const w = run.length;
	const key = `${ctx}:${w}`;
	let perm = st.shortPerms.get(key);
	if (!perm) {
		const size = 10 ** w;
		const r = rng(st, `perm:${key}`);
		let p: number[] = [];
		for (let attempt = 0; attempt < 500; attempt++) {
			p = Array.from({ length: size }, (_, i) => i);
			for (let i = size - 1; i > 0; i--) {
				const j = Math.floor(r() * (i + 1));
				[p[i], p[j]] = [p[j], p[i]];
			}
			if (p.every((v, i) => v !== i)) break;
			if (attempt === 499) throw new Error("no derangement found for a short id context");
		}
		perm = p;
		st.shortPerms.set(key, perm);
	}
	return String(perm[Number(run)]).padStart(w, "0");
}

/** A 1-3 digit run outside an id context: a fresh value of the same width for EVERY occurrence, never itself. No page-wide map, so no table to decode a split phone from. */
function freshShort(st: RewriteState, run: string): string {
	const w = run.length;
	// first a value no page of this run carries (so a fake never reads as real data), then any other one
	for (const strict of [true, false]) {
		for (let attempt = 0; attempt < 60; attempt++) {
			const r = rng(st, `fresh:${st.fresh++}:${w}`);
			const c = Array.from({ length: w }, () => String(Math.floor(r() * 10))).join("");
			if (c !== run && !(strict && st.reserved.has(normRun(c)))) return c;
		}
	}
	return String((Number(run) + 1) % 10 ** w).padStart(w, "0");
}

/**
 * Any digit run. 1-3 digits: a consistent fake only inside an id context (`ctx`), a fresh one per occurrence
 * everywhere else. 4 or more digits: the deterministic one to one map (`chooseRun`).
 */
function fakeRun(st: RewriteState, run: string, ctx?: string): string {
	if (run.length <= 3) return ctx ? shortId(st, ctx, run) : freshShort(st, run);
	const lead = /^0/.test(run);
	const key = lead ? run : normRun(run);
	let f = st.numbers.get(key);
	if (!f) {
		f = chooseRun(st, key, lead);
		st.numbers.set(key, f);
		st.taken.add(f);
	}
	return f;
}

/** A club id, a meeting id, a count or any other number. `ctx` names an id context the walker cross-references (`t`, `s`, `club`). */
function fakeNumber(st: RewriteState, id: string, ctx?: string): string {
	return /^\d+$/.test(id) ? fakeRun(st, id, ctx) : "x";
}

/** Every digit run in `s` replaced, the words and separators between them kept. */
const mapRunsIn = (st: RewriteState, s: string) => s.replace(/\d+/g, (r) => fakeRun(st, r));

/** How many weeks the first date on either side of today may be moved at most (5 years). */
const DATE_SPREAD_WEEKS = 260;
/** How many weeks each further date beyond the known ones is moved on top of that, at most: a page of 150 dates then stays within a few decades. */
const DATE_STEP_WEEKS = 52;

/**
 * A real day (days since 1970) to a synthetic one. NOT one shared offset: each distinct real date gets its own,
 * so one known real-to-fake pair does not give another date. What is kept is only the order of the dates, their
 * weekday (a whole number of weeks apart from where they sit) and their side of "today". The invariant that
 * keeps room for any later date: between two known dates the fake gap is never smaller than the real gap, and
 * both differ by a whole number of weeks. A new date goes between its neighbours at its real distance plus a
 * random number of spare weeks; one beyond all of them, at most `DATE_SPREAD_WEEKS` further out.
 */
function fakeDay(st: RewriteState, day: number): number {
	const same = st.dates.find((e) => e.real === day && !e.pivot);
	if (same) return same.fake;
	let at = 0;
	while (at < st.dates.length && st.dates[at].real < day) at++;
	let loIdx = at - 1;
	let hi = st.dates[at];
	if (hi && hi.real === day) {
		// the pivot itself ("today"): it is only a bound
		loIdx = at;
		hi = st.dates[at + 1];
	}
	const lo = st.dates[loIdx];
	const r = rng(st, `date:${day}`);
	const spare = lo && hi ? Math.floor((hi.fake - lo.fake - (hi.real - lo.real)) / 7) : (lo ?? hi)?.pivot ? DATE_SPREAD_WEEKS : DATE_STEP_WEEKS;
	const at0 = lo ? lo.fake + (day - lo.real) : (hi as { real: number; fake: number }).fake - ((hi as { real: number }).real - day);
	const sign = lo ? 1 : -1;
	// a start among the spare weeks, then the next ones, until the day is neither the real one nor another real date of the pages
	const start = Math.floor(r() * (spare + 1));
	let f = at0 + sign * 7 * start;
	for (let k = 0; k <= spare; k++) {
		const c = at0 + sign * 7 * ((start + k) % (spare + 1));
		if (c !== day && !st.realDays.has(c)) {
			f = c;
			break;
		}
	}
	st.dates.splice(loIdx + 1, 0, { real: day, fake: f });
	return f;
}

/** A synthetic date for a real one; null when the numbers are not a real date. */
function shiftDate(st: RewriteState, y: number, m: number, d: number): { y: number; m: number; d: number; dow: number } | null {
	const t = Date.UTC(y, m - 1, d);
	const dt = new Date(t);
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
	const n = new Date(fakeDay(st, Math.floor(t / 86_400_000)) * 86_400_000);
	return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate(), dow: n.getUTCDay() };
}

/** The first candidate (from a seeded start) that is not `input` and, if it can be, not a run the pages carry. */
function pick(st: RewriteState, label: string, pool: string[], input: string): string {
	const start = Math.floor(rng(st, label)() * pool.length);
	for (const strict of [true, false]) {
		for (let i = 0; i < pool.length; i++) {
			const c = pool[(start + i) % pool.length];
			if (normRun(c) !== normRun(input) && !(strict && st.reserved.has(normRun(c)))) return c;
		}
	}
	return pool.find((c) => normRun(c) !== normRun(input)) ?? pool[0];
}

const HOURS_12 = Array.from({ length: 12 }, (_, i) => String(i + 1));
const HOURS_24 = Array.from({ length: 24 }, (_, i) => String(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i));

/** A time of day, `7:30 pm`, becomes another valid time of the same shape: hour and minute are both different. */
function fakeTime(st: RewriteState, raw: string): string {
	const m = /^(\d{1,2}):(\d{2})([\s ]?[ap]m)?$/.exec(raw);
	if (!m) return mapRunsIn(st, raw);
	const [, h, mi, ap] = m;
	// 12-hour and 24-hour times are different spaces: "11:30" and "11:30am" must not share a fake
	const hours = ap ? HOURS_12 : HOURS_24;
	if (!hours.includes(String(Number(h))) || Number(mi) > 59) return mapRunsIn(st, raw);
	const key = `${ap ? "12" : "24"}:${h}:${mi}`;
	let f = st.times.get(key);
	if (!f) {
		const pool = hours.filter((x) => x.length === h.length);
		f = `${pick(st, `hour:${key}`, pool.length > 1 ? pool : hours, h)}:${pick(st, `minute:${mi}`, MINUTES, mi)}`;
		st.times.set(key, f);
	}
	return `${f}${ap ?? ""}`;
}

/**
 * A run of digits that is not part of a date or a time: a phone if it looks like one (the second net's
 * `(555) 010-xxxx`), else an id or a count. Every run in it goes through `fakeRun`.
 */
function replaceDigits(st: RewriteState, text: string, isBare: boolean): string {
	const digits = text.replace(/\D/g, "");
	if (digits.length < 7) return mapRunsIn(st, text);
	if (isBare && !/^0/.test(digits) && digits.length < 9) return fakeNumber(st, digits);
	return fakePhone(st, digits.replace(/^1(\d{10})$/, "$1"));
}

const isCapitalEdge = (word: string | undefined) => !!word && UPPER.test(word);
const lastWord = (s: string) => s.trim().split(/[\s '’-]+/).pop();
const firstWord = (s: string) => s.trim().split(/[\s '’-]+/)[0];

interface Hit {
	start: number;
	end: number;
	kind: "keep" | "repl";
	/** The replacement; `undefined` for a "repl": the matched text is scrubbed as a word run. */
	out: string | undefined;
}

interface Seg {
	start: number;
	end: number;
	replaced: boolean;
	out?: string;
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
		else if (g.digits !== undefined) hits.push({ start, end, kind: "repl", out: fakeRun(st, raw) });
		else {
			const i = DATE_SHAPES.findIndex((_, k) => g[`date${k}`] !== undefined);
			const parts = DATE_RES[i].exec(raw);
			// not a date after all (`May 99, 2026`): the whole match is scrubbed, its month word included
			hits.push({ start, end, kind: "repl", out: (parts ? DATE_SHAPES[i].render(st, parts) : null) ?? undefined });
		}
	}
	return hits;
}

/**
 * Text with everything not on the allow-list replaced. Whitespace and punctuation between words are
 * kept. A one-word allowed phrase next to a replaced word run is replaced WITH it (`Timer, Dana`,
 * `dana Timer`: "Timer" is allowed, but a surname that is also a role must not survive on its own).
 * Every digit run is replaced. `forceFirst`
 * / `forceLast` replace a kept phrase at that edge too (`Marlowe <b>Timer</b>` is two text nodes).
 */
function scrubDetailed(st: RewriteState, raw: string, force: { first?: boolean; last?: boolean } = {}): Scrubbed {
	// compatibility forms first (a circled letter, a fullwidth digit, a superscript read as the letter or digit they stand for)
	const text = raw.normalize("NFKC");
	const hits = scanHits(st, text);
	const segs: Seg[] = [];
	let at = 0;
	const gap = (from: number, to: number) => {
		// a run of words is one piece of text; "&", "|" and "/" end it ("Tom & Jerry" is two pieces and keeps its "&")
		let start = from;
		for (const cut of [...text.slice(from, to).matchAll(/[&|/\\]+/g), null]) {
			const end = cut ? from + (cut.index ?? 0) : to;
			const s = text.slice(start, end);
			// by CODE POINT: an index into the UTF-16 units would land inside a surrogate pair
			let first = -1;
			let lastEnd = -1;
			let i = 0;
			for (const ch of s) {
				if (CONTENT.test(ch)) {
					if (first < 0) first = i;
					lastEnd = i + ch.length;
				}
				i += ch.length;
			}
			if (first >= 0) segs.push({ start: start + first, end: start + lastEnd, replaced: true });
			if (cut) start = end + cut[0].length;
		}
	};
	for (const h of hits) {
		gap(at, h.start);
		segs.push({ start: h.start, end: h.end, replaced: h.kind === "repl", out: h.kind === "repl" ? h.out : undefined });
		at = h.end;
	}
	gap(at, text.length);
	segs.sort((x, y) => x.start - y.start);
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

/** The parameters whose short (1-3 digit) values the walker cross-references between pages: a meeting id and a speech id. A club id is the context `club`. */
const ID_CONTEXTS = new Set(["t", "s"]);

/** A number parameter (a page, a meeting, a speech, a year): every digit run is mapped, whatever its length. */
function rewriteNumber(st: RewriteState, value: string, ctx?: string): string {
	if (!/^-?\d+$/.test(value)) return "x";
	return `${value.startsWith("-") ? "-" : ""}${fakeNumber(st, value.replace(/^-/, ""), ctx)}`;
}

function rewriteParam(st: RewriteState, key: string, value: string, path: string): string {
	const k = key.toLowerCase();
	if (PERSON_PARAMS.has(k) || (k === "id" && !/ClubReport/i.test(path))) return fakePerson(st, value);
	if (CLUB_PARAMS.has(k) || k === "id") return fakeNumber(st, value, "club");
	if (k === "p" || k === "m") return /^\(-?[\d.]+,-?[\d.]+\)(?:,\d{1,2})?$/.test(value) ? mapRunsIn(st, value) : "x";
	if (k === "n") return encodeURIComponent(scrubText(st, decodeLoose(value)));
	if (NUMBER_PARAMS.has(k)) return rewriteNumber(st, value, ID_CONTEXTS.has(k) ? k : undefined);
	// only a name in KNOWN_PARAMS reaches here, and `__proto__` / `constructor` are not in it
	return A.paramValues[k]?.includes(value) ? value : "x";
}

function rewritePathSegment(st: RewriteState, seg: string): string {
	if (seg === "" || PAGE_NAMES.has(seg) || PATH_WORDS.has(seg)) return seg;
	if (/^\d+$/.test(seg)) return fakeNumber(st, seg);
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
/** A `window.open` features string (`width=800,scrollbars=yes`): literal feature names, `yes` / `no` or a number (mapped). Anything else is not one. */
function windowFeatures(st: RewriteState, body: string): string | null {
	const parts = body.split(",");
	const out: string[] = [];
	for (const part of parts) {
		const m = /^([a-z]+)=(yes|no|\d+)$/.exec(part);
		if (!m || !WINDOW_FEATURE_NAMES.has(m[1])) return null;
		out.push(`${m[1]}=${/^\d+$/.test(m[2]) ? fakeRun(st, m[2]) : m[2]}`);
	}
	return out.join(",");
}

function rewriteCode(st: RewriteState, source: string): string {
	// compatibility forms first, so a fullwidth or superscript digit is the digit it stands for
	const code = source.normalize("NFKC");
	const bare = (s: string) =>
		s
			.replace(/\\/g, "")
			.replace(/[\p{L}_$][\p{L}\p{N}_$]*/gu, (w) => (CODE_WORDS.has(w) ? w : "x"))
			// a number written in any script (Arabic-Indic, Devanagari ...) is a number: ASCII ones are mapped, any other is 0
			.replace(/\p{N}+/gu, (d) => (/^\d+$/.test(d) ? fakeRun(st, d) : "0"))
			// nothing else outside ASCII survives in bare code (a symbol, a tag character, a private-use one)
			.replace(/[^\x00-\x7f]/g, "");
	let out = "";
	let pos = 0;
	// a string literal, or a comment (dropped: a comment is not code, and valid JavaScript can hold anything in one)
	for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\]|\\[\s\S])*)\1|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g)) {
		const idx = m.index ?? 0;
		out += bare(code.slice(pos, idx));
		pos = idx + m[0].length;
		if (m[1] === undefined) {
			out += " ";
			continue;
		}
		const body = decodeJsEscapes(m[2]);
		let inner: string;
		if (A.codeStrings.includes(body)) inner = body;
		else if (windowFeatures(st, body) !== null) inner = windowFeatures(st, body) ?? "";
		else if (/\.(?:php|html|aspx|cfm|cgi)(?:[?#]|$)|^https?:\/\//i.test(body)) inner = rewriteUrl(st, body);
		else inner = scrubText(st, body);
		out += `${m[1]}${inner.replace(/[\\'"`]/g, "")}${m[1]}`;
	}
	return out + bare(code.slice(pos));
}

const FORM_PERSON = /user|member|person|speaker|uid|^rec\[/i;
const PERSON_IN_ATTR = /((?<![A-Za-z])(?<!(?<!%[0-9a-f])[0-9])(?:u|[a-z_]*(?:user|member|person|uid)[a-z_]*)(?:=|%3[dD])|attend_image1?\[|available\[|rec\[|available_)(\d+)/gi;

/** The lowercase markup words of an identifier stay; the rest of it goes through `scrubText`. */
function identPart(st: RewriteState, v: string): string {
	const parts = v.split(/([_\-[\]\s]+)/);
	let i = 0;
	let head = "";
	for (; i < parts.length; i++) {
		const p = parts[i];
		if (i % 2 === 1 || p === "" || ID_WORD_SET.has(p.toLowerCase())) head += p;
		else break;
	}
	return head + scrubText(st, parts.slice(i).join(""));
}

/** An `id`, `name` or `for`: a person id inside is replaced by its fake (the one the same id has in a link), the rest goes through `identPart`. */
function rewriteIdent(st: RewriteState, v: string): string {
	let out = "";
	let last = 0;
	for (const m of v.matchAll(PERSON_IN_ATTR)) {
		const at = m.index ?? 0;
		out += identPart(st, v.slice(last, at) + m[1]) + fakePerson(st, m[2]);
		last = at + m[0].length;
	}
	return out + identPart(st, v.slice(last));
}

/** A form field's value: a person id maps like the same id in a link, any other number is mapped too. */
function rewriteFormValue(st: RewriteState, field: string, value: string): string {
	if (/^\d+$/.test(value)) {
		if (FORM_PERSON.test(field) && !/club/i.test(field)) return fakePerson(st, value);
		const f = field.trim().toLowerCase();
		return fakeNumber(st, value, /club/i.test(f) ? "club" : ID_CONTEXTS.has(f) ? f : undefined);
	}
	return scrubText(st, value);
}

interface AttrContext {
	/** The field the value belongs to: the element's own ORIGINAL `name`, or an `<option>`'s select. */
	field: string;
	/** The element is `<input type="radio">` (by its ORIGINAL attributes). */
	radio: boolean;
}

function rewriteAttribute(st: RewriteState, ctx: AttrContext, name: string, rawValue: string): string {
	const value = rawValue.replace(/[]/g, "");
	const n = name.toLowerCase();
	const pattern = ENUMS.get(n);
	if (pattern) return pattern.test(value.trim()) ? value : "";
	if (COLOR_ATTRS.has(n)) return "";
	if (LAYOUT_ATTRS.has(n)) return mapRunsIn(st, value.replace(/[^\d%]/g, ""));
	if (n === "class") return value.split(/\s+/).filter(Boolean).map((c) => (CLASS_SET.has(c) ? c : "x")).join(" ");
	if (URL_ATTRS.has(n)) return rewriteUrl(st, value);
	if (HANDLERS.has(n) || /^\s*javascript:/i.test(value)) return rewriteCode(st, value.replace(/^\s*javascript:/i, ""));
	if (n === "id" || n === "name" || n === "for") return rewriteIdent(st, value);
	if (n === "value") return ctx.radio && ATTENDANCE_RADIO.test(ctx.field) && RADIO_VALUES.has(value.trim()) ? value : rewriteFormValue(st, ctx.field, value);
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
			if (digits.length >= 7 && digits.length <= 15) add(s, e);
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
			const nav = parent?.closest(".nav");
			const pagerText = nav ? /^Page (\d{1,3}) of (\d{1,3})$/.exec((nav.textContent ?? "").replace(/[\s\xa0]+/g, " ").trim()) : null;
			// the pager keeps its digits only inside `.nav`, as two of the literal page numbers of `ALLOW_LIST.pageNumbers`, the page not past the count; any other page text is mapped
			const pager = !!pagerText && PAGE_NUMBERS.has(pagerText[1]) && PAGE_NUMBERS.has(pagerText[2]) && Number(pagerText[1]) <= Number(pagerText[2]);
			const monthOption = tag === "option" && A.optionOnly.includes(t) && MONTH_SELECTS.has((parent?.closest("select")?.getAttribute("name") ?? "").trim().toLowerCase());
			const link = parent?.closest("a") ?? null;
			const linkAttrs = link ? `${link.getAttribute("href") ?? ""} ${link.getAttribute("onclick") ?? ""}` : "";
			const decodedAttrs = decodeLoose(linkAttrs.replace(/&amp;/g, "&"));
			if (pager || monthOption) {
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
				// the label is followed by a non-breaking space ("Venue&nbsp;<b>…"); "Venue <b>Name</b>" with a plain space is a name
				const label = a.kind === "scrub" && VALUE_LABELS.has(a.text.replace(/[\s\u00a0]+/g, " ").trim()) && a.trail.includes("\u00a0");
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
		const radio = tagOf(el) === "input" && original.some((a) => a.name.toLowerCase() === "type" && a.value.trim().toLowerCase() === "radio");
		// every original is taken off first and the finished list put back, so a renamed `data-x1` can never overwrite (or be
		// removed with) an attribute that was already called `data-x1`
		let renamed = 0;
		const finished = original.map((a) => {
			const lower = a.name.toLowerCase();
			const known = ATTRIBUTE_NAMES.has(lower) || HANDLERS.has(lower);
			const name = known ? a.name : `data-x${++renamed}`;
			// the parser writes an attribute value as it holds it, so a bare "&" would come out unescaped
			return [name, rewriteAttribute(st, { field, radio }, name, a.value).replace(/[\uE000\uE001]/g, "").replace(/&/g, "&amp;")] as const;
		});
		original.forEach((a, i) => {
			if (finished[i][0] !== a.name) el.removeAttribute(a.name);
		});
		for (const [name, value] of finished) el.setAttribute(name, value);
	}
}

/** Digits the markup itself always carries and the generator keeps as they are (an encoding name, a W3C url): not data, so not worth avoiding. */
const MARKUP_DIGITS = [/utf-8/gi, /iso-8859-1/gi, /<!doctype[^>]*>/gi, /https?:\/\/www\.w3\.org\/[^\s"']*/gi, /-\/\/w3c\/\/dtd[^"']*/gi, /initial-scale=1/gi];

/** The real dates a text carries, as [year, month, day], per date shape that holds a whole date (see `DATE_SHAPES`). */
function datesIn(t: string): [number, number, number][] {
	const out: [number, number, number][] = [];
	const add = (y: number, mo: number, d: number) => out.push([y, mo, d]);
	for (const [i, pick] of [
		[0, (m: RegExpMatchArray) => add(Number(m[7]), MONTHS.indexOf(m[5]) + 1, Number(m[3]))],
		[2, (m: RegExpMatchArray) => add(2000 + Number(m[5]), MONTH_ABBR.indexOf(m[1]) + 1, Number(m[3]))],
		[3, (m: RegExpMatchArray) => add(Number(m[6]), MONTHS.indexOf(m[1]) + 1, Number(m[3]))],
		[4, (m: RegExpMatchArray) => add(Number(m[3]), MONTHS.indexOf(m[1]) + 1, 15)],
		[5, (m: RegExpMatchArray) => add(Number(m[1]), Number(m[2]), Number(m[3]))],
		[6, (m: RegExpMatchArray) => (add(Number(m[1]), 6, 15), add(Number(m[2]), 6, 15))],
	] as [number, (m: RegExpMatchArray) => void][]) {
		for (const m of t.matchAll(new RegExp(DATE_SHAPES[i].src, "giu"))) pick(m);
	}
	return out;
}

/** Every digit run the page carries, so no fake is ever one of them. */
function reserveRuns(st: RewriteState, doc: Document, html: string) {
	const add = (t: string) => {
		let u = t;
		for (const re of MARKUP_DIGITS) u = u.replace(re, " ");
		for (const r of u.match(/\d+/g) ?? []) st.reserved.add(normRun(r));
		for (const w of nameWords(u)) st.pageWords.add(w);
		for (const [y, mo, d] of datesIn(u)) {
			const t = Date.UTC(y, mo - 1, d);
			if (new Date(t).getUTCMonth() === mo - 1 && new Date(t).getUTCDate() === d) st.realDays.add(Math.floor(t / 86_400_000));
		}
	};
	add(html);
	// text and attributes too, in their decoded form
	const walk = (n: Node) => {
		if (n.nodeType === 3 || n.nodeType === 8) add(n.nodeValue ?? "");
		if (n.nodeType === 1) for (const a of Array.from((n as Element).attributes ?? [])) add(`${a.name} ${a.value}`);
		for (const c of Array.from(n.childNodes ?? [])) walk(c);
	};
	walk(doc as unknown as Node);
	// Every real date of the page gets its synthetic day NOW, in the order that always leaves room: the dates before today
	// from the latest backwards, the dates after it from the earliest forwards, each at the open end of what is known.
	const known = new Set(st.dates.map((e) => e.real));
	const fresh = [...st.realDays].filter((d) => !known.has(d));
	for (const d of fresh.filter((x) => x < st.today).sort((a, b) => b - a)) fakeDay(st, d);
	for (const d of fresh.filter((x) => x >= st.today).sort((a, b) => a - b)) fakeDay(st, d);
}

/** A hand-written fixture, not a page: the evaluations JSON. */
const looksLikeJson = (input: string) => {
	const t = input.trim();
	if (!/^[[{]/.test(t)) return false;
	try {
		JSON.parse(t);
		return true;
	} catch {
		return false;
	}
};

function rewriteDocument(st: RewriteState, html: string): string {
	const doc = parseHtml(html);
	reserveRuns(st, doc, html);
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
	if (looksLikeJson(html)) throw new Error("the input is JSON, not an Easy-Speak page: the evaluations JSON fixtures are hand-written, this generator does not rewrite JSON");
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
	let result: GenerateResult;
	try {
		result = generateFixture(input, { contactPage, original });
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		return 2;
	}
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
