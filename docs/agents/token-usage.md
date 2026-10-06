# Token usage, and the 2026-10-05 cut

**Question.** Where do this repo's agent tokens go? The maintainer was at half the weekly limit
with four days to the reset; a sibling repo had just made the same pass and cut its spend.

**Method.** The Claude Code transcripts under `~/.claude/projects/` on ONE machine (the Linux
desktop) for 2026-09-28 .. 2026-10-05, deduplicated by message id + request id. Cost is weighted
by API price ratios [ASSUMED proxy; the weekly limit's weighting is not published]: uncached
input 1, cache read 0.1, 5-minute cache write 1.25, 1-hour cache write 2, output 5. These weights
are model-independent, so they say nothing about what moving to Sonnet saves. This paragraph used
to claim they understate it. The dollar repricing under "What the cut is worth" is the estimate.

**What it cannot see.** Most tm-scheduler sessions run on another computer (the Mac),
so this machine holds only 2026-09-28 and 09-29: 15 main sessions, 92 subagents, 3,812 API calls.
The shape below is from that sample. The Mac's numbers follow it.

## Results [MEASURED, this machine, 2026-09-28..29]

Re-run on 2026-10-06 with the fixed script below; the first version of this table came from the
buggy one. 3,812 API calls, 117.9M units.

| cut | value |
|---|---|
| main thread / subagents | 23% / 77% of cost |
| cost on Opus, within main / within subagents | 100% / 100% |
| Agent dispatches by type / model | `general-purpose` 92; **none named a model** (the first version printed 325, with 5 on `sonnet`) |
| cost on calls carrying >150k / >300k context | 64% / 16%; main-thread calls are 21% / 5% of each |
| cache read / 5-min cache write / 1-h cache write / output | 51% / 31% / 7% / 11% |
| first observed call, median, main / subagent | 82k / 65k; subagents' first observed calls are 5% of cost |
| subagent peak context, deciles (k) | 86, 93, 97, 105, 112, 127, 137, 172, 255 |
| main-session peak context (median) | 201k |
| median session cost | 5.5M units |
| main-thread calls more than an hour after the previous one | 14, median 151k context, 3.4% of cost |
| CLAUDE.md before the cut | 56,678 bytes (~14k tokens), loaded by every session AND every subagent |

The most expensive sessions were wave dispatches: 29.7M units over 15 hours with 24 subagents
(86% of it in them); 15.3M in 2 hours with 14. A wave agent is a whole issue — worktree setup,
`/investigate`, implementation, the full suite, a PR — and every one ran on Opus because no
dispatch named a model.

## Results [MEASURED, the Mac, 2026-09-28..10-06]

23 main sessions, 108 subagents, 6,397 API calls, 199M units, up to the #1097 merge. All of it
comes from the script below, which fixes three bugs in the first version (see "The script").

| cut | value |
|---|---|
| main thread / subagents | 31% / 69% of cost |
| cost on Opus, within main / within subagents | 97% / 94% (the rest Fable) |
| Agent dispatches by type / model | `general-purpose` 77, untyped 14, `Explore` 3; **none named a model** |
| cost on calls carrying >150k / >300k context | 77% / 35%; main-thread calls are 32% / 24% of each |
| cache read / 5-min cache write / 1-h cache write / output | 70% / 18% / 9% / 3% |
| first observed call, median, main / subagent | 89k / 74k; subagents' first observed calls are 4% of cost |
| subagent peak context, deciles (k) | 88, 95, 104, 113, 130, 152, 182, 217, 316 |
| main-session peak context (median) | 235k |
| median session cost | 6.9M units |
| main-thread calls more than an hour after the previous one | 23, median 235k context, 4.4% of cost |

The two machines agree on where the cost sits (subagents, all on Opus, no dispatch naming a
model) but not on context length: calls over 300k are 16% of cost on Linux and 35% on the Mac,
and the top subagent decile peaks at 255k against 316k. On the Mac, long context is mostly a
SUBAGENT problem: of the 35% on calls over 300k, three quarters is subagents, and a tenth of
subagents peak above 316k.
Main-thread calls over 300k are about 8% of all cost. (An earlier draft of this section read
the 35% as main threads. That was wrong.)

## What the cut is worth [ESTIMATED from both machines, 5.5 list prices]

Repriced at list ($/MTok): Opus 5.5 is 4 in / 20 out, Sonnet 5.5 is 2 / 10, and Fable 5.1 is 10 / 50.
**Opus and Sonnet both read cache at 0.20.** Cache reads are 58% of Opus subagent dollars on the
Mac and 32% on Linux, and that part does not shrink on Sonnet. Linux's subagents were shorter and
spent more on cache writes and output, which do halve, so the Sonnet line differs by machine.

| rule | what it hits | estimated saving |
|---|---|---|
| wave agents on Sonnet | Opus subagent dollars: Mac fall 21% ($325 → $258 of $541 total), Linux 34% ($274 → $181 of $351) | Mac ~12%, Linux ~26%; **pooled ~18%** ($160 of $892) |
| CLAUDE.md 56.7 KB → 15.1 KB | ~10k tokens off every call, a scenario: reads 2.4% + cold writes 0.7% on the Mac, 2.2% + 1.0% on Linux | ~3% |
| handoff instead of resuming stale sessions | main-thread calls after a gap of over an hour: 4.4% of cost on the Mac, 3.4% on Linux; the whole call, not only its rebuild | under 4.4% |
| subagent context | the ~27% of cost on subagent calls over 300k on the Mac (~15% on Linux) | none yet: `implementer.md` asks for a small context and nothing caps it |

So the cut helps, but it is no halving, and the largest pool left is long-running subagents, which
no rule here bounds. The weekly limit's weighting is not published, so these dollars are a proxy
too. If the limit weights Opus more heavily than its list price does, the Sonnet line is worth more.
The `explorer` (Haiku) had almost nothing to replace here, with 3 `Explore` dispatches in nine
days.

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

**Not yet measured here:** a session after this merges. As of 2026-10-06 the only post-merge
sessions on the Mac are the one that wrote the cut and the one that measured it, and neither
dispatched a wave. Re-run the script below on both machines a week on: subagent model share,
subagent first-call context (expect ~10k lower), the >300k share, and cost per merged PR.

## The script

`python3 usage.py` prints every number above, pooled across every project directory whose name
contains `tm-scheduler` (the main checkout and its worktrees). Set `since` / `until` for the window
you want; a statistic with too small a sample prints `N/A`. Fable and Haiku are priced at their own
list prices; a model it cannot price is listed, and contributes no dollars (`<synthetic>` is Claude
Code's zero-usage placeholder). The first version had three bugs, all fixed here:

- **It undercounted dispatches.** It read `Agent` calls only off the first logged line of each API
  call. One call is logged once per content block, so the later lines were dropped: it found 7
  dispatches on the Mac where there were 94. Dispatches are now counted by tool-use id on every
  line, before any usage check.
- **It undercounted output.** An early line can carry a partial `output_tokens` (1 where the call
  produced 446; 1,500 calls on the Mac), so the most complete usage record is now kept whole.
- **It divided subagent model shares by TOTAL cost**, so "subagent cost on Opus" printed 65% where
  it is 94%.

"First call" means first observed in the window: a session begun before `since` contributes a
mid-session call.

```python
import json, os, glob, collections, datetime as dt, statistics as st
ROOT = os.path.expanduser('~/.claude/projects')
since = dt.datetime(2026, 9, 28, tzinfo=dt.timezone.utc)
until = dt.datetime(2026, 10, 6, 1, 21, tzinfo=dt.timezone.utc)  # the #1097 merge
W = dict(inp=1, cw5=1.25, cw1h=2, cr=0.1, out=5)              # units, relative to base input
LIST = dict(opus=(4, 0.20, 20), sonnet=(2, 0.20, 10), fable=(10, 0.25, 50), haiku=(1, 0.10, 5))
USD = {f: dict(inp=i, cw5=1.25 * i, cw1h=2 * i, cr=c, out=o) for f, (i, c, o) in LIST.items()}  # $/MTok
family = lambda model: next((f for f in USD if f in model), None)  # None: unpriced, reported
calls, tools, dispatch = {}, set(), collections.Counter()
for f in glob.glob(ROOT + '/*tm-scheduler*/**/*.jsonl', recursive=True):  # all matches, pooled
    if os.path.getmtime(f) < since.timestamp(): continue
    rel = os.path.relpath(f, ROOT).split('/'); sub = 'subagents' in rel
    sess = rel[1].removesuffix('.jsonl')
    for line in open(f, errors='replace'):
        try: d = json.loads(line)
        except ValueError: continue
        if d.get('type') != 'assistant' or not d.get('timestamp'): continue
        t = dt.datetime.fromisoformat(d['timestamp'].replace('Z', '+00:00'))
        if not since <= t < until: continue
        m = d.get('message') or {}
        for c in m.get('content') or []:   # dispatches: by tool-use id, before any usage gate
            if isinstance(c, dict) and c.get('name') in ('Agent', 'Task') and c.get('id') and c['id'] not in tools:
                tools.add(c['id']); i = c.get('input') or {}
                dispatch[(i.get('subagent_type') or '(untyped)', i.get('model') or '(none)')] += 1
        u = m.get('usage')
        if not u or not m.get('id') or not d.get('requestId'): continue
        cc = u.get('cache_creation') or {}
        v = dict(inp=u.get('input_tokens', 0), cr=u.get('cache_read_input_tokens', 0), out=u.get('output_tokens', 0),
                 cw1h=cc.get('ephemeral_1h_input_tokens', 0),
                 cw5=cc.get('ephemeral_5m_input_tokens', 0) if cc else u.get('cache_creation_input_tokens', 0))
        # One API call is logged once per content block, and an early line can carry a partial
        # output_tokens (1 where the call produced 446). Keep the most complete record whole.
        key = (m['id'], d['requestId'])
        if key not in calls or v['out'] > calls[key]['out']:
            calls[key] = dict(t=min(t, calls[key]['t']) if key in calls else t, sess=sess,
                              agent=rel[-1] if sub else 'main', sub=sub, model=m.get('model') or '', **v)
rows = list(calls.values())
for r in rows:
    r['ctx'] = r['inp'] + r['cw1h'] + r['cw5'] + r['cr']
    r['cost'] = sum(W[k] * r[k] for k in W)
    p = USD.get(family(r['model'])); r['usd'] = sum(p[k] * r[k] for k in W) / 1e6 if p else 0
def med(xs):
    xs = list(xs); return round(st.median(xs) / 1e3) if xs else 'N/A'
def share(a, b): return f'{100 * a / b:.1f}%' if b else 'N/A'
tot = sum(r['cost'] for r in rows); subs = [r for r in rows if r['sub']]; stot = sum(r['cost'] for r in subs)
print('calls', len(rows), '| main sessions', len({r['sess'] for r in rows if not r['sub']}),
      '| subagents', len({(r['sess'], r['agent']) for r in subs}), '| units M', round(tot / 1e6, 1))
print('subagent share', share(stot, tot))
for lab, rs in (('main', [r for r in rows if not r['sub']]), ('subagent', subs)):
    s = sum(r['cost'] for r in rs); by = collections.Counter()
    for r in rs: by[r['model']] += r['cost']           # share of THAT group's cost
    print(lab, 'cost by model', {k: share(v, s) for k, v in by.most_common(3)})
print('dispatches (type, model)', dispatch.most_common())
for th in (150e3, 300e3):
    big = sum(r['cost'] for r in rows if r['ctx'] > th)
    print(f'>{th / 1e3:.0f}k share', share(big, tot),
          '| of it main', share(sum(r['cost'] for r in rows if r['ctx'] > th and not r['sub']), big))
for k in W: print('kind', k, share(sum(W[k] * r[k] for r in rows), tot))
by = collections.defaultdict(list)
for r in rows: by[(r['sess'], r['agent'])].append(r)
for rs in by.values(): rs.sort(key=lambda r: r['t'])
# FIRST OBSERVED in the window: a session begun before `since` contributes a mid-session call
firsts = {k: rs[0] for k, rs in by.items()}
print('first observed call ctx median k, main / sub', med(r['ctx'] for k, r in firsts.items() if k[1] == 'main'),
      med(r['ctx'] for k, r in firsts.items() if k[1] != 'main'))
print('subagent first-observed-call share', share(sum(r['cost'] for k, r in firsts.items() if k[1] != 'main'), tot))
peaks = [max(r['ctx'] for r in rs) for k, rs in by.items() if k[1] != 'main']
print('subagent peak deciles k', [round(x / 1e3) for x in st.quantiles(peaks, n=10)] if len(peaks) > 1 else 'N/A')
print('main peak median k', med(max(r['ctx'] for r in rs) for k, rs in by.items() if k[1] == 'main'))
sc = collections.Counter()
for r in rows: sc[r['sess']] += r['cost']
print('median session units M', round(st.median(sc.values()) / 1e6, 2) if sc else 'N/A')
# Main-thread calls more than an hour after the previous one. A gap is usually the maintainer
# away, but can be a long tool run; this is a share of cost, not a measured saving.
resumes = [b for k, rs in by.items() if k[1] == 'main' for a, b in zip(rs, rs[1:])
           if (b['t'] - a['t']).total_seconds() > 3600]
print('main-thread calls after >1h gap', len(resumes), '| their cost share', share(sum(r['cost'] for r in resumes), tot),
      '| median ctx k', med(r['ctx'] for r in resumes))
# Dollars at list price
usd = sum(r['usd'] for r in rows)
print('unpriced models', {r['model'] for r in rows if not family(r['model'])} or 'none')
op = [r for r in subs if family(r['model']) == 'opus']
so = sum(r['usd'] for r in op); ss = sum(sum(USD['sonnet'][k] * r[k] for k in W) / 1e6 for r in op)
print(f'$ total {usd:.0f} | Opus subagents {so:.0f} -> Sonnet {ss:.0f}: saves {share(so - ss, usd)} of total',
      f'| cache reads {share(sum(USD["opus"]["cr"] * r["cr"] for r in op) / 1e6, so)} of those $')
# SCENARIO, not a measurement: assumes CLAUDE.md sits in the cached prefix of every call, read
# when the call read at least that much from cache, else written at the call's dominant TTL.
D = (56678 - 15133) / 4    # tokens the CLAUDE.md cut removes from every context (bytes / 4)
pr = lambda r: USD.get(family(r['model'])) or {k: 0 for k in W}
rd = sum(D * pr(r)['cr'] / 1e6 for r in rows if r['ctx'] >= D and r['cr'] >= D)
wr = sum(D * pr(r)['cw1h' if r['cw1h'] > r['cw5'] else 'cw5'] / 1e6 for r in rows if r['ctx'] >= D and r['cr'] < D)
print(f'CLAUDE.md cut (scenario): reads {share(rd, usd)} + cold writes {share(wr, usd)} of $')
```
