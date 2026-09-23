{{#if asyncEnabled}}{{#if batchEnabled}}Delegate background work via one `tasks[]` batch; IDs return immediately.{{else}}Delegate ONE background subagent; its ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents run inline; other batch items remain background.{{/if}}{{else}}{{#if batchEnabled}}Run a synchronous `tasks[]` batch.{{else}}Run ONE synchronous subagent.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Async contract
- Results auto-deliver. If `hub jobs`/`wait` sees settlement first, that snapshot is delivery; no duplicate follows.
- Job IDs are process-local: consumed rows expire ~30s after delivery; unconsumed rows remain up to five minutes. Later use agent ID with `hub send`, `agent://`, or `history://`.
- `outputSchema` payloads live at `agent://<id>` (query fields with `?q=.<field>`), even after schema failure; invalid payloads also preview in the follow-up.
- `completed` means agent exit, not acceptance. Verify its claims.
{{/if}}

# Design
- The spawn-policy default (`{{defaultAgent}}`) is the best fit when omitted. Omit `agent` when the spawn-policy default is the best fit; NEVER pass that default explicitly.
- Every assignment MUST be self-contained: exact target/non-goals, required changes/contracts, and observable acceptance. One-liners prohibited.
- Tell every agent to skip formatters, linters, and project-wide tests; run validation once after integration.
- Prefer one-pass investigate+edit.{{#if scoutAvailable}} Use a read-only scout only when affected files are genuinely unknown.{{/if}}
- Parallelize independent ownership only. Same-file edits are not guaranteed to merge.{{#if ircEnabled}} Have siblings coordinate through `hub` before editing shared files.{{/if}} Name one integration owner; freeze shared interfaces in batch `context` and serialize the shared mutation boundary.

# Batch contract
{{#if batchEnabled}}`context`: shared Goal, Constraints, Contract. Do not repeat it per item.
{{/if}}Each `task`:
```
# Target       exact files/symbols; non-goals
# Change       steps, APIs, patterns
# Acceptance   observable result; no project-wide commands
```
Subagents start blank.{{#if ircEnabled}} Parent IRC is immediate steering.{{/if}} Pass large inputs through `local://`, never inline.
{{#if isolationEnabled}}`isolated`: dedicated worktree; {{#if applyIsolatedChanges}}successful edits auto-apply to parent.{{else}}edits remain as patch/branch artifacts.{{/if}}{{/if}}
{{#if evalToolsEnabled}}`tools`: names of eval-defined tools exposed to the child.{{/if}}
{{#if effortEnabled}}`effort`: `"lo"|"med"|"hi"`.{{/if}}
`outputSchema` overrides agent/session schemas; `schemaMode`: permissive (default, may return invalid after retries) or strict (fail).

# Available Agents
{{#if spawningDisabled}}Agent spawning is disabled.{{else}}Pick the most specific agent; omit `agent` only for the default.
{{#if hasModelMentions}}`m<N>` agents are user-tagged models. Spawn only when the request names one; never replace a specialist automatically.
{{/if}}{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Investigation only; edits stay with you or a writing agent.{{/if}}
{{/list}}{{/if}}
