# Importing a club from Easy-Speak

One upload builds the roster and the history (#1240). A club's own admin runs it
from **Setup > Import from Easy-Speak** (`/admin/import-history`, #1492); a
superadmin can run the same flow from the club's page in the platform console.
Nothing is written until Apply, and applying again adds nothing that is already
there.

## For a club

Who may run it: an admin of the club (an officer with an open term counts, as it
does for the roster paste). A plain member, an admin of another club and a
former member are refused, and so is an admin of an archived club.

1. Open **Import from Easy-Speak** and install the GavelUp browser extension from
   the link on that page (Chrome or Firefox). With no link yet, ask GavelUp
   support for it.
2. Sign in to Easy-Speak and press **Export** in the extension.
3. Upload the file it saves on the same page. A club keeps its 5 most recent unapplied uploads; a sixth replaces the oldest (applied uploads are never removed).
4. Optional: paste `name, email, phone`, one person per line, into **Contacts**.
   The export carries no email or phone by design, so this is the only way
   GavelUp learns them. Without it, members are created with no contact details
   and can add their own.
5. Read the preview, resolve anyone it asks about, press **Apply import**, then
   run the **Speech requests** and **Mentor pairs** steps.

### Which Easy-Speak club

The first applied import binds the GavelUp club to its Easy-Speak club. A later
export from a different Easy-Speak club is refused at upload and at apply. Before
the first import, a club number on both sides must agree (leading zeros and
spaces ignored); if either has none the check is skipped. The first preview leads
with `Easy-Speak club <name> (#<number>) -> <club>`.

### What the import will not do for a club admin

Every write follows the rule of the equivalent manual admin edit
(`src/server/history-import-parity.guard.test.ts` lists each one). In particular
an email is filled on a linked member only while nobody has signed in as that
person and this club is their only club (#907); the preview says so, and says it
exactly as the apply will behave. An email already used by someone outside the
club is left blank with one neutral sentence, naming no club and no person.

## For the superadmin

1. Create the club with its real club number, so the upload can refuse a bundle
   for another club.
2. Open the club's import panel and upload the file, or run the same page as the
   club's admin would.
3. Optionally paste the club's contacts into **Contacts** (same format as the
   roster's Bulk import: `name, email, phone`, comma or tab separated). The
   preview re-reads them when the box loses focus.
4. Read the summary line: how many existing members are linked, how many active
   members (and officers) and former members are created, how many guests are
   added and how many erased accounts are skipped. Contact warnings are listed
   under it. Resolve anyone listed under **People to decide**: only a name that
   two or more existing members share (ambiguous) is asked about, and Apply stays
   disabled until it is decided.
5. Press **Apply import**, then **Yes, apply**.
6. Run the two follow-up steps, each its own button, after Apply: **Speech
   requests** and **Mentor pairs**. They find people through what Apply wrote.

Only a superadmin can override the club binding: after an upload or an apply is
refused for another Easy-Speak club, the console shows **Import anyway (another
Easy-Speak club)**. The apply's activity row records `overrodeClubBinding`. The
same flag from a club admin is refused before anything runs.

### What Apply does with each person

| Person | Result |
|---|---|
| Matches one existing member (exact name, then ignoring case and accents) | linked, never duplicated |
| Matches two or more | asked, Apply waits |
| On the member list, not "Inactive Member" | active member; an office in the status text also makes them an admin with an open officer term starting the day of the apply |
| On the member list as "Inactive Member" | former member, end date unknown |
| Not on the list, named in a meeting outside the guest sections | former member, end date unknown |
| Named only in guest sections | guest |
| Named exactly "Forgotten User" | skipped: an erased Easy-Speak account |

Order, first that applies: a saved answer from an earlier preview; an existing
import link for this Easy-Speak person (this is why a re-apply creates nothing,
even after someone is renamed); the erased-account rule; the roster match; the
member list; guest or former.

### Contacts

A pasted row is matched to a person being linked or created by the same name
matcher. It fills a blank email or phone only: an existing member's values are
never overwritten. An email another Person already holds is not set (the preview checks this club's members; the apply checks everyone, and says only that the address is already in use).
Two rows for one person use the first; one email on the rows of two people goes
to neither. A row that matches no one, or two people, is warned about and
applied to no one. The email check runs again inside Apply.
An email is filled only for a person with no GavelUp account who belongs to this
club alone; otherwise it is left blank for the person and the report says so
(the phone still fills).

The import does not keep the contacts text, or any email or phone from it: only
the people records carry them. Warnings name a row number and a person, never a
value.

### Undoing

Revert nothing in the database. Members an applied import created are ordinary
roster rows: end them or remove them from the roster. There is no migration.
