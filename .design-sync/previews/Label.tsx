import { Input, Label } from "tm-scheduler";

export function FieldLabel() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				maxWidth: 320,
			}}
		>
			<Label htmlFor="role">Meeting role</Label>
			<Input id="role" placeholder="e.g. Toastmaster of the Day" />
		</div>
	);
}

export function WithCheckbox() {
	return (
		<Label htmlFor="remind">
			<input id="remind" type="checkbox" defaultChecked />
			Remind me the day before
		</Label>
	);
}
