import { describe, expect, it, vi } from "vitest";

// Execute the real wrapper/validator through a minimal Start boundary adapter.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));
vi.mock("./guards", () => ({
	requireUser: vi.fn(async () => ({ id: "authenticated-admin" })),
	requireClubRole: vi.fn(async () => ({ id: "admin-membership" })),
}));
vi.mock("./upload-members-logic", () => ({
	previewMemberImport: vi.fn(),
	commitMemberImport: vi.fn(),
}));

import { requireClubRole } from "./guards";
import { commitMemberUpload, previewMemberUpload } from "./upload-members";
import {
	commitMemberImport,
	previewMemberImport,
} from "./upload-members-logic";

const clubId = "11111111-1111-4111-8111-111111111111";
describe("upload transport", () => {
	it("uses the authenticated actor for preview and commit, never supplied identity or permissions", async () => {
		const data = {
			clubId,
			csv: "csv",
			userId: "forged-user",
			actorMemberId: "forged-member",
			officerApprovals: ["signed"],
			permissions: { admin: true },
		};
		await previewMemberUpload({ data });
		expect(previewMemberImport).toHaveBeenCalledWith(
			clubId,
			"csv",
			"authenticated-admin",
		);
		await commitMemberUpload({ data });
		expect(requireClubRole).toHaveBeenCalledWith(
			"authenticated-admin",
			clubId,
			["admin"],
		);
		expect(commitMemberImport).toHaveBeenCalledWith(clubId, "csv", {
			userId: "authenticated-admin",
			officerApprovals: ["signed"],
		});
	});
	it("defaults to no approvals", async () => {
		await commitMemberUpload({ data: { clubId, csv: "csv" } });
		expect(commitMemberImport).toHaveBeenLastCalledWith(clubId, "csv", {
			userId: "authenticated-admin",
			officerApprovals: [],
		});
	});
	it("bounds approval tokens", async () => {
		await expect(async () =>
			commitMemberUpload({
				data: { clubId, csv: "csv", officerApprovals: ["x".repeat(4097)] },
			}),
		).rejects.toThrow();
	});
});
