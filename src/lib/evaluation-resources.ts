/**
 * Official Toastmasters evaluation resources, linked to Pathways projects.
 *
 * We LINK to TI's PDFs. Nothing here is hosted, mirrored, cached or proxied.
 *
 * PROVENANCE: scraped 2026-08-20 from the Evaluation Resources category of TI's
 * resource library —
 * `https://www.toastmasters.org/resources/resource-library?c=%7B01B94FC3-FC65-4308-8CB2-6193718ED156%7D`
 * — 15 pages at `&page=N`, 73 items, matching the "1-5 of 73 items" the page
 * states. Server-rendered, so a plain GET returns the markup. Every one of the
 * 73 destination URLs was requested with `curl -L` and returned
 * `200 application/pdf` (all 73, not a sample).
 *
 * This header exists because `pathways-catalog.ts` carries a standing
 * correction: an earlier version of ITS header claimed a toastmasters.org
 * source for names that were LLM-generated. That correction was kept visible
 * "so nobody re-derives false confidence from it". So: the funnel below is how
 * these 64 rows were obtained, and the four conflicts are why the table is
 * PINNED rather than computed.
 *
 * FUNNEL: 73 scraped − 3 language variants (Arabic x1, Simplified Chinese x2)
 * = 70 English; 63 of those map to a `pathways-catalog.ts` project and cover
 * ALL 60 distinct project names; + `8053` Generic = 64 rows here.
 *
 * WHY PINNED, NOT DERIVED. Each item carries a description of the form 'This
 * evaluation resource is for the "X" project.' Across the 73: 64 agree with the
 * title, 3 have no parseable project (all non-project resources), and 6
 * disagree. Two of those 6 are harmless — Vocal Variety's two resources echo
 * their own full title inside the quotes, which is itself why the description
 * is not a trustworthy parser. The other FOUR are genuine conflicts in TI's own
 * library, and NEITHER field is right in all four:
 *
 *   8103E  title "Evaluation and Feedback-Writing a Speech With Purpose"
 *          desc  "Writing a Speech With Purpose"          → DESC trusted
 *   8409E  title "Managing a Difficult Audience"
 *          desc  "Manage Projects Successfully"           → TITLE trusted
 *   8410E  title "Mentoring"
 *          desc  "Manage Projects Successfully"           → TITLE trusted
 *   8207E  title "Understanding Your Leadership Style"
 *          desc  "Understanding Your Communication Style" → TITLE trusted
 *
 * 8409E/8410E/8207E are consecutive-code copy-paste errors in TI's
 * descriptions: 8408E is the real "Manage Projects Successfully" and 8206E the
 * real "Understanding Your Communication Style". 8103E is the reverse — its
 * TITLE carries a stray "Evaluation and Feedback-" prefix, while 8100E1 and its
 * two codeless siblings (see below) are
 * the real Evaluation and Feedback resources.
 *
 * Consequence: title-only matching resolves 59/60 catalog projects,
 * description-only 57/60. Only this hand-audited table reaches 60/60. Replacing
 * it with a derivation silently loses projects — `evaluation-resources.test.ts`
 * fails if you try.
 *
 * TWO ROWS HAVE NO ITEM CODE. Evaluation and Feedback's second and third
 * resources use a generic thumbnail and an opaque `.ashx` URL, so nothing on the
 * page exposes their code. `8100E1` is confirmed for the first speech (from its
 * PDF filename); `8100E2` for the second would be an INFERENCE. Do not write
 * one. `itemCode` is null there and the test pins that it stays null for
 * exactly two rows.
 *
 * NOT IN THE CATALOG. Six English items map to no catalog project and are
 * deliberately absent: 8500E Advanced Mentoring, 8202E Cross-Cultural
 * Understanding, 8410E Mentoring, 8599E Distinguished Toastmaster, 490CO Club
 * Officer 360-Degree Evaluation, 490DL District Leader 360-Degree Evaluation.
 * The first three name REAL Pathways projects that `pathways-catalog.ts` does
 * not list — a catalog gap filed as #606, deliberately not fixed here because
 * adding a project changes what the picker offers and what the seed writes.
 *
 * TITLES ARE THE CATALOG'S, NOT TI'S. `title` mirrors `project` for every row
 * that has one, so this page reads the same as the project picker and the
 * agenda (both of which show Base Camp's name). TI's own titles are not usable
 * verbatim: 8103E's carries the stray prefix above, and two differ from the
 * catalog only in the casing of "with". The generic row is the one title that is
 * ours to choose.
 *
 * NO LANGUAGE FIELD. The three translations are dropped. Adding them later is
 * additive.
 *
 * DOES NOT IMPORT `pathways-catalog.ts`, on purpose: the two files are
 * cross-checked by a test, and a test is worth nothing if one input is derived
 * from the other.
 *
 * WHAT NO TEST HERE CAN SEE. Swap the `url` of two rows and every assertion in
 * `evaluation-resources.test.ts` still passes: both URLs stay unique, https and
 * on a toastmasters.org host, and both projects still resolve to a resource. 56
 * of the 64 URLs are opaque `.ashx` GUIDs carrying no item code, so nothing
 * local can say which PDF sits behind one — only the 8 filename-bearing URLs
 * are pinned to their code (see the test of that name).
 * `scripts/check-evaluation-resource-links.ts` (`bun run check:eval-links`)
 * proves each URL still serves a PDF, never that it serves the RIGHT one. The
 * only remedy for a suspected mix-up is to re-scrape the category and diff it,
 * the way this table was built.
 */

