import { createStart } from "@tanstack/react-start";
import { agendaChangedMiddleware } from "#/lib/agenda-live";

// Every server fn passes through this instance's global middleware (#1637):
// the Present deck refreshes itself when another tab saves anything.
export const startInstance = createStart(() => ({
	functionMiddleware: [agendaChangedMiddleware],
}));
