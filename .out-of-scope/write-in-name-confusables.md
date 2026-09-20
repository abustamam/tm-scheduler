# Folding look-alike characters in write-in candidate names

We do not normalize away Unicode confusables when grouping write-in ballot
names. `writeInKey` stays case-folded and whitespace-collapsed, and nothing
more.

## Why this is out of scope

The reported gap is real: "Bоb Smith" with a Cyrillic `о` (U+043E) keys
differently from "Bob Smith", so it misses a Vote Counter's disqualification
ruling and renders as a fresh tappable candidate.

Closing it costs more than it saves. NFKC does not fix it — U+043E is a
distinct letter, not a compatibility variant, so a normalization pass leaves the
reported case exactly as it is. An actual fix needs a UTS #39 confusables
mapping (a dependency, and ~6k mappings applied to every write-in comparison in
the product, not just disqualified ones) or a mixed-script rule, which is a
rule about whose names are acceptable in a club whose members' names are not
all Latin.

Against that: the attacker is someone sitting in the meeting typing a homoglyph
into a ballot. The blast radius is one meeting's ballot in one category. The
ruling is visible to the room as it happens, and the Vote Counter can rule the
variant out too — the disqualification console is open to them for as long as
the vote is. The honour-system model this product runs on (ADR-0010, and the
`fill a blank` rule that amends it in ADR-0026) already assumes the room is not
adversarial in this way.

Changing `writeInKey` also changes #582's write-in dedup grouping, which exists
to stop a free-text ballot splitting one person's votes across spellings. So a
fold traded against a real, in-use behaviour for a threat nobody has reported
hitting.

## What covers the need

The Vote Counter can disqualify the look-alike entry as a second ruling, from
the same console, during the same vote. Write-ins render the first spelling
cast, so a variant is visible beside the original rather than hidden.

`setAward` consulting disqualifications (#786) closes the harder half of the
same family — a ruled-out candidate reaching `meeting_awards`, the minutes, the
emailed minutes and the public minutes PDF. That one is enforcement, not
normalization, and it is being fixed.

## Reopen only as

A club actually hitting it, or the product acquiring a confusables dependency
for another reason — at which point applying it here is nearly free. A
mixed-script *warning* on the ballot (not a rejection, not a silent fold) would
also be reconsiderable if write-in vote-splitting turns out to be a real
complaint.

## Prior requests

- #752 — first reported, under "Also worth deciding alongside"
- #766 — split out and closed wontfix 2026-09-18
