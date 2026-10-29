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
import { renderAsync } from "@resvg/resvg-js";
import { eq } from "drizzle-orm";
import satori from "satori";
import {
	ClubCard,
	MeetingCard,
	OG_HEIGHT,
	OG_WIDTH,
} from "#/components/og/og-card";
import { db } from "#/db";
import type { meetingStatusEnum } from "#/db/schema";
import { clubs } from "#/db/schema";
import { APP_LOCALE } from "#/lib/format";
import {
	loadClubLogoForServing,
	loadClubLogoMeta,
} from "#/server/club-logo-logic";
import { isReadableClub } from "#/server/club-readable-logic";
import { loadNextMeetingSummary } from "#/server/meetings-logic";
import { loadPublicFlyer } from "#/server/promo-logic";
// Relative on purpose: `?inline` / `?raw` are Vite suffixes on a file path.
import faviconSvg from "../../public/favicon.svg?raw";
import defaultPng from "../../public/og/default.png?inline";
import frauncesSemiBold from "../assets/og-fonts/Fraunces-SemiBold.woff?inline";
import manropeBold from "../assets/og-fonts/Manrope-Bold.woff?inline";
import manropeRegular from "../assets/og-fonts/Manrope-Regular.woff?inline";

/**
 * Bump on ANY change to the card's layout, fonts, locale or colours: it is part
 * of the hash, so every ETag and `?v=` changes and a cached old-looking card is
 * not served for the new code.
 */
export const OG_RENDERER_REVISION = 1;

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

type MeetingStatus = (typeof meetingStatusEnum.enumValues)[number];

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
	status: MeetingStatus;
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

/**
 * First 12 hex characters of a SHA-256 over the renderer revision and the
 * input, keys sorted.
 */
