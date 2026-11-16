// What a role write with `expectedHolder` answers instead of throwing (#1638).
// Types and constants only, so `slots.ts` and `slots-logic.ts` share one copy
// and a test that mocks `slots-logic` does not lose it.

/** What an expected-holder write answers. `ok` covers an applied write AND an
 *  already-applied one; a skip is a normal answer, not an error. */
export type ExpectedHolderResult =
	| { ok: true }
	| {
			ok: false;
			reason: "holder-changed";
			/** Who holds the slot now (members and guests alike); null when nobody
			 *  does, or when the holder's name could not be read. */
			currentHolderName: string | null;
			/** Whether anyone holds the slot now. Tells "kept someone" apart from
			 *  "was cleared online" when the holder's name is null. */
			holderPresent: boolean;
	  }
	| {
			ok: false;
			reason: "slot-gone";
			/** Always null: nothing about the club or its holder is revealed. */
			currentHolderName: null;
	  };

export const SLOT_GONE = {
	ok: false,
	reason: "slot-gone",
	currentHolderName: null,
} as const satisfies ExpectedHolderResult;
