// Which two given names may be the same person (#1493). Pure and client-safe.
//
// The history import links by ref, email, exact name and folded name. A member the
// club loaded from the Toastmasters CSV under an official name ("Robert Smith")
// whom Easy-Speak lists by a nickname ("Bob Smith") matches none of those, so the
// plan SUGGESTS them to a human instead of creating a second person. A suggestion
// is never linked automatically: a wrong link merges two real people's history.
//
// English only, two-way, no spelling distance, no surname change. The looser
// `isLikelySameName` (#1589) only feeds a suggestion beside a new member, which
// never blocks and never links on its own.
import { foldName } from "./easy-speak-import-plan";
import { firstNameOf } from "./person-name";

/**
 * Short form -> the full names it may stand for. Reviewed as data. A short form
 * may map to several full names ("al" -> albert, alan, alfred); a full name's
 * short forms are read from the same table in reverse.
 */
const SHORT_FORMS: Record<string, readonly string[]> = {
	abby: ["abigail"],
	al: ["albert", "alan", "alfred", "alexander"],
	andy: ["andrew"],
	angie: ["angela"],
	barb: ["barbara"],
	becky: ["rebecca"],
	ben: ["benjamin"],
	benny: ["benjamin"],
	bert: ["albert", "robert", "herbert", "bertram"],
	beth: ["elizabeth"],
	betsy: ["elizabeth"],
	bill: ["william"],
	billy: ["william"],
	bob: ["robert"],
	bobby: ["robert"],
	cathy: ["catherine", "katherine"],
	charlie: ["charles"],
	chuck: ["charles"],
	connie: ["constance"],
	dave: ["david"],
	debbie: ["deborah", "debra"],
	deb: ["deborah", "debra"],
	dick: ["richard"],
	don: ["donald"],
	donnie: ["donald"],
	dottie: ["dorothy"],
	dot: ["dorothy"],
	ed: ["edward", "edwin", "edmund"],
	eddie: ["edward", "edwin"],
	ellie: ["eleanor", "ellen"],
	fran: ["frances", "francis"],
	frank: ["francis"],
	fred: ["frederick", "alfred"],
	freddie: ["frederick", "alfred"],
	gene: ["eugene"],
	greg: ["gregory"],
	hank: ["henry"],
	harry: ["harold", "henry"],
	jack: ["john", "jackson"],
	jake: ["jacob"],
	jeff: ["jeffrey", "geoffrey"],
	jen: ["jennifer"],
	jenny: ["jennifer"],
	jess: ["jessica", "jessie"],
	jim: ["james"],
	jimmy: ["james"],
	joe: ["joseph"],
	joey: ["joseph"],
	johnny: ["john", "jonathan"],
	jon: ["jonathan"],
	kate: ["katherine", "catherine", "kathryn"],
	katie: ["katherine", "catherine", "kathryn"],
	kathy: ["katherine", "kathleen", "catherine"],
	ken: ["kenneth"],
	kenny: ["kenneth"],
	kim: ["kimberly"],
	larry: ["lawrence", "laurence"],
	len: ["leonard"],
	lenny: ["leonard"],
	liz: ["elizabeth"],
	lizzie: ["elizabeth"],
	maggie: ["margaret"],
	matt: ["matthew"],
	meg: ["margaret"],
	mike: ["michael"],
	mickey: ["michael"],
	nan: ["nancy"],
	nate: ["nathan", "nathaniel"],
	ned: ["edward", "edmund"],
	nick: ["nicholas"],
	pam: ["pamela"],
	pat: ["patricia", "patrick"],
	patty: ["patricia"],
	peggy: ["margaret"],
	pete: ["peter"],
	phil: ["philip", "phillip"],
	polly: ["mary"],
	rand: ["randall", "randolph"],
	randy: ["randall", "randolph"],
	rick: ["richard", "frederick", "eric"],
	ricky: ["richard"],
	rob: ["robert"],
	robbie: ["robert"],
	ron: ["ronald"],
	ronnie: ["ronald"],
	sally: ["sarah"],
	sandy: ["sandra", "alexander"],
	stan: ["stanley"],
	steve: ["steven", "stephen"],
	sue: ["susan", "suzanne"],
	susie: ["susan", "suzanne"],
	ted: ["edward", "theodore"],
	teddy: ["edward", "theodore"],
	terry: ["terrence", "theresa", "terence"],
	tim: ["timothy"],
	timmy: ["timothy"],
	tom: ["thomas"],
	tommy: ["thomas"],
	tony: ["anthony"],
	trish: ["patricia"],
	vicky: ["victoria"],
	vic: ["victor", "victoria"],
	walt: ["walter"],
	wendy: ["gwendolyn"],
	will: ["william"],
	willie: ["william"],
	zach: ["zachary"],
};

