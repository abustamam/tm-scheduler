import { Input, Label } from "tm-scheduler";

export function Default() {
	return <Input placeholder="Search speakers…" style={{ maxWidth: 320 }} />;
}

export function WithLabel() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				maxWidth: 320,
			}}
		>
			<Label htmlFor="speech-title">Speech title</Label>
			<Input id="speech-title" defaultValue="Finding Your Voice" />
		</div>
	);
}

export function Disabled() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				maxWidth: 320,
			}}
		>
			<Label htmlFor="mtg">Meeting code</Label>
			<Input id="mtg" defaultValue="TM-204" disabled />
		</div>
	);
}

export function Invalid() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				maxWidth: 320,
			}}
		>
			<Label htmlFor="email">Email</Label>
			<Input id="email" aria-invalid defaultValue="not-an-email" />
		</div>
	);
}
