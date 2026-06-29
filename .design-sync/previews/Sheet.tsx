import {
	Button,
	Input,
	Label,
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "tm-scheduler";

export function EditMeeting() {
	return (
		<Sheet defaultOpen>
			<SheetTrigger asChild>
				<Button variant="outline">Edit meeting</Button>
			</SheetTrigger>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>Edit meeting details</SheetTitle>
					<SheetDescription>
						Update the schedule and theme for this chapter meeting.
					</SheetDescription>
				</SheetHeader>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 12,
						padding: "0 16px",
					}}
				>
					<div
						style={{ display: "flex", flexDirection: "column", gap: 6 }}
					>
						<Label htmlFor="theme">Theme</Label>
						<Input id="theme" defaultValue="Finding Your Voice" />
					</div>
					<div
						style={{ display: "flex", flexDirection: "column", gap: 6 }}
					>
						<Label htmlFor="room">Room</Label>
						<Input id="room" defaultValue="204" />
					</div>
				</div>
				<SheetFooter>
					<Button>Save changes</Button>
					<SheetClose asChild>
						<Button variant="outline">Cancel</Button>
					</SheetClose>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
