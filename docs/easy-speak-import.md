# Importing a club from Easy-Speak

One upload builds the roster and the history (#1240). The club sends a file; the
superadmin applies it. Nothing is written until Apply, and applying again adds
nothing that is already there.

## For a club

1. Install the GavelUp browser extension.
2. Sign in to Easy-Speak and press **Export** in the extension.
3. Send us the file it saves.
4. Optional: also send a spreadsheet of `name, email, phone`, one person per
   line. The export carries no email or phone by design, so this is the only way
   GavelUp learns them. Without it, members are created with no contact details
   and can add their own.

## For the superadmin

1. Create the club with its real club number, so the preview can warn if the
   bundle is for another club.
2. Open the club's import panel and upload the file.
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
never overwritten. An email another Person already holds (any club) is not set.
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
