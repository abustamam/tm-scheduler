// @vitest-environment jsdom
/**
 * The mentor bio box on the dashboard's Mentoring card (#945), driven as a
 * member drives it. What the server stores and refuses is
 * `mentor-bio.integration.test.ts`; this pins what the card shows and which
 * callback its Save fires. (`mentorship-cards.test.tsx` holds the rest of the
 * card.)
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import {
	MENTOR_BIO_LABEL,
	MentorshipCard,
	type MyMentorshipsView,
} from "./mentorship-cards";

afterEach(cleanup);

const view = (over: Partial<MyMentorshipsView> = {}): MyMentorshipsView => ({
	willingToMentor: true,
	mentorBio: null,
	mentors: [],
	mentees: [],
	...over,
});

async function renderCard(
	v: MyMentorshipsView,
	onSaveBio = vi.fn(async (_bio: string) => undefined),
) {
	await renderUnderMemoryRouter(
		<MentorshipCard
			view={v}
			onToggleWilling={vi.fn(async () => undefined)}
			onSaveBio={onSaveBio}
		/>,
	);
	return onSaveBio;
}

describe("the mentor bio box (#945)", () => {
	// protects=the bio box shows only while "willing to mentor" is checked, with
	// the stored bio in it and the new helper line, and unchecking the flag
	// elsewhere hides the box without touching the stored text;
	// fails_when=the box shows for a member who is not willing, or the flag's
	// helper still says only the VP Education sees them;
	// no_claim=that the bio survives the flag being unchecked in the database
	// (the card never sends it): the integration test holds that
	it("shows for a willing member, with their bio, and hides otherwise", async () => {
		await renderCard(view({ mentorBio: "Evaluations and contests." }));
		const box = screen.getByLabelText(MENTOR_BIO_LABEL) as HTMLTextAreaElement;
		expect(box.value).toBe("Evaluations and contests.");
		expect(box.placeholder).toBe(
			"What you can help with: Pathways, contests, leadership, evaluations…",
		);
		expect(
			screen.getByText(/Members can find you on Find a mentor/),
		).toBeTruthy();
		cleanup();
		await renderCard(view({ willingToMentor: false, mentorBio: "Kept" }));
		expect(screen.queryByLabelText(MENTOR_BIO_LABEL)).toBeNull();
	});

	// protects=the counter reads n/500 as the member types, Save is off until
	// the text differs from what is stored, and going over 500 disables Save;
	// Save sends the trimmed text, and blank sends "" (which clears);
	// fails_when=Save fires on an unchanged bio, accepts 501, or sends padding;
	// no_claim=the server-side refusal of 501 (integration test)
	it("counts, saves the trimmed text, and refuses more than 500", async () => {
		const user = userEvent.setup();
		const onSaveBio = await renderCard(view({ mentorBio: "Old" }));
		const save = screen.getByRole("button", { name: "Save" });
		expect(save.hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("3/500")).toBeTruthy();

		const box = screen.getByLabelText(MENTOR_BIO_LABEL);
		await user.clear(box);
		await user.type(box, "  New words  ");
		expect(screen.getByText("9/500")).toBeTruthy();
		await user.click(save);
		expect(onSaveBio).toHaveBeenCalledWith("New words");

		await user.clear(box);
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(onSaveBio).toHaveBeenLastCalledWith("");

		await user.click(box);
		await user.paste("z".repeat(501));
		expect(screen.getByText("501/500")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
		).toBe(true);
	});

	// protects=the card links to the Find a mentor page;
	// fails_when=the link is missing or points elsewhere;
	// no_claim=that /mentors renders (mentors.test.tsx)
	it("links to Find a mentor", async () => {
		await renderCard(view({ willingToMentor: false }));
		expect(
			screen.getByRole("link", { name: "Find a mentor" }).getAttribute("href"),
		).toBe("/mentors");
	});
});
