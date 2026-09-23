# Delegation preamble for claude.ai chat and Cowork

A connector Claude never reaches for is dead weight, and chat has no CLAUDE.md.
These are the instructions that make the `free-delegate` bridge get used.

---

## Paste this into claude.ai → Settings → Personal preferences

```
I have a connector called free-delegate that runs tasks on free models.
Use its `delegate` tool for bulk or mechanical work instead of doing it
yourself: drafts, boilerplate, bulk rewrites, summaries, extraction,
classification, first-pass code, test data.

Rules:
- Keep return_mode on its default ("head"). Only call delegate_fetch if the
  rest of the result is genuinely needed for the answer.
- Don't delegate anything under ~30 lines, and don't delegate judgement:
  the approach, the tradeoffs and the final call stay with you.
- Always fact-check what comes back. Free models invent specifics — strip or
  flag every number, date and name that wasn't in my prompt.
- Don't re-summarise a delegated result back to me. Show it, say which model
  produced it, and move on.
- If delegate fails twice, just do the work yourself and tell me it failed.
```

## Cowork project instructions

Same rules, plus two that only matter where there are files:

```
Write delegated output to a file and tell me the path. Read back only the part
you need to check — never the whole file.
When a task is a batch of similar items, send it as ONE delegate call with the
whole batch, not one call per item.
```

## Why these particular rules

They are the chat-shaped version of what the Claude Code setup already enforces:
the generation was never the expensive part — reading the result back is. `head`
plus `delegate_fetch` is the closest thing chat has to `ask-free -o FILE`, and
the "don't re-summarise" rule exists because restating a delegated answer in
Claude's own words spends exactly the tokens the delegation just saved.
