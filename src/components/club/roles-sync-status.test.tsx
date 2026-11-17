// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RolesSyncStatus } from "#/components/club/roles-sync-status";
import type { SyncStatusProps } from "#/components/club/sync-status";

const idle: SyncStatusProps = {
	online: true,
	queueCount: 0,
	draining: false,
	syncError: null,
	justSynced: false,
	onRetry: () => {},
};

describe("RolesSyncStatus (#1651)", () => {
	afterEach(() => cleanup());

	it("a member offline with one queued change sees the pending line reading 1", () => {
		const { getByText } = render(
			<RolesSyncStatus
				shell
				sync={{ ...idle, online: false, queueCount: 1 }}
			/>,
		);
		getByText(/1 change saved on this device/);
	});

	it("a member with held role changes sees the held line", () => {
		const { getByText } = render(
			<RolesSyncStatus
				shell
				sync={{ ...idle, heldCount: 2, onDiscardHeld: () => {} }}
			/>,
		);
		getByText(/2 role changes on this device are waiting/);
	});

	it("a signed-out visitor sees nothing, even with a queue, held ops or an error", () => {
		for (const sync of [
			{ ...idle, online: false, queueCount: 3 },
			{ ...idle, heldCount: 2, onDiscardHeld: () => {} },
			{ ...idle, syncError: "boom" },
		]) {
			const { container } = render(
				<RolesSyncStatus shell={false} sync={sync} />,
			);
			expect(container.textContent).toBe("");
			cleanup();
		}
	});

	it("online with an empty queue renders nothing", () => {
		const { container } = render(<RolesSyncStatus shell sync={idle} />);
		expect(container.textContent).toBe("");
	});
});
