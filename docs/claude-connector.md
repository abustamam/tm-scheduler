# Using GavelUp from Claude

GavelUp has an MCP server at `https://gavelup.app/api/mcp`. Connect Claude to it and you can
run your club from a chat — "what's on Thursday's agenda?", "Dana wants to speak at the next
meeting", "here's a photo of last night's guest book" — on the web, the desktop app, or your
phone.

There are two ways in, and they reach the same seven tools with the same authority:

| From | How it signs in | Set up by |
|---|---|---|
| **claude.ai** (web, desktop, iOS, Android) | OAuth: you sign in to GavelUp and approve the connection | The connector, once per Claude account |
| **Claude Code** (your terminal) | A personal `tmk_` token pasted into a header | You, from `/me` |

What either one can do is exactly what **you** can do: it acts in every club where you are an
admin or hold an open officer term, and nowhere else. A plain member who connects gets nothing
to act on. Every write is credited to you, the same as if you had made it in the app.

---

## Connecting claude.ai

You need a GavelUp account that is an admin or officer of a club, and the connector's **client
ID and client secret** from the maintainer (see [For the maintainer](#for-the-maintainer)
below — claude.ai has no way to register itself with GavelUp yet).

1. In claude.ai, open **Settings → Connectors → Add custom connector**.
2. **URL:** `https://gavelup.app/api/mcp`
3. Open **Advanced settings** and paste the **client ID** and **client secret**.
4. Click **Add**, then **Connect**. claude.ai opens GavelUp:
   - If you are not signed in, enter your email and open the magic link. **If the link opens in a
     different browser from the one you started in, finish there** — the first tab will not move
     on by itself. That is expected, not a failure.
   - You land on **Connect claude.ai?** Check the "Signed in as …" line is the account you mean
     to connect, then **Approve**.
5. You are sent back to claude.ai, connected.

Connectors added on the web appear in the Claude phone and desktop apps automatically. There is
nothing to set up on the phone.

**Declining** is safe: nothing is connected, and "Return to the app" tells Claude so. If you had
already connected before, declining a second request does not disconnect the first.

## What you can ask

Turn the connector on in a chat (the tools icon), then just ask. Claude picks the tool.

| Tool | Reads or writes | Good for |
|---|---|---|
| `whoami` | reads | "Which clubs can you manage for me?" — start here if Claude seems lost |
| `list_meetings` | reads | "What meetings do we have coming up?" |
| `get_agenda` | reads | "What's on the agenda for our next meeting? Which roles are open?" |
| `find_people` | reads | "Find Dana on our roster." Guest emails and phones come back **masked** |
| `assign_roles` | **writes immediately** | "Put Dana in the Speaker 2 slot", "clear the Timer role" |
| `upsert_agendas` | writes nothing — gives you a link | "Set the themes for October's meetings" |
| `record_guest_book` | writes nothing — gives you a link | "Here's a photo of last night's guest book" |

**Know which tools write, and how:**

- **`assign_roles` changes the agenda the moment Claude calls it.** It checks everything first —
  a locked meeting, a duplicate slot, someone not on the roster — and applies the whole batch or
  none of it, but there is no second "are you sure" from GavelUp. Keep Claude's tool permission
  for this connector on **ask** (the default) so *you* approve each call, and read what it is
  about to assign before you do. A wrong assignment is undone on the agenda page like any other.
- **`upsert_agendas` and `record_guest_book` never write anything themselves.** They return a
  plan and a **link**. Open the link — on your phone it opens in the browser, so you need to be
  signed in to GavelUp there too — check it against the source (the guest-book page, the
  schedule), fix anything misread, and save it in GavelUp. Nothing changes until you do.

Some things that work well:

- *"Dana told me she wants to speak at the next meeting."* → Claude finds the next meeting and
  an open speaker slot, and asks you to approve `assign_roles`.
- *(photo of the guest book)* *"Record these guests for last night's meeting."* → a confirm link;
  the page flags anyone who might already be in GavelUp so you choose rather than guess.
- *"Set Word of the Day and themes for the next four meetings: …"* → a confirm link with a
  per-date diff.

It cannot delete or reschedule a meeting, change what roles a meeting has, or see anything in a
club you are not an officer of.

## Disconnecting

Open **`/me`** in GavelUp. Under **Connected apps** is every app you've approved, with when you
approved it and when it last renewed its access. Click **Disconnect** next to one and confirm.

That ends GavelUp's side: the app can no longer renew its access, and the next time it asks to
connect you see the approval screen again. Access it already holds keeps working for up to an
hour, because access tokens are checked without a database lookup.

Removing the connector in claude.ai only stops Claude from using it; GavelUp's side stays live
for up to 30 days until you disconnect it on `/me` as well.

If you lose your phone: sign in to GavelUp from another device and disconnect on `/me`.

## Connecting Claude Code

1. In GavelUp, open **`/me`**, give the token a label if you like, and click **Create token**.
   Copy it; it is shown once.
2. In a terminal:

   ```bash
   claude mcp add --transport http gavelup https://gavelup.app/api/mcp \
     --header "Authorization: Bearer tmk_..."
   ```

Revoke the token on `/me` to disconnect; that takes effect on the next call.

## When it doesn't work

| What you see | What it means |
|---|---|
| Claude says the connector needs authentication | Click **Connect** again. Tokens refresh on their own; this is usually a signed-out GavelUp session |
| "This approval link has expired or was changed" | The approval page is valid for ten minutes. Start again from Claude |
| "You're signed in as someone else now" | You signed in to a different GavelUp account in another tab. Reload and check the account |
| "We couldn't confirm the connection" | The network dropped mid-approval. Check claude.ai; if it isn't connected, connect again |
| Every tool answers `FORBIDDEN` | The account you connected is not an admin or officer of that club |
| `ARCHIVED` | That club has been archived; it can't be changed from anywhere |
| The magic link says it has expired | Links work once, for five minutes. Ask for a new one |

---

## For the maintainer

Everything below needs production access. Design and trade-offs are in
[ADR-0027](adr/0027-oauth-authorization-server-for-mcp.md).

### The one client

claude.ai connects as ONE confidential OAuth client, registered by hand (Dynamic Client
Registration is deliberately off). As of 2026-09-23 production holds exactly one:

| Field | Value |
|---|---|
| Name | `claude.ai` |
| Redirect URI | `https://claude.ai/api/mcp/auth_callback` |
| Auth method | `client_secret_post` |
| Owner | the superadmin who ran the registration script |

Everyone who connects claude.ai uses **this client's ID and secret**. That is the main thing
that makes it awkward to hand out (see [Making it easier](#making-it-easier)).

**Deleting the owner's GavelUp account deletes the client** (`oauth_client.user_id` cascades),
and every member's connection with it.

### Registering (or re-registering) the client

The script ships in the runtime image as a Node bundle — the image has no Bun. In the deployed
web service:

```bash
railway ssh          # pick the web service, not Postgres
node .output/register-oauth-client.mjs --as <your superadmin email> \
  --name claude.ai --redirect-uri https://claude.ai/api/mcp/auth_callback
```

It prints the client ID and secret **once**; the secret is stored hashed and cannot be
recovered. It refuses to create a second client with the same name unless you pass `--force`.

If claude.ai ever changes its redirect URI, a connect attempt fails with an OAuth
`redirect_uri` error. Start adding the connector with any client ID, read `redirect_uri=` off
the GavelUp error page's URL, and register that value.

### Rotating the secret

```bash
node .output/register-oauth-client.mjs --as <the client's owner> --rotate-secret <client_id>
```

Only the account that created the client can rotate it. **Rotating breaks every connected
member's connector** until they paste the new secret into Advanced settings; tokens already
issued keep working until they expire (up to an hour).

### Revoking one person

A person disconnects their own apps on `/me` ([Disconnecting](#disconnecting)). This is the
fallback for revoking SOMEONE ELSE — a lost account, or a person who can't sign in. In the
Postgres service:

```bash
railway ssh --service Postgres -- psql -X -c "
  delete from oauth_refresh_token where user_id = (select id from \"user\" where email = '<email>');
  delete from oauth_consent       where user_id = (select id from \"user\" where email = '<email>');"
```

Their current access token keeps working for up to an hour. Ending their officer term or
membership is immediate: every call re-checks club roles live.

### Checking it's up

```bash
curl -s -o /dev/null -D - -X POST https://gavelup.app/api/mcp | grep -i www-authenticate
curl -s https://gavelup.app/.well-known/oauth-protected-resource/api/mcp
```

The first must print a `www-authenticate: Bearer resource_metadata="…"` line — that header is
how claude.ai finds where to sign in. The second must return JSON naming
`https://gavelup.app/api/mcp`.

### Making it easier

One thing stands between this and "any officer can connect in a minute": **everyone shares one
client secret.** Handing it out works for a few trusted officers, but a leaked secret means
rotating it, and rotating disconnects everyone. The fix is to let claude.ai register itself:
MCP's Client ID Metadata Documents (`@better-auth/cimd`, named in ADR-0027 as the path "when
this opens to other officers"). Then connecting is **paste the URL, sign in, approve** — no ID,
no secret, and nothing for the maintainer to do per person. It is recorded as open in ADR-0027
("Known and left open").

Self-service disconnect, the other half, shipped in #851: `/me`'s **Connected apps** list.
