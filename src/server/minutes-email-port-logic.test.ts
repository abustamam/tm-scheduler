import { describe, expect, it, vi } from "vitest";

// The port used to carry a `renderMinutesPdf` member that asked for the GUEST
// view (#529), because GavelUp attached that PDF to an email whose default list
// includes self-registered guests. Since #903 GavelUp sends nothing: the officer
// downloads the guest copy from the PDF route (`?view=guests`, pinned in
// `minutes-pdf-route.integration.test.ts`) and attaches it themselves. So the
// port renders nothing, and the #529 argument now lives on that route.
//
// `loadRecipients` itself is exercised against a real database in
// `minutes-email.integration.test.ts`.

vi.mock("#/db", () => ({ db: {} }));

const { createMinutesEmailPort } = await import("./minutes-email-port-logic");

describe("minutes email port (#903)", () => {
	it("only loads recipients — it renders no PDF", () => {
		expect(Object.keys(createMinutesEmailPort())).toEqual(["loadRecipients"]);
	});
});
