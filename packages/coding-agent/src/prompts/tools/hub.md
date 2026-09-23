Coordinate agents/jobs and supervise long-running project processes. Main agent is `Main`; children inherit task ID.

`list` discovers peers. Default: bounded running+idle summary; parked history requires `status:"parked"` (default limit 32, max 100). Use exact IDs; NEVER invent. Sending wakes idle/parked agents; `history://`/`agent://` remain readable.

# Messages & jobs
- Jobs auto-deliver. If `jobs`/`wait` observes settlement first, that snapshot is delivery; no duplicate follows.
- User ≠ peer: answer user only in normal text. `send(to=…)` is fire-and-forget; receipts are immediate; failed means gone, no retry. Replies lead with answer, never quote, and set `replyTo`.
- Peer messages: plain prose, not JSON status; large data via `local://`/`artifact://`.
- `wait` ONLY when otherwise blocked. It returns on first message/job/timeout/steer, not all jobs; repeat as needed. Bare wait watches everything; `ids` narrows jobs, `from` narrows peer. A queued unwatched completion may return `skipped` and deliver next step.
- User steering must be answered before waiting again. Answer peer steering via `send`; advisor/budget needs no reply.
- `inbox`: drain queue. `cancel`: stop hung/unneeded jobs. `jobs`: snapshot; observing settled rows consumes delivery.
- Job rows are process-local: consumed rows expire ~30s after delivery, unconsumed up to five minutes. Later address agent IDs through send/URLs.
- `completed` means exit, not acceptance. Verify claims.
- NEVER inspect peers through shell/search/session files; message them. NEVER use hub for facts another tool can answer.

# Processes
Long-running services/watchers/debuggers/REPLs MUST use `start`, not bash. Names are project-scoped and unique while live.
- `start`: executable + argv; defaults cwd=current, pty=true, restart=no. `persist` survives last client; `detached` survives broker/all clients (implies persist, no PTY). Omit unless needed.
- Readiness: `ready.log` and/or TCP port; when both, BOTH must pass. Regex is JS `/u` (no `(?i)`); readiness must be observed. Completed names may restart; live names require stop/restart.
- `ps/logs/wait/send/stop/restart/describe` address stable process name.
- `logs`: last 100 by default; `head` for beginning; `grep` is JS `/u`; `follow` waits after cursor—reuse returned cursor.
- Process `wait`: readiness/exit/pattern. Pattern exit without match still returns: check state.
- Process `send`: text/Enter, terminal keys, or signal; PTY writes serialize.
- `stop` gracefully terminates the process tree then hard-kills; NEVER kill an unverified PID via bash. `restart` reuses launch spec.
