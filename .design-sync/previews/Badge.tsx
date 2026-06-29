import { Badge } from "tm-scheduler";

export function Roles() {
	return (
		<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
			<Badge>Toastmaster</Badge>
			<Badge variant="secondary">Evaluator</Badge>
			<Badge variant="secondary">Timer</Badge>
			<Badge variant="outline">Grammarian</Badge>
		</div>
	);
}

export function Status() {
	return (
		<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
			<Badge>Confirmed</Badge>
			<Badge variant="outline">Tentative</Badge>
			<Badge variant="destructive">Cancelled</Badge>
		</div>
	);
}
