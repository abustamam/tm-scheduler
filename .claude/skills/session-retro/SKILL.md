---
name: session-retro
description: Retrospective on one coding session, producing edits to the agent's environment (navigation pointers, automated checks, coding standards, steering-file pruning). Not "what did we ship"; that is /retro (gstack). Use after a long or painful session, or after a large CLAUDE.md change, to find instructions that no longer earn their place.
disable-model-invocation: true
---

Follow `.agents/skills/retro/SKILL.md` (the Matt Pocock `retro` skill, installed via
`skills-lock.json`) exactly, with one allowance: its step 1 calls a `writing-for-agents` skill
that is not installed here. If the Skill tool does not list it, skip that step.

This directory exists only to give that skill a name that does not collide with gstack's
`/retro`. The two answer different questions. gstack's is the weekly "what did we ship". This one
is "what in the agent's environment made that session harder than it needed to be", and its
output is edits to CLAUDE.md, checks, and skills rather than a report.

If an installer re-creates `.claude/skills/retro` as a symlink, delete the symlink. This wrapper
is the intended entry point.
