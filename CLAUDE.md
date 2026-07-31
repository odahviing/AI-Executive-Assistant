# Shell command rules for Claude Code

The harness runs every command with the working directory already set to
`E:\Code\Maelle`. You do not need to — and **must not** — prepend `cd` to
any command.

## Hard rules

1. **Never prepend `cd <path>` to a command.** Compound commands like
   `cd E:/Code/Maelle; npm run typecheck` or `cd E:\Code\Maelle && git status`
   trigger a built-in "compound command contains cd with path operation"
   security prompt that the user has to manually approve every time. This
   prompt fires *before* the allowlist is consulted, so no permission
   entry can suppress it. Just run the command directly:
   - ✅ `npm run typecheck`
   - ✅ `git status`
   - ❌ `cd E:/Code/Maelle; npm run typecheck`
   - ❌ `cd E:\Code\Maelle && git status`

2. **Use absolute paths in arguments instead of `cd`.** If you really need
   to operate on a file outside the cwd (rare — almost everything lives
   under `E:/Code/Maelle`), pass the absolute path to the tool instead of
   `cd`-ing first.

3. **Don't chain unrelated commands with `;` or `&&`** unless they
   genuinely depend on each other. Each `;` segment shows up in the
   compound-command guard's analysis and can trigger extra prompts. Run
   them as separate tool calls.

4. **Prefer `Bash` over `PowerShell` on this machine** when the command
   is portable (git, npm, node, ls, grep). The user's allowlist is
   tuned for Bash patterns; PowerShell calls bypass it and prompt more.

5. **Never use `node -e` or `node -p` to read or process files.** They are
   arbitrary code execution and always prompt — there is no safe way to
   allowlist them. Use the right tool for the job:

   | What you want                  | Use this                                 |
   |--------------------------------|------------------------------------------|
   | Read any file (incl. JSON)     | The `Read` tool with absolute path       |
   | Read a JSON field              | `Read` then look at the field            |
   | Query the SQLite db (readonly) | `node scripts/db-query.cjs ...`          |
   | Run an existing inspect script | `node scripts/inspect-foo.cjs`           |
   | One-off analysis on transcripts/logs | Write a `.js` file to `C:\Users\idanc\AppData\Local\Temp\` (allowlisted), then `node` it |

   Never run `node -p "require('./package.json').version"` — open
   `package.json` with `Read` and look at the `version` field. The single
   round-trip you save isn't worth the approval prompt.

   Ad-hoc `node -e "..."` and `node -p "..."` always prompt. If you find
   yourself reaching for one, stop and ask which of the rows above fits.

6. **When committing, use HEREDOC for the message body.** Single-line `-m`
   commits are fine; multi-line bodies via `-m "$(cat <<'EOF' ... EOF)"`.
   Never edit the previous commit (`--amend`) unless explicitly asked.

## Reading Maelle's logs — she runs on the cloud now, not this laptop

As of the cutover, Maelle runs on the GCP VM `maelle-agent-vm` (zone
`europe-west4-b`) under PM2 — **not on this laptop**. The local `logs/` dir is
**STALE** (frozen at the cutover); never diagnose a live problem from it.

Read her CURRENT logs by fetching from the VM:
`powershell -File scripts/vm-logs.ps1 [grep-term] [lines]`
(e.g. `scripts/vm-logs.ps1 "Yael" 300`) — tails today's winston log (filtered if
you pass a term) + recent pm2 stderr. Needs gcloud auth live; if it errors
"Reauthentication failed", the user runs `gcloud auth login`.

Everything else lives on the VM too (DB, config). SSH in with
`gcloud compute ssh maelle-agent-vm --zone=europe-west4-b --tunnel-through-iap`;
the app root is `/mnt/disks/maelle/app` (DB read-only via `node scripts/db-query.cjs`).

## Why this file exists

The user got tired of approving `cd PATH; cmd` prompts that fire because
of a built-in path-bypass guard, not because of a missing allowlist
entry. This file is the source of truth so future sessions don't
re-introduce the pattern.
