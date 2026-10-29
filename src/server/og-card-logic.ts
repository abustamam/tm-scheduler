// Generated og:image cards for share links (#1411): the input builders, the
// version hash, the satori + resvg renderer, the LRU and the response with its
// failure fallback. Split from the two API routes so a handler body is
// reachable from a test.
//
// PRIVACY (hard rule). The meeting page is public, its roll is members-only.
// A card's input holds ONLY the keys in `MEETING_CARD_KEYS` / `CLUB_CARD_KEYS`,
// read from `clubs`, `meetings` and the club-logo table. Nothing is read from
// people, slot assignments or attendance, and there is no count of any kind.
// `og-card-logic.test.ts` pins the key lists and the imports of THIS file.
//
// Do NOT import `next-meeting-summary-logic.ts` here: it returns role labels
// and display names. The next meeting comes from `meetings-logic`.

import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { eq } from "drizzle-orm";
import satori from "satori";
import {
	ClubCard,
	DefaultCard,
	MeetingCard,
	OG_HEIGHT,
	OG_WIDTH,
} from "#/components/og/og-card";
import { db } from "#/db";
import { clubs } from "#/db/schema";
import { APP_LOCALE } from "#/lib/format";
import faviconSvg from "../../public/favicon.svg?raw";
import defaultPng from "../../public/og/default.png?inline";
import frauncesSemiBold from "../assets/og-fonts/Fraunces-SemiBold.woff?inline";
import manropeBold from "../assets/og-fonts/Manrope-Bold.woff?inline";
import manropeRegular from "../assets/og-fonts/Manrope-Regular.woff?inline";
import { loadClubLogoForServing, loadClubLogoMeta } from "./club-logo-logic";
import { isReadableClub } from "./club-readable-logic";
import { loadNextMeetingSummary } from "./meetings-logic";
import { loadPublicFlyer } from "./promo-logic";

export const MEETING_CARD_KEYS = [
	"kind",
	"clubId",
	"meetingId",
	"clubName",
	"logoVersion",
	"scheduledAt",
	"timezone",
	"theme",
	"word",
	"location",
	"online",
	"status",
] as const;

export const CLUB_CARD_KEYS = [
	"kind",
	"clubId",
	"clubName",
	"logoVersion",
	"timezone",
	"nextScheduledAt",
	"nextTheme",
] as const;

export interface MeetingCardInput {
	kind: "meeting";
	clubId: string;
	meetingId: string;
	clubName: string;
	/** `clubs_logo.updated_at` in epoch ms, or null with no logo. */
	logoVersion: string | null;
	scheduledAt: string;
	timezone: string;
	theme: string | null;
	word: string | null;
	location: string | null;
	online: boolean;
	status: string;
}

export interface ClubCardInput {
	kind: "club";
	clubId: string;
	clubName: string;
	logoVersion: string | null;
	timezone: string;
	nextScheduledAt: string | null;
	nextTheme: string | null;
}

export type OgCardInput = MeetingCardInput | ClubCardInput;

