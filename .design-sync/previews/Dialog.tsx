import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "tm-scheduler";

export function ConfirmSignup() {
	return (
		<Dialog defaultOpen>
			<DialogTrigger asChild>
				<Button variant="outline">Sign up for a role</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Confirm your role</DialogTitle>
					<DialogDescription>
						You’re signing up as Evaluator for the July 7 meeting. We’ll send a
						reminder 24 hours before.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter showCloseButton>
					<Button>Confirm role</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
