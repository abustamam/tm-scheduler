import {
	Badge,
	Button,
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "tm-scheduler";

export function MeetingCard() {
	return (
		<Card style={{ maxWidth: 380 }}>
			<CardHeader>
				<CardTitle>Weekly Chapter Meeting</CardTitle>
				<CardDescription>
					Tuesday, July 7 · 7:00–8:30 PM · Room 204
				</CardDescription>
				<CardAction>
					<Badge variant="secondary">Open</Badge>
				</CardAction>
			</CardHeader>
			<CardContent>
				<p
					style={{
						margin: 0,
						fontSize: 14,
						color: "var(--muted-foreground)",
						lineHeight: 1.5,
					}}
				>
					Theme: “Finding Your Voice”. Three prepared speeches and Table Topics.
					2 of 7 roles still need a volunteer.
				</p>
			</CardContent>
			<CardFooter style={{ gap: 8 }}>
				<Button size="sm">Sign up</Button>
				<Button size="sm" variant="outline">
					View agenda
				</Button>
			</CardFooter>
		</Card>
	);
}

export function RoleSummary() {
	return (
		<Card style={{ maxWidth: 380 }}>
			<CardHeader>
				<CardTitle>Your upcoming roles</CardTitle>
				<CardDescription>Next 30 days</CardDescription>
			</CardHeader>
			<CardContent
				style={{ display: "flex", flexDirection: "column", gap: 10 }}
			>
				<div style={{ display: "flex", justifyContent: "space-between" }}>
					<span style={{ fontSize: 14 }}>July 7 — Evaluator</span>
					<Badge>Confirmed</Badge>
				</div>
				<div style={{ display: "flex", justifyContent: "space-between" }}>
					<span style={{ fontSize: 14 }}>July 21 — Toastmaster</span>
					<Badge variant="outline">Tentative</Badge>
				</div>
			</CardContent>
		</Card>
	);
}