/** First 12 hex characters of a SHA-256 over the input, keys sorted. */
export function ogCardVersion(input: OgCardInput): string {
	const stable = JSON.stringify(
		Object.fromEntries(
			Object.entries(input).sort(([a], [b]) => (a < b ? -1 : 1)),
		),
	);
	return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

// A non-uuid id is "no such club", not a Postgres cast error.
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function blankToNull(s: string | null | undefined): string | null {
	const t = s?.trim();
	return t ? t : null;
}

async function logoVersionOf(clubId: string): Promise<string | null> {
	const meta = await loadClubLogoMeta(clubId);
	return meta ? String(meta.updatedAt.getTime()) : null;
}

/** Null for an unknown or archived club, or a key naming no meeting. */
export async function loadMeetingCardInput(
	clubId: string,
	key: string,
): Promise<MeetingCardInput | null> {
	if (!UUID_RE.test(clubId)) return null;
	// `loadPublicFlyer` is the archive-gated public seam.
	const flyer = await loadPublicFlyer(clubId, key);
	if (!flyer) return null;
	const m = flyer.meeting;
	return {
		kind: "meeting",
		clubId,
		meetingId: m.id,
		clubName: flyer.club.name,
		logoVersion: await logoVersionOf(clubId),
		scheduledAt: new Date(m.scheduledAt).toISOString(),
		timezone: flyer.club.timezone,
		theme: blankToNull(m.theme),
		word: blankToNull(m.wordOfTheDay),
		location: blankToNull(m.location),
		online: m.online,
		status: m.status,
	};
}

/** Null for an unknown or archived club. */
export async function loadClubCardInput(
	clubId: string,
	now: Date = new Date(),
): Promise<ClubCardInput | null> {
	if (!UUID_RE.test(clubId)) return null;
	if (!(await isReadableClub(clubId))) return null;
	const [club] = await db
		.select({ name: clubs.name, timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) return null;
	const [summary, logoVersion] = await Promise.all([
		loadNextMeetingSummary(clubId, now),
		logoVersionOf(clubId),
	]);
	const next = summary.nextMeeting;
	return {
		kind: "club",
		clubId,
		clubName: club.name,
		logoVersion,
		timezone: club.timezone,
		nextScheduledAt: next ? next.scheduledAt.toISOString() : null,
		nextTheme: next ? blankToNull(next.theme) : null,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function bytesOf(dataUrl: string): Buffer {
	return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

let fontsCache:
	| { name: string; data: Buffer; weight: 400 | 600 | 700; style: "normal" }[]
	| null = null;
function fonts() {
	fontsCache ??= [
		{
			name: "Fraunces",
			data: bytesOf(frauncesSemiBold),
			weight: 600,
			style: "normal",
		},
		{
			name: "Manrope",
			data: bytesOf(manropeRegular),
			weight: 400,
			style: "normal",
		},
		{
			name: "Manrope",
			data: bytesOf(manropeBold),
			weight: 700,
			style: "normal",
		},
	];
	return fontsCache;
}

const MARK_SRC = `data:image/svg+xml;base64,${Buffer.from(faviconSvg).toString("base64")}`;

function formatWhen(iso: string, timeZone: string): string {
	return new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	}).format(new Date(iso));
}

async function logoSrcFor(clubId: string, logoVersion: string | null) {
	if (!logoVersion) return MARK_SRC;
	const logo = await loadClubLogoForServing(clubId);
	if (!logo) return MARK_SRC;
	return `data:${logo.mime};base64,${logo.bytes.toString("base64")}`;
}

async function toPng(element: Parameters<typeof satori>[0]): Promise<Buffer> {
	const svg = await satori(element, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: fonts(),
	});
	return new Resvg(svg, { fitTo: { mode: "width", value: OG_WIDTH } })
		.render()
		.asPng();
}

export async function renderOgCard(input: OgCardInput): Promise<Buffer> {
	const logoSrc = await logoSrcFor(input.clubId, input.logoVersion);
	if (input.kind === "meeting") {
		const where = input.online ? "Online" : input.location;
		return toPng(
			MeetingCard({
				view: {
					clubName: input.clubName,
					logoSrc,
					when: formatWhen(input.scheduledAt, input.timezone),
					theme: input.theme,
					where,
					word: input.word,
					cancelled: input.status === "cancelled",
				},
			}),
		);
	}
	return toPng(
		ClubCard({
			view: {
				clubName: input.clubName,
				logoSrc,
				nextWhen: input.nextScheduledAt
					? formatWhen(input.nextScheduledAt, input.timezone)
					: null,
				nextTheme: input.nextTheme,
			},
		}),
	);
}

/** Renders `public/og/default.png`; used once to produce it, and by its test. */
export async function renderDefaultCard(): Promise<Buffer> {
	return toPng(DefaultCard({ markSrc: MARK_SRC }));
}

// ---------------------------------------------------------------------------
// LRU + response
// ---------------------------------------------------------------------------

const LRU_MAX = 200;
const lru = new Map<string, Buffer>();

function lruGet(version: string): Buffer | undefined {
	const hit = lru.get(version);
	if (hit) {
		lru.delete(version);
		lru.set(version, hit);
	}
	return hit;
}

function lruSet(version: string, png: Buffer) {
	lru.set(version, png);
	if (lru.size > LRU_MAX) {
		const oldest = lru.keys().next().value;
		if (oldest !== undefined) lru.delete(oldest);
	}
}

export function clearOgCardCache() {
	lru.clear();
}

const OK_CACHE = "public, max-age=3600";

function fallbackResponse(): Response {
	return new Response(new Uint8Array(bytesOf(defaultPng)), {
		status: 200,
		headers: {
			"content-type": "image/png",
			"cache-control": "public, max-age=300",
		},
	});
}

/**
 * The shared GET body of both endpoints. `?v=` is never read: the card always
 * shows the CURRENT state, and its ETag is the hash of that state, which is
 * the same value the page's `og:image` URL carries.
 *
 * A thrown render (or a throwing read) serves the static default card with a
 * 200 and no ETag: a link preview must never break.
 */
export async function respondOgCard(
	load: () => Promise<OgCardInput | null>,
	request: Request,
): Promise<Response> {
	let input: OgCardInput | null;
	try {
		input = await load();
	} catch (err) {
		console.error("[og-card] input failed", err);
		return fallbackResponse();
	}
	if (!input) return new Response("Not found.", { status: 404 });
	const version = ogCardVersion(input);
	const etag = `"${version}"`;
	const headers = {
		"cache-control": OK_CACHE,
		etag,
	};
	if (request.headers.get("if-none-match") === etag) {
		return new Response(null, { status: 304, headers });
	}
	try {
		let png = lruGet(version);
		if (!png) {
			png = await renderOgCard(input);
			lruSet(version, png);
		}
		return new Response(new Uint8Array(png), {
			status: 200,
			headers: { ...headers, "content-type": "image/png" },
		});
	} catch (err) {
		console.error("[og-card] render failed", err);
		return fallbackResponse();
	}
}