export function ogCardVersion(input: OgCardInput): string {
	const stable = JSON.stringify(
		Object.fromEntries(
			Object.entries({ rendererRevision: OG_RENDERER_REVISION, ...input }).sort(
				([a], [b]) => (a < b ? -1 : 1),
			),
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
export async function loadPublicMeetingCardInput(
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
export async function loadPublicClubCardInput(
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

async function toPng(element: Parameters<typeof satori>[0]): Promise<Buffer> {
	const svg = await satori(element, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: fonts(),
	});
	// `renderAsync` rasterises on libuv's thread pool: a ~500 ms render must not
	// block the single Node event loop that serves every other request.
	const image = await renderAsync(svg, {
		fitTo: { mode: "width", value: OG_WIDTH },
	});
	return image.asPng();
}

/**
 * Renders the card and returns the version of what it ACTUALLY drew. The logo
 * bytes are read once here and the version is taken from that read, so a logo
 * replaced between the input load and now cannot leave the ETag naming bytes
 * the PNG does not hold.
 */
export async function renderOgCardVersioned(
	input: OgCardInput,
): Promise<{ png: Buffer; version: string }> {
	const logo = input.logoVersion
		? await loadClubLogoForServing(input.clubId)
		: null;
	const drawn: OgCardInput = {
		...input,
		logoVersion: logo ? String(logo.updatedAt.getTime()) : null,
	};
	const logoSrc = logo
		? `data:${logo.mime};base64,${logo.bytes.toString("base64")}`
		: MARK_SRC;
	const version = ogCardVersion(drawn);
	if (drawn.kind === "meeting") {
		const where = drawn.online ? "Online" : drawn.location;
		return {
			version,
			png: await toPng(
				MeetingCard({
					view: {
						clubName: drawn.clubName,
						logoSrc,
						when: formatWhen(drawn.scheduledAt, drawn.timezone),
						theme: drawn.theme,
						where,
						word: drawn.word,
						cancelled: drawn.status === "cancelled",
					},
				}),
			),
		};
	}
	return {
		version,
		png: await toPng(
			ClubCard({
				view: {
					clubName: drawn.clubName,
					logoSrc,
					nextWhen: drawn.nextScheduledAt
						? formatWhen(drawn.nextScheduledAt, drawn.timezone)
						: null,
					nextTheme: drawn.nextTheme,
				},
			}),
		),
	};
}

export async function renderOgCard(input: OgCardInput): Promise<Buffer> {
	return (await renderOgCardVersioned(input)).png;
}

// ---------------------------------------------------------------------------
// LRU + response
// ---------------------------------------------------------------------------

export const LRU_MAX = 200;
interface Rendered {
	png: Buffer;
	version: string;
}
const lru = new Map<string, Rendered>();
/** Renders in flight, by requested version: concurrent misses share one. */
const inflight = new Map<string, Promise<Rendered>>();
/** A render that threw is not retried for this long (version -> expiry ms). */
export const FAILED_RENDER_TTL_MS = 30_000;
const failed = new Map<string, number>();

function lruGet(version: string): Rendered | undefined {
	const hit = lru.get(version);
	if (hit) {
		lru.delete(version);
		lru.set(version, hit);
	}
	return hit;
}

function lruSet(version: string, r: Rendered) {
	lru.set(version, r);
	if (lru.size > LRU_MAX) {
		const oldest = lru.keys().next().value;
		if (oldest !== undefined) lru.delete(oldest);
	}
}

export function clearOgCardCache() {
	lru.clear();
	inflight.clear();
	failed.clear();
}

export function ogCardCacheSize(): number {
	return lru.size;
}

// A card must not outlive an archive by long: the 304 path re-runs the archive
// gate (the loader), so a short max-age with `must-revalidate` bounds how long
// a browser or shared cache keeps serving an archived club's card.
const OK_CACHE = "public, max-age=300, must-revalidate";

function fallbackResponse(): Response {
	return new Response(new Uint8Array(bytesOf(defaultPng)), {
		status: 200,
		headers: {
			"content-type": "image/png",
			"cache-control": "public, max-age=300",
		},
	});
}

/** The path segments of `request.url` matched by `pattern`, or null. */
export function ogPathMatch(
	request: Request,
	pattern: RegExp,
): RegExpExecArray | null {
	return pattern.exec(new URL(request.url).pathname);
}

/**
 * The shared GET body of both endpoints. `?v=` is never read: the card always
 * shows the CURRENT state, and its ETag is the hash of that state, which is
 * the same value the page's `og:image` URL carries.
 *
 * A miss renders once per version however many requests arrive together
 * (single-flight), off the event loop (`renderAsync`). A thrown render (or a
 * throwing read) serves the static default card with a 200 and no ETag: a link
 * preview must never break.
 */
export async function respondOgCard(
	load: () => Promise<OgCardInput | null>,
	request: Request,
	render: (input: OgCardInput) => Promise<Rendered> = renderOgCardVersioned,
): Promise<Response> {
	let input: OgCardInput | null;
	try {
		input = await load();
	} catch (err) {
		console.error("[og-card] input failed", err);
		return fallbackResponse();
	}
	if (!input) return new Response("Not found.", { status: 404 });
	const key = ogCardVersion(input);
	const etag = `"${key}"`;
	const headers = {
		"cache-control": OK_CACHE,
		etag,
	};
	if (request.headers.get("if-none-match") === etag) {
		return new Response(null, { status: 304, headers });
	}
	if ((failed.get(key) ?? 0) > Date.now()) return fallbackResponse();
	try {
		let hit = lruGet(key);
		if (!hit) {
			let pending = inflight.get(key);
			if (!pending) {
				pending = render(input).finally(() => inflight.delete(key));
				inflight.set(key, pending);
			}
			hit = await pending;
			lruSet(key, hit);
		}
		return new Response(new Uint8Array(hit.png), {
			status: 200,
			headers: {
				...headers,
				// The version of the bytes actually drawn (see renderOgCardVersioned).
				etag: `"${hit.version}"`,
				"content-type": "image/png",
			},
		});
	} catch (err) {
		console.error("[og-card] render failed", err);
		failed.set(key, Date.now() + FAILED_RENDER_TTL_MS);
		if (failed.size > LRU_MAX) {
			const oldest = failed.keys().next().value;
			if (oldest !== undefined) failed.delete(oldest);
		}
		return fallbackResponse();
	}
}