const stripPunct = (s: string) => s.replace(/[,;.]+/gu, "");

/** The family name: before the comma in "Last, First", else the last word. `""` for a one-word name. */
export function surnameOf(name: string): string {
	const trimmed = foldName(name);
	const comma = trimmed.indexOf(",");
	if (comma !== -1) {
		const before = stripPunct(trimmed.slice(0, comma)).trim();
		const after = trimmed.slice(comma + 1).trim();
		return before !== "" && after !== "" ? before : "";
	}
	const parts = trimmed.split(" ").filter(Boolean);
	if (parts.length < 2) return "";
	return stripPunct(parts[parts.length - 1] ?? "");
}

/** Whether two given names (already folded) are related by the table, either way round. */
function shortFormPair(a: string, b: string): boolean {
	return (
		(SHORT_FORMS[a]?.includes(b) ?? false) ||
		(SHORT_FORMS[b]?.includes(a) ?? false)
	);
}

/**
 * Whether one folded given name is a prefix of the other: the shorter at least 3
 * letters and the longer at least 2 letters longer (chris/christopher, dan/daniel;
 * not jan/jane or dan/dana, which are distinct names one letter apart).
 */
function prefixPair(a: string, b: string): boolean {
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return (
		short.length >= 3 &&
		long.length >= short.length + 2 &&
		long.startsWith(short)
	);
}

/** Whether two given names may be the same person's: equal, a short form, or a prefix. */
export function givenNamesRelated(a: string, b: string): boolean {
	const x = foldName(a);
	const y = foldName(b);
	if (x === "" || y === "") return false;
	return x === y || shortFormPair(x, y) || prefixPair(x, y);
}

/**
 * Whether `a` and `b` are close names: the same surname and related given names.
 * A one-word name on either side never qualifies. Reads "First Last" and "Last, First".
 */
export function isCloseName(a: string, b: string): boolean {
	const sa = surnameOf(a);
	const sb = surnameOf(b);
	if (sa === "" || sb === "" || sa !== sb) return false;
	return givenNamesRelated(firstNameOf(a), firstNameOf(b));
}

/** Edit distance between two strings (insert, delete, substitute), stopping early past `max`. */
function editDistanceAtMost(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const v = Math.min(
				(prev[j] ?? 0) + 1,
				(row[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			);
			row.push(v);
			if (v < best) best = v;
		}
		if (best > max) return max + 1;
		prev = row;
	}
	return prev[b.length] ?? max + 1;
}

/** The shortest folded name the one-letter-typo rule reads: below it, one letter is too much of the name. */
const MIN_TYPO_LENGTH = 6;

/**
 * Whether `a` and `b` are LIKELY the same person (#1589): a looser reading than
 * {@link isCloseName}, for a suggestion the import shows beside a new member and
 * never acts on. True when
 * - the surnames share a hyphen part (`roe` and `roe-smith`) and the given names
 *   share a first letter (initials: `cj` / `christopher`), or one is a prefix of
 *   the other (`tish` / `tishiana`), or they are related by {@link givenNamesRelated};
 * - or the whole folded names are one edit apart and each is at least 6 letters
 *   (`sam towler` / `sam tawler`; not `al wu` / `al xu`).
 * Never true for two names that fold the same: those are matched already.
 */
export function isLikelySameName(a: string, b: string): boolean {
	const x = stripPunct(foldName(a));
	const y = stripPunct(foldName(b));
	if (x === "" || y === "" || x === y) return false;
	const tx = x.split(" ").filter(Boolean);
	const ty = y.split(" ").filter(Boolean);
	if (tx.length >= 2 && ty.length >= 2) {
		const partsOf = (t: string[]) =>
			(t[t.length - 1] ?? "").split("-").filter(Boolean);
		const py = new Set(partsOf(ty));
		const surnames = partsOf(tx).some((p) => py.has(p));
		const fx = tx[0] ?? "";
		const fy = ty[0] ?? "";
		// A prefix (`tish` / `tishiana`) shares the first letter, so the letter
		// covers it; the short-form table covers `bob` / `robert`.
		const firsts = fx[0] === fy[0] || givenNamesRelated(fx, fy);
		if (surnames && firsts) return true;
	}
	return (
		x.length >= MIN_TYPO_LENGTH &&
		y.length >= MIN_TYPO_LENGTH &&
		editDistanceAtMost(x, y, 1) === 1
	);
}