export interface EvaluationResource {
	/**
	 * Local stable identity, kebab-case. OURS, not TI's — two rows have no
	 * discoverable item code, so `itemCode` cannot carry identity.
	 */
	key: string;
	/** TI's item code where the page exposes one; null for exactly 2 of the 64. */
	itemCode: string | null;
	/** Display title, TI's "-Evaluation Resource" suffix removed. */
	title: string;
	/** Absolute https URL on a toastmasters.org host. */
	url: string;
	/**
	 * Canonical `pathways-catalog.ts` project name, spelled exactly as that file
	 * spells it. Null only for the generic resource.
	 */
	project: string | null;
	/** Distinguishes siblings on a multi-resource project. Absent when alone. */
	part?: string;
}

/**
 * Works for any speech, inside Pathways or outside it. The fallback whenever a
 * project is unknown, absent, or TBA — which is why it ships even though it
 * maps to no project.
 */
export const GENERIC_EVALUATION_RESOURCE: EvaluationResource = {
	key: "generic",
	itemCode: "8053",
	title: "Generic Evaluation Resource",
	url: "https://content.toastmasters.org/image/upload/8053-generic-evaluation-resource.pdf",
	project: null,
};

export const EVALUATION_RESOURCES: readonly EvaluationResource[] = [
	{
		key: "active-listening",
		itemCode: "8200E",
		title: "Active Listening",
		url: "https://www.toastmasters.org/resources/-/media/d97ff6e633ad44dbaca0ddac5a6c0fb8.ashx",
		project: "Active Listening",
	},
	{
		key: "building-a-social-media-presence",
		itemCode: "8400E",
		title: "Building a Social Media Presence",
		url: "https://www.toastmasters.org/resources/-/media/37dde033a23f4e75ac113786e840fb8e.ashx",
		project: "Building a Social Media Presence",
	},
	{
		key: "communicate-change",
		itemCode: "8401E",
		title: "Communicate Change",
		url: "https://www.toastmasters.org/resources/-/media/87df0196dec944ba80ab1451182a02c2.ashx",
		project: "Communicate Change",
	},
	{
		key: "connect-with-storytelling",
		itemCode: "8300E",
		title: "Connect with Storytelling",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8300e-evaluation-resource-ffe.pdf",
		project: "Connect with Storytelling",
	},
	{
		key: "connect-with-your-audience",
		itemCode: "8201E",
		title: "Connect with Your Audience",
		url: "https://www.toastmasters.org/resources/-/media/fc7df1a49bcf49968e90d07a550e282a.ashx",
		project: "Connect with Your Audience",
	},
	{
		key: "create-a-podcast",
		itemCode: "8402E",
		title: "Create a Podcast",
		url: "https://www.toastmasters.org/resources/-/media/c35bea8707c8428ebf760bdf2de6565d.ashx",
		project: "Create a Podcast",
	},
	{
		key: "creating-effective-visual-aids",
		itemCode: "8301E",
		title: "Creating Effective Visual Aids",
		url: "https://www.toastmasters.org/resources/-/media/d389e83787464044bd66639ef0e8113b.ashx",
		project: "Creating Effective Visual Aids",
	},
	{
		key: "deliver-social-speeches",
		itemCode: "8302E",
		title: "Deliver Social Speeches",
		url: "https://www.toastmasters.org/resources/-/media/438184926b484f51b4db267445f8b11c.ashx",
		project: "Deliver Social Speeches",
	},
	{
		key: "deliver-your-message-with-humor",
		itemCode: "8512E",
		title: "Deliver Your Message with Humor",
		url: "https://www.toastmasters.org/resources/-/media/40C19CFA8CF04210BB669D326D3B8763.ashx",
		project: "Deliver Your Message with Humor",
	},
	{
		key: "develop-a-communication-plan",
		itemCode: "8303E",
		title: "Develop a Communication Plan",
		url: "https://www.toastmasters.org/resources/-/media/9e466adea038434083f04f406a065801.ashx",
		project: "Develop a Communication Plan",
	},
	{
		key: "develop-your-vision",
		itemCode: "8501E",
		title: "Develop Your Vision",
		url: "https://www.toastmasters.org/resources/-/media/91202662629D422D80ED85C94ED958DA.ashx",
		project: "Develop Your Vision",
	},
	{
		key: "effective-body-language",
		itemCode: "8203E",
		title: "Effective Body Language",
		url: "https://www.toastmasters.org/resources/-/media/64608c0f628b43e68415a7f2ab7194d1.ashx",
		project: "Effective Body Language",
	},
	{
		key: "engage-your-audience-with-humor",
		itemCode: "8320E",
		title: "Engage Your Audience with Humor",
		url: "https://www.toastmasters.org/resources/-/media/28633B8177784BE28330D9A4A3DD44EF.ashx",
		project: "Engage Your Audience with Humor",
	},
	{
		key: "ethical-leadership",
		itemCode: "8502E",
		title: "Ethical Leadership",
		url: "https://www.toastmasters.org/resources/-/media/18DDDB2ABF0342CB8D035DD4591115C2.ashx",
		project: "Ethical Leadership",
	},
	{
		key: "evaluation-and-feedback-evaluator-role",
		itemCode: null,
		title: "Evaluation and Feedback",
		url: "https://www.toastmasters.org/resources/-/media/0c340954db12422d843d9ff47c40d02b.ashx",
		project: "Evaluation and Feedback",
		part: "Evaluator role",
	},
	{
		key: "evaluation-and-feedback-first-speech",
		itemCode: "8100E1",
		title: "Evaluation and Feedback",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8100e1-evaluation-resource-first-speech.pdf",
		project: "Evaluation and Feedback",
		part: "First speech",
	},
	{
		key: "evaluation-and-feedback-second-speech",
		itemCode: null,
		title: "Evaluation and Feedback",
		url: "https://www.toastmasters.org/resources/-/media/0B82133F45624042BD1A6D589FCB25FA.ashx",
		project: "Evaluation and Feedback",
		part: "Second speech",
	},
	{
		key: "focus-on-the-positive",
		itemCode: "8304E",
		title: "Focus on the Positive",
		url: "https://www.toastmasters.org/resources/-/media/a0918b5d8b504925a09c9f540d877bf0.ashx",
		project: "Focus on the Positive",
	},
	{
		key: "high-performance-leadership",
		itemCode: "8503E",
		title: "High Performance Leadership",
		url: "https://www.toastmasters.org/resources/-/media/AD5D85F559504A8ABB71CF6E0D8048AF.ashx",
		project: "High Performance Leadership",
	},
	{
		key: "ice-breaker",
		itemCode: "8101E",
		title: "Ice Breaker",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8101e-evaluation-resource.pdf",
		project: "Ice Breaker",
	},
	{
		key: "improvement-through-positive-coaching",
		itemCode: "8403E",
		title: "Improvement Through Positive Coaching",
		url: "https://www.toastmasters.org/resources/-/media/7ab9b454f2e9409b8a916c52da520274.ashx",
		project: "Improvement Through Positive Coaching",
	},
	{
		key: "inspire-your-audience",
		itemCode: "8305E",
		title: "Inspire Your Audience",
		url: "https://www.toastmasters.org/resources/-/media/c9e20cb3b0a64f478c6b847a1db292d8.ashx",
		project: "Inspire Your Audience",
	},
	{
		key: "introduction-to-toastmasters-mentoring",
		itemCode: "8204E",
		title: "Introduction to Toastmasters Mentoring",
		url: "https://www.toastmasters.org/resources/-/media/df2e2065fa984b529e4fda62787d2353.ashx",
		project: "Introduction to Toastmasters Mentoring",
	},
	{
		key: "introduction-to-vocal-variety-and-body-language-evaluation-resource",
		itemCode: "8104E1",
		title: "Introduction to Vocal Variety and Body Language",
		url: "https://content.toastmasters.org/image/upload/v1741989017/8104E1-evaluation-resource-ff.pdf",
		project: "Introduction to Vocal Variety and Body Language",
		// "Evaluation resource" rendered as "Evaluation resource — Evaluation
		// resource" wherever the UI prefixes the part, on a REQUIRED Level 1
		// project of all 11 paths. This pairs with its sibling "Speech profile"
		// instead. Only the label changed — code, URL and project are scraped data.
		part: "Speech evaluation",
	},
	{
		key: "introduction-to-vocal-variety-and-body-language-speech-profile",
		itemCode: "8104E2",
		title: "Introduction to Vocal Variety and Body Language",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8104e2-speech-profile-ff.pdf",
		project: "Introduction to Vocal Variety and Body Language",
		part: "Speech profile",
	},
	{
		key: "know-your-sense-of-humor",
		itemCode: "8208E",
		title: "Know Your Sense of Humor",
		url: "https://www.toastmasters.org/resources/-/media/AE85794F189346BC9799C741779E2DE3.ashx",
		project: "Know Your Sense of Humor",
	},
	{
		key: "lead-in-any-situation",
		itemCode: "8504E",
		title: "Lead in Any Situation",
		url: "https://www.toastmasters.org/resources/-/media/678FC18FC8BD4787BB1879E349B43894.ashx",
		project: "Lead in Any Situation",
	},
	{
		key: "leading-in-difficult-situations",
		itemCode: "8404E",
		title: "Leading in Difficult Situations",
		url: "https://www.toastmasters.org/resources/-/media/7ee191ee046a495290643305ae820c10.ashx",
		project: "Leading in Difficult Situations",
	},
	{
		key: "leading-in-your-volunteer-organization",
		itemCode: "8505E",
		title: "Leading in Your Volunteer Organization",
		url: "https://www.toastmasters.org/resources/-/media/7B49DCA2A7F44B81853647C7D02FDA86.ashx",
		project: "Leading in Your Volunteer Organization",
	},
	{
		key: "leading-your-team",
		itemCode: "8405E",
		title: "Leading Your Team",
		url: "https://www.toastmasters.org/resources/-/media/eb0435e414a44546bd585a92dc31beaf.ashx",
		project: "Leading Your Team",
	},
	{
		key: "lessons-learned",
		itemCode: "8506E",
		title: "Lessons Learned",
		url: "https://www.toastmasters.org/resources/-/media/592BAD67F5CC4445AB87F9EB79DA0C28.ashx",
		project: "Lessons Learned",
	},
	{
		key: "make-connections-through-networking",
		itemCode: "8306E",
		title: "Make Connections Through Networking",
		url: "https://www.toastmasters.org/resources/-/media/3476E4FFE94A47E390446346E0F275F3.ashx",
		project: "Make Connections Through Networking",
	},
	{
		key: "manage-change",
		itemCode: "8406E",
		title: "Manage Change",
		url: "https://www.toastmasters.org/resources/-/media/ff41100ad8124693aa6f5d79cecab550.ashx",
		project: "Manage Change",
	},
	{
		key: "manage-online-meetings",
		itemCode: "8407E",
		title: "Manage Online Meetings",
		url: "https://www.toastmasters.org/resources/-/media/76F5A0DFFC694F57939EA8A656F763BB.ashx",
		project: "Manage Online Meetings",
	},
	{
		key: "manage-projects-successfully",
		itemCode: "8408E",
		title: "Manage Projects Successfully",
		url: "https://www.toastmasters.org/resources/-/media/A6CDC57BC1344D06888B76C5830F4CF2.ashx",
		project: "Manage Projects Successfully",
	},
	{
		key: "manage-successful-events",
		itemCode: "8507E",
		title: "Manage Successful Events",
		url: "https://www.toastmasters.org/resources/-/media/DC4F94B05F2545F493699261AA95B8C7.ashx",
		project: "Manage Successful Events",
	},
	{
		key: "managing-a-difficult-audience",
		itemCode: "8409E",
		title: "Managing a Difficult Audience",
		url: "https://www.toastmasters.org/resources/-/media/937F8775C4AE42678999607972793762.ashx",
		project: "Managing a Difficult Audience",
	},
	{
		key: "managing-time",
		itemCode: "8205E",
		title: "Managing Time",
		url: "https://www.toastmasters.org/resources/-/media/60d8b49dfbf548faa9be863055a498db.ashx",
		project: "Managing Time",
	},
	{
		key: "moderate-a-panel-discussion",
		itemCode: "8508E",
		title: "Moderate a Panel Discussion",
		url: "https://www.toastmasters.org/resources/-/media/854D525911684FF8AEBD5D7A294D4F7A.ashx",
		project: "Moderate a Panel Discussion",
	},
	{
		key: "motivate-others",
		itemCode: "8411E",
		title: "Motivate Others",
		url: "https://www.toastmasters.org/resources/-/media/C6C4D2488F6A4A76BD3D480C877610CE.ashx",
		project: "Motivate Others",
	},
	{
		key: "negotiate-the-best-outcome",
		itemCode: "8307E",
		title: "Negotiate the Best Outcome",
		url: "https://www.toastmasters.org/resources/-/media/fcbb9cc048524519a1722a7228e35e9c.ashx",
		project: "Negotiate the Best Outcome",
	},
	{
		key: "persuasive-speaking",
		itemCode: "8308E",
		title: "Persuasive Speaking",
		url: "https://www.toastmasters.org/resources/-/media/6a1ef7aaed124b6d99eecd0b85271414.ashx",
		project: "Persuasive Speaking",
	},
	{
		key: "planning-and-implementing",
		itemCode: "8309E",
		title: "Planning and Implementing",
		url: "https://www.toastmasters.org/resources/-/media/2e789337f5374108a9a124a7f8872dee.ashx",
		project: "Planning and Implementing",
	},
	{
		key: "prepare-for-an-interview",
		itemCode: "8310E",
		title: "Prepare for an Interview",
		url: "https://www.toastmasters.org/resources/-/media/31ced8bd60ac47e092b45ca576afd934.ashx",
		project: "Prepare for an Interview",
	},
	{
		key: "prepare-to-speak-professionally",
		itemCode: "8509E",
		title: "Prepare to Speak Professionally",
		url: "https://www.toastmasters.org/resources/-/media/D4803317A848454595E628F9CA5AF414.ashx",
		project: "Prepare to Speak Professionally",
	},
	{
		key: "present-a-proposal",
		itemCode: "8312E",
		title: "Present a Proposal",
		url: "https://www.toastmasters.org/resources/-/media/75bed3e3eba245729664ab9f0a41fa5e.ashx",
		project: "Present a Proposal",
	},
	{
		key: "public-relations-strategies",
		itemCode: "8412E",
		title: "Public Relations Strategies",
		url: "https://www.toastmasters.org/resources/-/media/F3306DC62FA34425AEAF05AED1ADD857.ashx",
		project: "Public Relations Strategies",
	},
	{
		key: "question-and-answer-session",
		itemCode: "8413E",
		title: "Question-and-Answer Session",
		url: "https://content.toastmasters.org/image/upload/8413E-evaluation-resource-ff.pdf",
		project: "Question-and-Answer Session",
	},
	{
		key: "reaching-consensus",
		itemCode: "8313E",
		title: "Reaching Consensus",
		url: "https://www.toastmasters.org/resources/-/media/b5001c808e324998813489c5a0ca969e.ashx",
		project: "Reaching Consensus",
	},
	{
		key: "reflect-on-your-path",
		itemCode: "8510E",
		title: "Reflect on Your Path",
		url: "https://www.toastmasters.org/resources/-/media/F8FDA780555D41DC97C83FED8FD46155.ashx",
		project: "Reflect on Your Path",
	},
	{
		key: "researching-and-presenting",
		itemCode: "8102E",
		title: "Researching and Presenting",
		url: "https://www.toastmasters.org/resources/-/media/4a3f37e2cd0345068d5e3b7718fc7062.ashx",
		project: "Researching and Presenting",
	},
	{
		key: "successful-collaboration",
		itemCode: "8314E",
		title: "Successful Collaboration",
		url: "https://www.toastmasters.org/resources/-/media/42e078bf026a4ab08c1b5c1a9cc08f19.ashx",
		project: "Successful Collaboration",
	},
	{
		key: "team-building",
		itemCode: "8511E",
		title: "Team Building",
		url: "https://www.toastmasters.org/resources/-/media/160ABF0AFFEC4C7D982F00CAC2ECF59A.ashx",
		project: "Team Building",
	},
	{
		key: "the-power-of-humor-in-an-impromptu-speech",
		itemCode: "8415E",
		title: "The Power of Humor in an Impromptu Speech",
		url: "https://www.toastmasters.org/resources/-/media/E92A94438C344C799752A920A3805E6F.ashx",
		project: "The Power of Humor in an Impromptu Speech",
	},
	{
		key: "understanding-conflict-resolution",
		itemCode: "8315E",
		title: "Understanding Conflict Resolution",
		url: "https://www.toastmasters.org/resources/-/media/75485e2dfd1642eb8984b93b1ae2fc75.ashx",
		project: "Understanding Conflict Resolution",
	},
	{
		key: "understanding-emotional-intelligence",
		itemCode: "8316E",
		title: "Understanding Emotional Intelligence",
		url: "https://www.toastmasters.org/resources/-/media/86add2932d7e45e1814cb05ee2c3dd8b.ashx",
		project: "Understanding Emotional Intelligence",
	},
	{
		key: "understanding-vocal-variety",
		itemCode: "8317E",
		title: "Understanding Vocal Variety",
		url: "https://www.toastmasters.org/resources/-/media/b0725fa9cd6444c899ec03a89e788f4d.ashx",
		project: "Understanding Vocal Variety",
	},
	{
		key: "understanding-your-communication-style",
		itemCode: "8206E",
		title: "Understanding Your Communication Style",
		url: "https://www.toastmasters.org/resources/-/media/24dfeac928e64ed8b5226e445ab96c29.ashx",
		project: "Understanding Your Communication Style",
	},
	{
		key: "understanding-your-leadership-style",
		itemCode: "8207E",
		title: "Understanding Your Leadership Style",
		url: "https://www.toastmasters.org/resources/-/media/5a61dd1d0cef472cbbab7931a618b37d.ashx",
		project: "Understanding Your Leadership Style",
	},
	{
		key: "using-descriptive-language",
		itemCode: "8318E",
		title: "Using Descriptive Language",
		url: "https://www.toastmasters.org/resources/-/media/ed8a2a2b6e174fa2a246b1b8b6a34b84.ashx",
		project: "Using Descriptive Language",
	},
	{
		key: "using-presentation-software",
		itemCode: "8319E",
		title: "Using Presentation Software",
		url: "https://www.toastmasters.org/resources/-/media/4cdf344506554e609341ba7ef65faadc.ashx",
		project: "Using Presentation Software",
	},
	{
		key: "write-a-compelling-blog",
		itemCode: "8414E",
		title: "Write a Compelling Blog",
		url: "https://www.toastmasters.org/resources/-/media/7CCBD12EB1754A2F910CCEBE96AAAE02.ashx",
		project: "Write a Compelling Blog",
	},
	{
		key: "writing-a-speech-with-purpose",
		itemCode: "8103E",
		title: "Writing a Speech with Purpose",
		url: "https://content.toastmasters.org/image/upload/8103E-evaluation-resource-ff.pdf",
		project: "Writing a Speech with Purpose",
	},
	GENERIC_EVALUATION_RESOURCE,
];

