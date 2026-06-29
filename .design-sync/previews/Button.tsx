import { CalendarPlus, Check } from "lucide-react";
import { Button } from "tm-scheduler";

export function Variants() {
	return (
		<div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
			<Button>Schedule meeting</Button>
			<Button variant="secondary">Save draft</Button>
			<Button variant="outline">Reschedule</Button>
			<Button variant="ghost">Skip role</Button>
			<Button variant="destructive">Cancel meeting</Button>
			<Button variant="link">View agenda</Button>
		</div>
	);
}

export function Sizes() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				flexWrap: "wrap",
				gap: 12,
			}}
		>
			<Button size="sm">Small</Button>
			<Button>Default</Button>
			<Button size="lg">Large</Button>
		</div>
	);
}

export function WithIcon() {
	return (
		<div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
			<Button>
				<CalendarPlus />
				Add to calendar
			</Button>
			<Button variant="secondary">
				<Check />
				Confirm role
			</Button>
		</div>
	);
}

export function Disabled() {
	return <Button disabled>Sign up (full)</Button>;
}
