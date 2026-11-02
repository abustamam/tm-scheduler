// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEETING_ALREADY_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { useMeetingLifecycle } from "./use-meeting-lifecycle";

const invalidate = vi.fn(async () => {});
const navigate = vi.fn(async (_a: unknown) => {});
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate, navigate }),
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
	toast: { success: (...a: unknown[]) => toastSuccess(...a) },
}));
const showWriteError = vi.fn();
vi.mock("#/components/write-error-toast", () => ({
	showWriteError: (...a: unknown[]) => showWriteError(...a),
}));
const fns = {
	applyTemplateToMeeting: vi.fn(async (_a: unknown) => ({})),
	listTemplatesForClub: vi.fn(async (_a: unknown) => [{ id: "t1" }]),
	previewTemplateForMeeting: vi.fn(async (_a: unknown) => ({ preview: true })),
	cancelMeeting: vi.fn(async (_a: unknown) => ({})),
	completeMeeting: vi.fn(async (_a: unknown) => ({})),
	reopenMeeting: vi.fn(async (_a: unknown) => ({})),
	restoreMeeting: vi.fn(async (_a: unknown) => ({})),
	addRoleSlot: vi.fn(async (_a: unknown) => ({})),
};
vi.mock("#/server/meeting-templates", () => ({
	applyTemplateToMeeting: (a: unknown) => fns.applyTemplateToMeeting(a),
	listTemplatesForClub: (a: unknown) => fns.listTemplatesForClub(a),
	previewTemplateForMeeting: (a: unknown) => fns.previewTemplateForMeeting(a),
}));
vi.mock("#/server/meetings", () => ({
	cancelMeeting: (a: unknown) => fns.cancelMeeting(a),
	completeMeeting: (a: unknown) => fns.completeMeeting(a),
	reopenMeeting: (a: unknown) => fns.reopenMeeting(a),
	restoreMeeting: (a: unknown) => fns.restoreMeeting(a),
}));
vi.mock("#/server/slots", () => ({
	addRoleSlot: (a: unknown) => fns.addRoleSlot(a),
}));

const base = {
	meetingId: "m1",
	meetingClubId: "c1",
	clubKey: "club",
	meetingKeyParam: "2026-11-02",
	urlKey: "uuid-1",
	noticeRequested: false,
	cancelled: false,
	effectiveCanManage: true,
};
const setup = (over: Partial<typeof base> = {}) =>
	renderHook(() => useMeetingLifecycle({ ...base, ...over }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useMeetingLifecycle", () => {
	it("adds a role, closes the sheet and refreshes", async () => {
		const { result } = setup();
		act(() => result.current.setAddRoleOpen(true));
		await act(() => result.current.doAddRole("rd1"));
		expect(fns.addRoleSlot).toHaveBeenCalledWith({
			data: { meetingId: "m1", roleDefinitionId: "rd1" },
		});
		expect(result.current.addRoleOpen).toBe(false);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("routes a failed write through showWriteError and clears the busy state", async () => {
		fns.completeMeeting.mockRejectedValueOnce(new Error("boom"));
		const { result } = setup();
		await act(() => result.current.doComplete());
		expect(showWriteError).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
		expect(result.current.lifecycleAction).toBeNull();
	});

	it("completes, reopens and restores with the meeting id", async () => {
		const { result } = setup();
		await act(() => result.current.doComplete());
		await act(() => result.current.doReopen());
		await act(() => result.current.doRestore());
		for (const f of [
			fns.completeMeeting,
			fns.reopenMeeting,
			fns.restoreMeeting,
		]) {
			expect(f).toHaveBeenCalledWith({ data: { meetingId: "m1" } });
		}
		expect(invalidate).toHaveBeenCalledTimes(3);
	});

	it("cancels in place when the URL already carries the canonical key, then opens the notice", async () => {
		const { result } = setup({ meetingKeyParam: "uuid-1" });
		act(() => result.current.setCancelConfirmOpen(true));
		await act(() => result.current.doCancel());
		expect(fns.cancelMeeting).toHaveBeenCalledWith({
			data: { meetingId: "m1" },
		});
		expect(navigate).not.toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(result.current.cancelConfirmOpen).toBe(false);
		expect(result.current.noticeOpen).toBe(true);
	});

	it("cancels from a date URL by replacing it with the uuid notice URL", async () => {
		const { result } = setup();
		await act(() => result.current.doCancel());
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				replace: true,
				href: expect.stringContaining("uuid-1"),
			}),
		);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("treats 'already cancelled' as success with its own sentence", async () => {
		fns.cancelMeeting.mockRejectedValueOnce(
			new Error(MEETING_ALREADY_CANCELLED_MESSAGE),
		);
		const { result } = setup({ meetingKeyParam: "uuid-1" });
		await act(() => result.current.doCancel());
		expect(showWriteError).not.toHaveBeenCalled();
		expect(toastSuccess).toHaveBeenCalledWith(
			"This meeting was already cancelled. Nothing has been sent.",
		);
		expect(result.current.noticeOpen).toBe(true);
	});

	it("opens the notice from ?notice=1 only for a manager on a cancelled meeting", () => {
		expect(
			setup({ noticeRequested: true, cancelled: true }).result.current
				.noticeOpen,
		).toBe(true);
		expect(
			setup({ noticeRequested: true, cancelled: false }).result.current
				.noticeOpen,
		).toBe(false);
		expect(
			setup({
				noticeRequested: true,
				cancelled: true,
				effectiveCanManage: false,
			}).result.current.noticeOpen,
		).toBe(false);
	});

	it("opens the meeting-type dialog only after the list loaded, and reports a failed load", async () => {
		const { result } = setup();
		await act(() => result.current.openTemplateDialog());
		expect(fns.listTemplatesForClub).toHaveBeenCalledWith({
			data: { clubId: "c1" },
		});
		expect(result.current.templateOpen).toBe(true);
		const failing = setup();
		fns.listTemplatesForClub.mockRejectedValueOnce(new Error("x"));
		await act(() => failing.result.current.openTemplateDialog());
		expect(failing.result.current.templateOpen).toBe(false);
		expect(showWriteError).toHaveBeenCalledTimes(1);
	});

	it("previews and applies a template for this meeting, refreshing after the apply", async () => {
		const { result } = setup();
		await act(async () => {
			await result.current.loadTemplatePreview("t1");
		});
		expect(fns.previewTemplateForMeeting).toHaveBeenCalledWith({
			data: { meetingId: "m1", templateId: "t1" },
		});
		await act(() => result.current.applyTemplate(null));
		expect(fns.applyTemplateToMeeting).toHaveBeenCalledWith({
			data: { meetingId: "m1", templateId: null },
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("closes the word-of-the-day and details dialogs on save and refreshes", async () => {
		const { result } = setup();
		act(() => {
			result.current.setWodOpen(true);
			result.current.setMetaOpen(true);
		});
		await act(() => result.current.onWodSaved());
		await act(() => result.current.onMetaSaved());
		expect(result.current.wodOpen).toBe(false);
		expect(result.current.metaOpen).toBe(false);
		expect(invalidate).toHaveBeenCalledTimes(2);
	});
});
