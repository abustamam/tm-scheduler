# Easy-Speak fixtures

Pages for the Easy-Speak export's parser and walk tests (#1047). **This repo is public.**

They were saved from a real club's Easy-Speak pages while signed in as a member, cut down to the
markup the parsers read, and rewritten: every person name, Easy-Speak username and person id, every
phone number and email, the club's name, number, venue, address, district and web address, and the
online-meeting link are replaced with fakes. `fake-names.json` is the only list of names that may
appear; `easy-speak-fixtures.test.ts` fails if any other name, a person id outside `900001-900999`,
or a phone outside `(555) 010-xxxx` shows up in a fixture. A name in plain text (an introduction, a theme, an unlinked chart cell) is caught the same way: every run of two or more capitalised words must be a fake name or a phrase in `non-person-phrases.json` (headings, roles, Pathways projects, the fixture club's fake places, speech titles). Never add a person's name there. Do not copy a saved page in as it is.

| File | Source |
| --- | --- |
| `meeting-list.html`, `meeting-upcoming.html`, `meeting-completed.html`, `speech-list.html`, `member-list.html`, `club-data.html`, `chart-1-role-history.html`, `chart-4-roles-by-member.html`, `chart-8-mentors.html` | Saved pages, cut down and anonymised |
| `meeting-table-topics.html` | **Hand-built.** No saved meeting records Table Topics speakers; this is the empty block's markup with two rows added. The row shape is a guess |
| `speech-request-intro.html` | A saved request-form popup, cut down and anonymised, then **hand-edited**: the saved page was a blank new-request form, so the speech id, title and introduction were filled in. The popup has no site header and names no viewer; only the hidden `cached_user` and `cached_club` inputs identify the session |
| `chart-7-visitors-introduced.html` | **Hand-built.** A member sees this chart with a header and no rows; the row shape is a guess |
| `my-evaluations.html`, `my-evaluations.json`, `evaluation-501.json`, `evaluation-502.json` | **Hand-built** from the page's own script (`/api/v1/evaluations.php/...`); the saved page's list was empty |
| `non-person-phrases.json` | The allow-list for the plain-text name guard: non-person phrases only |
| `bundle.expected.json` | Produced by `easy-speak-walk.test.ts` from the files above; parsed with the zod schema in `src/lib/easy-speak-bundle.test.ts` |

Hand edits inside the saved pages: one guest per category has a reply, one role is vacant, the viewer
is the 1st speaker of the upcoming meeting (so the speech list's own request links to it), one member
"Wants Mentee?", and the member and club pages carry `(555) 010-xxxx` in their contact columns.

`UPDATE_FIXTURES=1 bunx vitest run lib/easy-speak-walk.test.ts` rewrites `bundle.expected.json`. Read
the diff: it is the contract's only worked example.

## A live Easy-Speak failure ships its page

A fix prompted by a live Easy-Speak failure commits the offending page, anonymised, in the same PR,
with a test that fails without the fix (#1252). The export saves every page it fetched to
`easy-speak-<club>-<date>-pages.json`; that archive is raw, so **never commit it or a page from it**.

```bash
cd extension
bun scripts/easy-speak-fixture-from-archive.ts <archive.json> --list
bun scripts/easy-speak-fixture-from-archive.ts <archive.json> --page <index|url-part> \
    --out <name>.html [--name "Real Name"]... [--term "Real Club Name"]... [--dry-run]
```

The script strips scripts, styles and comments, swaps linked people, the viewer and the club for
fakes and the guard's ranges, and runs the same checks as `easy-speak-fixtures.test.ts`
(`fixtureViolations` in `easy-speak-test-kit.ts`). It refuses to write a page that fails them and
prints what is left: name a person in plain text with `--name`, a club name, venue or address with
`--term`. Never add an allow-list entry to make a page pass. **The guard is a net, not a gate**: it
catches the shapes of real data it knows (names and ids in text and in every attribute, phones, emails, usernames, the club's ids, anything
you named), not every shape. A human reads the whole generated file before committing it. Add a row to the table above, then write the test with `replay` from the test kit:

```ts
const r = replay({ "/request_speech.php?s=123": "speech-request-regression.html" });
await expect(r.run()).resolves.toBeDefined(); // fails without the fix
```

`replay` serves the named fixtures in place of the usual pages, for a path or a path plus the query
parameters given, and runs the whole walk. Run `UPDATE_FIXTURES=1 bunx vitest run
lib/easy-speak-walk.test.ts` only if the fixture changes `bundle.expected.json` on purpose.
