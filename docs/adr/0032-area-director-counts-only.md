# ADR-0032: An Area Director reads counts, and nothing else

Status: Accepted

Relates to: ADR-0016 (platform superadmin; section 4, "no ambient cross-club bypass"), ADR-0020
(impersonation), ADR-0024 (archived clubs), ADR-0027 (the OAuth connector), #1115 (the series),
#1116 (the area hierarchy and `isCurrentTerm`), #1117 (`loadAreaHealth`), #1118 (the club notice),
#1119 (this change).

## Context

Every authorization decision in the app was per club until now. ADR-0016 section 4 recorded the
rule that kept it so: no ambient cross-club bypass. Not even a superadmin satisfies a club guard;
a superadmin reaches a club's records only through a console surface that is gated on its own, or
through an explicit, time-boxed impersonation session.

An Area Director oversees the clubs in one area and needs to see how each is doing: whether it
meets, whether its roles fill, who is on the officer list in number, whether dues are coming in.
That is the first reader in the app that crosses clubs for someone who is not a superadmin, and
the first that does so by role rather than by membership.

## Decision

### The role grants these counts and nothing else

A user with a CURRENT Area Director term on an area may call `getAreaHealth` for that area
(`src/server/area-health.ts`). It returns `AreaHealth` (`src/lib/area-health.ts`): per club, six
numbers (counts, rates and dates) or "not tracked". It names no person. `area-health-pii.guard.test.ts`
holds that at the loader.

The role changes no club guard and no public reader. Through every one of them a director who is
not a member of a club gets what a signed-out visitor gets, no more and no less: the club's admin
and member pages and its session-gated server fns refuse them as they refuse any stranger, and a
public reader (the roster a guest picks their name from, `listMembers`) answers them as it answers
anyone. `area-guards.integration.test.ts` calls the club guards and a public reader as a director and
as a user with no term and requires identical answers. What the role adds is the area view and
nothing beside it: the counts `getAreaHealth` returns, and the area's own list of its clubs (below).

### An archived club is the area's record, not GavelUp's

The area's club list (`area_clubs`) is the district's record of the clubs it oversees. It keeps its
own copy of each club's name and number, written when the club was placed in the area and not kept
in sync. ADR-0024's takedown covers GavelUp's copy of a club: its page, its roster, its name and its
number as GavelUp serves them. It does not reach into the district's record, and it must not be
announced by it. So the area view reads an archived club the way it reads a club that never joined
GavelUp: the area's stored name and number, the status "not on GavelUp", and no figures. The loader
(`loadAreaHealth`) uses the club's live name and number only for a live club, and the payload
carries no archived status at all, so a director cannot tell a taken-down club from one that was never
on GavelUp, and the takedown itself is not disclosed. A club renamed after it was placed shows the
area's copy, not the new name.

### The guard lives outside `guards.ts`

`requireAreaDirector(userId, areaId)` is in `src/server/area-guards.ts`, not beside the club
guards. A guard that cannot be reached from a club guard cannot widen one. `requireMembership`,
`requireClubRole`, `requireClubViewAccess`, `requireClubAdminView`, `club-readable-logic.ts` and
`meeting-authz-logic.ts` never mention `area_directors` or the area guard, and
`area-access.guard.test.ts` fails if one does. The one import between the two files runs from the
area guard to `guards.ts`, for the refusal message, and never the other way.

### "Current" is one predicate, asked every time

A term is current when it is open AND its area's division is in the current program year
(`isCurrentTerm`, `src/server/area-terms-logic.ts`, #1116). The guard and the auth context both
use it and neither restates it: a second copy could let the nav offer an area the guard refuses,
or the reverse. Nothing is cached. Ending a term in the console removes access on the next
request; a past year's term stops counting on July 1 without anyone ending it.

### Superadmin does not pass it

A superadmin with no term is refused by `getAreaHealth`, exactly as ADR-0016 section 4 refuses a
superadmin a club guard. They read the same numbers through `previewConsoleArea` (`src/server/areas.ts`),
the console's "Preview as Area Director", which is gated on `requireSuperadmin` and runs the same
loader. A director is refused the preview, which is the console's, not the role's.

### No MCP access

The connector (`/api/mcp`, ADR-0027) has no tool that reads area data, and no file under
`src/server/mcp/` may import an area module: the guard, the terms, the health loader or the area
server fns. `area-access.guard.test.ts` sweeps the directory. A personal token or an OAuth grant
for a director therefore reads exactly what it did before the role existed.

## What ADR-0016 section 4 does and does not cover now

Section 4 still holds for every CLUB guard: no role, superadmin or director, satisfies one by
being that role. What it no longer says is that nothing in the app reads across clubs without a
superadmin's session. One reader does: `getAreaHealth`, for a director, on their own area, and it
returns counts. A new cross-club reader needs its own ADR, not a line in this one; "an Area
Director may now see X about a club" is a change to this decision, and the test that keeps the
role small is the place to say so.

## Consequences

- A club-less Area Director has somewhere to go. `_authed.tsx` renders `/area/<id>` in a minimal
  frame instead of `NoClubScreen` (`src/lib/clubless-routes.ts`), and `NoClubScreen` offers "Go to
  Area C3". The same rule opens `/superadmin` to a club-less superadmin, whose "Go to Superadmin"
  button used to land on `NoClubScreen` again. A frame is not a grant: each page keeps its own gate.
- `getAuthContext` returns `areas` (id and label) for the user's current terms, which is what the
  shell's "Area C3" entries read. Everyone else gets an empty list.
- Rollback is a revert; there is no schema change. Ending every term in the console also removes
  all access at once.
