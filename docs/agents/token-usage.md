# Token usage, and the 2026-10-05 cut

**Question.** Where do this repo's agent tokens go? The maintainer was at half the weekly limit
with four days to the reset; a sibling repo had just made the same pass and cut its spend.

**Method.** The Claude Code transcripts under `~/.claude/projects/` on ONE machine (the Linux
desktop) for 2026-09-28 .. 2026-10-05, deduplicated by message id + request id. Cost is weighted
by API price ratios [ASSUMED proxy; the weekly limit's weighting is not published]: uncached
input 1, cache read 0.1, 5-minute cache write 1.25, 1-hour cache write 2, output 5. It does not
weight by model, so it UNDERSTATES what moving work from Opus to Sonnet saves.

**What it cannot see.** Most tm-scheduler sessions run on another computer,
so this machine holds only 2026-09-28 and 09-29: 15 main sessions, 92 subagents, 3,812 API calls.
The shape below is from that sample. Re-run the script on that machine for the rest.

## Results [MEASURED, this machine, 2026-09-28..29]

| cut | value |
|---|---|
| main thread / subagents | 25% / 75% of cost |
| subagent cost on Opus | 100% |
| Agent dispatches by type / model | `general-purpose` with no model 285, untyped 30, `general-purpose` + `sonnet` 5, `Explore` 5 |
| cost on calls carrying >150k / >300k context | 65% / 17% |
| cache read / 5-min cache write / 1-h cache write / output | 55% / 33% / 8% / 5% |
| a subagent's first call (median) | 65k tokens; their fixed startup was 5% of all cost |
| subagent peak context, deciles (k) | 86, 93, 97, 105, 112, 127, 137, 172, 255 |
| main session first call | 80–85k |
| CLAUDE.md before the cut | 56,678 bytes (~14k tokens), loaded by every session AND every subagent |

The most expensive sessions were wave dispatches: 29.7M units over 15 hours with 24 subagents
(86% of it in them); 15.3M in 2 hours with 14. A wave agent is a whole issue — worktree setup,
`/investigate`, implementation, the full suite, a PR — and every one ran on Opus because no
dispatch named a model.

## Verdict and change

The lever here is the subagents, not the main thread. The change:

- `.claude/agents/implementer.md` (`model: sonnet`) and `.claude/agents/explorer.md`
  (`model: haiku`); `dispatching-issue-waves` step 4 now dispatches with
  `subagent_type: "implementer"`. `.gitignore` admits `.claude/agents/`.
- `CLAUDE.md` cut from 56,678 to ~15k bytes. The long sections moved VERBATIM to
  `docs/agents/commands.md`, `auth.md`, `data-and-deploy.md` and `worktrees-and-landing.md`, and
  the "What earns an issue" measurement to `issue-tracker.md`; CLAUDE.md keeps every rule as a
  line and names the file that holds its reason.
- A "Sessions and agents cost tokens" section: one wave or issue per session, hand off, no
  resuming a session idle for over an hour.

**The same pass in the sibling repo** [MEASURED 2026-10-05, ~4 hours after it merged, 7 new
sessions]: subagent cost on Opus fell from 87% to 5%; median main-session peak context from 254k
to 138k; median session cost from 3.7M to 2.0M units. New cost centre there: a single Sonnet
subagent ran to 522k context. Small sample; re-measure after a week.

**Not yet measured here:** a session after this merges. Re-run the script below on both
machines a week on: subagent model share, subagent first-call context (expect ~10k lower), and
cost per merged PR.

## The script

`python3 usage.py` prints the cuts above for every project whose directory name contains
`tm-scheduler`.

```python
import json, os, glob, collections, datetime as dt, statistics as st
ROOT = os.path.expanduser('~/.claude/projects')
since = dt.datetime(2026, 9, 28, tzinfo=dt.timezone.utc)
W = dict(inp=1, cw5=1.25, cw1h=2, cr=0.1, out=5)   # weights relative to base input
rows, seen = [], set()
for f in glob.glob(ROOT + '/*tm-scheduler*/**/*.jsonl', recursive=True):
    if os.path.getmtime(f) < since.timestamp(): continue
    rel = os.path.relpath(f, ROOT).split('/'); sub = 'subagents' in rel
    for line in open(f, errors='replace'):
        try: d = json.loads(line)
        except ValueError: continue
        if d.get('type') != 'assistant' or not d.get('timestamp'): continue
        t = dt.datetime.fromisoformat(d['timestamp'].replace('Z', '+00:00'))
        m = d.get('message') or {}; u = m.get('usage')
        if t < since or not u: continue
        key = (m.get('id'), d.get('requestId'))
        if key in seen: continue          # one API call is logged once per content block
        seen.add(key)
        cc = u.get('cache_creation') or {}
        r = dict(t=t, sess=rel[1], agent=rel[-1] if sub else 'main', sub=sub, model=m.get('model') or '',
                 inp=u.get('input_tokens', 0), cr=u.get('cache_read_input_tokens', 0), out=u.get('output_tokens', 0),
                 cw1h=cc.get('ephemeral_1h_input_tokens', 0),
                 cw5=cc.get('ephemeral_5m_input_tokens', 0) if cc else u.get('cache_creation_input_tokens', 0))
        r['ctx'] = r['inp'] + r['cw1h'] + r['cw5'] + r['cr']
        r['cost'] = sum(W[k] * r[k] for k in W)
        rows.append(r)
tot = sum(r['cost'] for r in rows)
print('subagent share', sum(r['cost'] for r in rows if r['sub']) / tot)
bym = collections.Counter()
for r in rows:
    if r['sub']: bym[r['model']] += r['cost'] / tot
print('subagent cost by model', dict(bym))
print('>150k share', sum(r['cost'] for r in rows if r['ctx'] > 150e3) / tot)
firsts = {}
for r in sorted(rows, key=lambda r: r['t']):
    firsts.setdefault((r['sess'], r['agent']), r)
print('first-call ctx median, main / sub',
      st.median([r['ctx'] for k, r in firsts.items() if k[1] == 'main']),
      st.median([r['ctx'] for k, r in firsts.items() if k[1] != 'main'] or [0]))
```
