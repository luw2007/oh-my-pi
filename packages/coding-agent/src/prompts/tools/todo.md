Tasks are verbatim strings, NEVER generated IDs (`task-1`/`task-N`).

State changes auto-promote the earliest pending task when none is active; if several are active only the earliest remains. Blocked tasks never auto-promote. Out-of-order completion may move the pointer backward; completed tasks never revert.

## Shape
- Task: unique 5–10-word description of what, not how.
- Phase: unique short noun phrase; no numeric/letter/`Phase N` prefix.
- `init`: replace all tasks (`list` for phases; `items` for one phase). `append` lazily creates a phase. `rm` without task/phase clears all.

## Rules
- Complete phases in order; mark work done immediately.
- NEVER make todo the turn's only tool call. Pair `init` with first work and `done`/`start` with next work or final verification.
- External wait → `block` with reason; agent-actionable blocker → append its task instead. `unblock` before resuming.
- Keep task/phase strings stable. If forgotten, `view`; NEVER guess.
- Create todos for 3+ steps, explicit user request/list, or new mid-task instructions.

<critical>
For a user checklist/numbered plan/"N tasks": `init` every item separately before work. NEVER merge, sample, omit, or track items only from memory.
</critical>