/**
 * The " (Legacy)" suffix `pathways-catalog.ts` (`withLegacySuffix`) carries on
 * every project of the five retired paths. ONE copy of the pattern: `normalize`
 * strips it and `resolveEvaluationResources` tests for it, and those two reading
 * the convention differently is the bug class this constant closes.
 */
const LEGACY_SUFFIX = /\s*\(Legacy\)\s*$/i;

/**
 * The ONE normalizer: lowercased, non-alphanumerics collapsed to single spaces,
 * trimmed, trailing "(Legacy)" removed. Base Camp returns project names with its
 * own punctuation and casing ("Question-and-Answer Session" vs "question and
 * answer session"), and TI publishes only the current edition of each form.
 *
 * Shared by the project lookup AND the index page's search. It was two
 * independent copies and the search half omitted the "(Legacy)" strip, so all 47
 * legacy catalog names returned ZERO search results — while
 * `content/resources/evaluation-resources.md` tells the reader to search "the
 * project name your evaluator will see on the agenda", which on a legacy path is
 * exactly the name that failed. A third copy of these rules will do it again.
 */
function normalize(value: string): string {
	return value
		.replace(LEGACY_SUFFIX, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * The `BY_PROJECT` key for a project name — `normalize` under the name of the
 * role it plays, so the map's key type is self-describing at both ends.
 */
function lookupKey(name: string): string {
	return normalize(name);
}

const BY_PROJECT: ReadonlyMap<string, readonly EvaluationResource[]> = (() => {
	const m = new Map<string, EvaluationResource[]>();
	for (const r of EVALUATION_RESOURCES) {
		if (!r.project) continue;
		const k = lookupKey(r.project);
		const list = m.get(k);
		if (list) list.push(r);
		else m.set(k, [r]);
	}
	return m;
})();

/**
 * Every resource for a project, or `[]` when the name is unknown.
 *
 * Deliberately does NOT fall back to the generic resource: a caller must be
 * able to tell "no match" from "matched the generic", and whether to fall back
 * is a call-site decision. Use `resolveEvaluationResources` for the policy.
 */
export function resourcesForProject(
	name: string | null | undefined,
): readonly EvaluationResource[] {
	if (!name) return [];
	return BY_PROJECT.get(lookupKey(name)) ?? [];
}

export interface ResolvedEvaluationResources {
	resources: readonly EvaluationResource[];
	/**
	 * True when the requested name carried "(Legacy)" and matched only after the
	 * suffix was stripped. The UI says so: a member evaluated against a
	 * superseded edition's criteria should know that is what happened.
	 */
	currentEditionNote: boolean;
	/** True when nothing matched and `resources` is the generic resource alone. */
	isGenericFallback: boolean;
}

/**
 * The whole resolution policy in one pure function, so both the project picker
 * and the commitment card share it. It lives here rather than inline in a route
 * because a route cannot be mounted in vitest — CLAUDE.md's props trap: a
 * component tested through its props cannot see a WRONG prop, and this is the
 * expression that computes them.
 */
export function resolveEvaluationResources(
	name: string | null | undefined,
): ResolvedEvaluationResources {
	const resources = resourcesForProject(name);
	if (resources.length === 0)
		return {
			resources: [GENERIC_EVALUATION_RESOURCE],
			currentEditionNote: false,
			isGenericFallback: true,
		};
	return {
		resources,
		currentEditionNote: LEGACY_SUFFIX.test(name ?? ""),
		isGenericFallback: false,
	};
}

/**
 * The index page's search. Lives here, not in the route: a route module imports
 * `getAuthContext` → `#/db`, which throws `DATABASE_URL is not set` at import,
 * so anything exported from a route is unreachable from vitest.
 *
 * Runs `normalize` over the query AND the searchable text, so punctuation drift
 * ("question and answer" vs TI's "Question-and-Answer Session") and the
 * "(Legacy)" suffix are treated exactly as the project lookup treats them. That
 * sharing IS the fix: while these were two copies, a legacy-path member
 * searching the name printed on their own agenda found nothing.
 */
export function filterEvaluationResources(
	query: string,
): readonly EvaluationResource[] {
	const q = normalize(query);
	if (!q) return EVALUATION_RESOURCES;
	return EVALUATION_RESOURCES.filter((r) =>
		normalize(
			[r.title, r.project ?? "", r.itemCode ?? "", r.part ?? ""].join(" "),
		).includes(q),
	);
}
