import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
	isInRoom,
	type MeetingRoomSearch,
	meetingHubUrlFor,
	validateMeetingRoomSearch,
} from "./meeting-hub";

const meeting = { clubKey: "mcf", meetingKey: "2026-06-25" };

describe("meetingHubUrlFor (#913)", () => {
	it("answers the absolute in-room meeting URL once the origin is known", () => {
		expect(meetingHubUrlFor(meeting, "https://gavelup.app")).toBe(
			"https://gavelup.app/club/mcf/meeting/2026-06-25?room=1",
		);
	});

	it('answers "" before the origin is known, so no QR renders yet', () => {
		expect(meetingHubUrlFor(meeting, null)).toBe("");
	});

	it('answers the bare path for a deliberately relative origin ("")', () => {
		expect(meetingHubUrlFor(meeting, "")).toBe(
			"/club/mcf/meeting/2026-06-25?room=1",
		);
	});
});

describe("isInRoom", () => {
	it("reads the number the default search parser produces, and the string", () => {
		expect(isInRoom({ room: 1 })).toBe(true);
		expect(isInRoom({ room: "1" })).toBe(true);
	});

	it("is false for anything else", () => {
		expect(isInRoom({})).toBe(false);
		expect(isInRoom({ room: 0 })).toBe(false);
		expect(isInRoom({ room: "yes" })).toBe(false);
	});
});

describe("validateMeetingRoomSearch — the SSR no-redirect contract", () => {
	it("returns the parsed search unchanged: same reference, other keys kept", () => {
		const parsed = { room: 1, from: "share" };
		expect(validateMeetingRoomSearch(parsed)).toBe(parsed);
		// Strict: `{ room: undefined }` would be a search that differs from `{}`.
		expect(validateMeetingRoomSearch({})).toStrictEqual({});
	});

	/**
	 * The redirect itself. On the server, `router.beforeLoad` rebuilds the
	 * location WITH `validateSearch` applied (`_includeValidateSearch: true`) and
	 * throws a 307 to it whenever its `publicHref` differs from the request's.
	 * This makes that exact comparison against a real router, so it fails for
	 * the reason production would — including a validator that "helpfully"
	 * keeps `room` as the string "1", which the control below shows re-serialises
	 * as `%221%22` because the default parser hands over the NUMBER 1.
	 */
	function rebuiltHref(
		validateSearch: (s: Record<string, unknown>) => MeetingRoomSearch,
		href: string,
	) {
		const rootRoute = createRootRoute();
		const meetingRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/meeting/$meetingId",
			validateSearch,
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([meetingRoute]),
			history: createMemoryHistory({ initialEntries: [href] }),
		});
		const next = router.buildLocation({
			to: router.latestLocation.pathname,
			search: true,
			params: true,
			hash: true,
			state: true,
			_includeValidateSearch: true,
		} as Parameters<typeof router.buildLocation>[0]);
		return {
			request: router.latestLocation.publicHref,
			rebuilt: next.publicHref,
		};
	}

	it("?room=1 rebuilds to the identical href, with other params intact", () => {
		const href = "/club/mcf/meeting/2026-06-25?room=1&from=share";
		const { request, rebuilt } = rebuiltHref(validateMeetingRoomSearch, href);
		expect(request).toBe(href);
		expect(rebuilt).toBe(href);
	});

	it("control: coercing room to the string '1' WOULD redirect", () => {
		const coerce = (s: Record<string, unknown>): MeetingRoomSearch => ({
			...s,
			room: "1",
		});
		const href = "/club/mcf/meeting/2026-06-25?room=1&from=share";
		const { request, rebuilt } = rebuiltHref(coerce, href);
		expect(rebuilt).not.toBe(request);
		expect(rebuilt).toContain("%221%22");
	});
});
