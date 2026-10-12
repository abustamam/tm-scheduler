import { describe, expect, it } from "vitest";
import { mayShowSpeechLogEdit } from "./speech-log-edit";

describe("mayShowSpeechLogEdit", () => {
	it("shows for an admin or officer, whoever the speaker is", () => {
		expect(
			mayShowSpeechLogEdit({
				viewerIsAdmin: true,
				viewerUserId: "u1",
				memberUserId: "u2",
			}),
		).toBe(true);
		expect(
			mayShowSpeechLogEdit({
				viewerIsAdmin: true,
				viewerUserId: "u1",
				memberUserId: null,
			}),
		).toBe(true);
	});

	it("shows for the speaker themselves", () => {
		expect(
			mayShowSpeechLogEdit({
				viewerIsAdmin: false,
				viewerUserId: "u1",
				memberUserId: "u1",
			}),
		).toBe(true);
	});

	it("hides from a plain member viewing someone else, and never matches two nulls", () => {
		expect(
			mayShowSpeechLogEdit({
				viewerIsAdmin: false,
				viewerUserId: "u1",
				memberUserId: "u2",
			}),
		).toBe(false);
		expect(
			mayShowSpeechLogEdit({
				viewerIsAdmin: false,
				viewerUserId: null,
				memberUserId: null,
			}),
		).toBe(false);
		expect(
			mayShowSpeechLogEdit({
				viewerIsAdmin: false,
				viewerUserId: "u1",
				memberUserId: null,
			}),
		).toBe(false);
	});
});
