# claude
Claude Code integration for yena.

It is a yena plugin (`runtime: "node"`, `entry: src/index.ts`, version 0.4.0): the host loads it at startup and adds the `claude` command. It does not depend on `core`. `claude ask` and `claude chat` run the Claude Agent SDK in a read-only mode.

## Commands
- `claude ping` — prints `pong`; confirms the module is loaded.
- `claude ask [--new] <text>` — asks Claude, continuing the last session. `--new` starts a fresh session. Use `--` before text that starts with `--`. Text starting with `/` is rejected. Only one ask runs at a time; an ask is cancelled after 5 minutes. Output ends with a footer:
  ```
  Asking Claude…
  <answer>
  [session d503c507 · model claude-haiku-5-5 · subscription token]
  ```
- `claude chat [--new]` — opens an interactive streaming chat (see below). Continues the last session; `--new` starts a fresh one.
- `claude new` — the next ask starts a new session (`Next ask starts a new session`).
- `claude session` — prints `Session`, `Model`, `Claude Code runtime`, `Agent SDK` and `Binary in use` (`runtime` or `bundled`).
- `claude auth status` — active credential (for example `Active credential: subscription token (from environment)`), other available sources, file-mode warnings, and the one-time subscription notice.
- `claude auth key --from-file <path>` — stores an API key from a file in `<dataDir>/credentials.json` (mode 0600). The source file is left untouched; delete it yourself.
- `claude auth logout` — removes only `credentials.json`. Environment variables and `.token` are untouched.
- `claude auth login` — not available yet; it needs terminal handoff (`ctx.suspend`, a later phase). Workaround: run `claude setup-token` in a shell and save the token to `<dataDir>/.token`, or use an API key.

Without a subcommand, or with an unknown one, the command fails with `Usage: claude <ping|ask|chat|new|session|auth>`.

`<dataDir>` is `<YENA_DATA>/claude` (`/data/claude` in the container). It holds `md/`, `config/`, `state.json`, `credentials.json` and `.token`.

## Chat
`claude chat [--new]` replaces the prompt with a chat view (needs a core that provides `ctx.mount`; otherwise it fails with `"claude chat" needs an interface that can show views`). Only one chat, and not together with an ask (`A chat is already open`, `An ask is already running`). Unknown arguments give `Usage: claude chat [--new]`.

Keys:
- Enter sends. Alt+Enter or Shift+Enter inserts a newline; a bracketed paste is inserted sanitized and never submitted. Input is limited to 32000 characters (`Input truncated to 32000 characters`).
- Esc while an answer runs interrupts it; the next message continues the same conversation. Esc while idle clears the draft, or leaves the chat when the draft is empty. Ctrl+C interrupts a running answer, or leaves the chat when idle.
- Enter while an answer runs is refused (`Wait for the answer or press Esc to interrupt`) and the draft is kept; there is no message queue.
- Slash commands: `/help`, `/new` (new conversation, refused while running), `/exit` and `/quit`. Any other `/x` is refused and not sent.

Display: the answer streams in a live area (tail only; running tools with a spinner, thinking and retry status); a completed answer or tool block is then printed once into the scrollback. Tool blocks show the call and the first 3 lines of the result plus `… +N more lines`. The status bar is always visible: `subscription token · claude-haiku-5-5 · 5646e143 · idle · est. $0.0123` (credential, model, session prefix, phase, cost). The cost is the latest figure reported by the SDK. Leaving prints `[chat closed · session <id8> · model <model>]`.

Behaviour and limits:
- One streaming query per chat; a turn ends at the SDK `result`. After an interrupt the same query is reused; if no result arrives within 8 s it is recycled and the next message respawns it with `resume`.
- 5-minute timeout per turn; at most 20 turns per user message (reaching it ends the turn with an error and the next message resumes).
- The session id is saved after each successful turn, so `claude chat` and `claude ask` continue the same session.
- All text shown (model output, tool arguments and results, errors, your own input) is stripped of terminal escapes and bidi/control characters first, then redacted for credentials. `ask` output gets the same treatment.
- The live area is kept shorter than the terminal (rows-3, rows-1 under 12 rows); on tiny terminals the streaming tail can shrink to nothing and several tools show as `N tools running`.
- Same read-only policy as `ask` (Glob/Grep/Read). Permission prompts, Edit/Write and a diff view are a later phase.

Residual risks:
- Output escaping relies on this module's sanitizer, because Ink passes OSC/SGR/bidi sequences through.
- A view that ignores Ctrl+C cannot be interrupted; the chat handles it.
- If yena is killed by SIGTERM/SIGKILL, the `claude` child lingers until its stdin closes (a few seconds; a turn in progress may keep running until then). Closing the chat on unmount is a mitigation, not a guarantee.
- Sub-agent messages are not shown.
- Automated tests use fake terminal streams; real TTY behaviour needs the manual check below.

Manual TTY check (cheap model, credential only in the environment):
```
make sh
ANTHROPIC_MODEL=claude-haiku-5-5 npm run dev
claude chat --new
```
Then: send `hello`; ask it to read a file; press Esc mid-answer and send another message; paste several lines; try `/foo` (refused), `/help`, `/new`, `/exit`; run `claude chat` again (resumes); resize the terminal during streaming; press Ctrl+C when idle, then Ctrl+C at the main prompt (yena exits). Check the cursor is visible and typing echoes afterwards, and that `ps` shows no leftover `claude` process.

## Credentials
Precedence: environment `ANTHROPIC_API_KEY`, then environment `CLAUDE_CODE_OAUTH_TOKEN`, then the stored `credentials.json`, then the legacy `<dataDir>/.token` (the file `bin/claude` also uses). `src/credentials.ts` is the only code that reads these.

- An API key is never accepted as a command argument: it would stay in the scrollback and history. `auth key` takes a file.
- Paths with spaces are not supported, because core splits the command line on whitespace.
- A subscription token (`sk-ant-oat…`) is rejected by `auth key`; use the environment or `.token`.
- Without any credential, `ask` fails with `No credentials found. Set ANTHROPIC_API_KEY, …`.
- Keep secret files private: `chmod 600 <dataDir>/.token` (`auth status` warns when a credential file is readable by others).
- If `ANTHROPIC_BASE_URL` is set in your environment, the credential is sent there. It is your own environment; this is accepted.
- `auth status` does not list a legacy `.token` as an "other source" while a stored key is active.

## Policy caveat
Anthropic's documentation says that, unless previously approved, third-party developers may not offer claude.ai login or its rate limits in products built on the Agent SDK. This is a personal tool and the owner approved using their own subscription token. Prefer `ANTHROPIC_API_KEY`. A one-time notice is printed by `auth status` / `ask` when a subscription token is in use.

## Tool-use policy of `ask`
Layers:
- Tools allowlist: `Read`, `Glob`, `Grep`. Bash, Edit, Write, web tools, agents, skills and MCP tools are disallowed; MCP servers are not loaded.
- `disableAllHooks`.
- Permission deny rules: the credential, state and config files under `<dataDir>`, the whole `config/` directory, `.yena`, `/proc`, `~/.ssh`, `.env*`, `*.pem`, `id_rsa*`, and edits of `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` in the project. Only `md/` stays readable in `<dataDir>`.
- `canUseTool`: every path is resolved with realpath and must be inside the project (`/app`) or the md dir; symlinks leaving them are refused.
- At most 20 turns and a 5-minute timeout. `bypassPermissions` is never used.

Residual risks:
- The model can read any non-denied file in `/app` and the md dir. Its content goes to the Anthropic API and into session transcripts under `<dataDir>/config/projects`.
- Hiding of hidden/secret files from Grep and Glob rests partly on ripgrep and Claude Code behaviour plus best-effort deny rules.
- A `.env` in `/app` is readable unless the deny rules match it (they deny `**/.env*`).

Process lifetime (also for `chat`): a normal exit, timeout or cancel stops the `claude` child process. After SIGTERM or SIGKILL of the yena process the `claude` child can outlive it for a few seconds and exits when its stdin closes; it is not guaranteed, and a generation in progress may keep running until then (no signal handlers on purpose, so the host's signal behaviour is unchanged).

## Logging
The module logs through the host logger (`host.log`, scope `claude`) into `<YENA_HOME or cwd>/logs/yena.log` (JSON lines; format, levels, rotation and redaction are described in the host `CLAUDE.md`). On a host without `host.log` it uses a local noop logger (`src/log.ts`) and nothing is written.

Records (level, message, fields):
- info `plugin loaded`.
- info `auth status` {kind, source, others}; info `api key stored`; info `stored credential removed` {removed}.
- warn `no credential` (ask and chat); info `credential resolved` {kind, source} (ask).
- info `ask started` {fresh, promptChars}; info `ask finished` {outcome, ms, model, numTurns, session8}; warn `ask failed` {outcome (`timeout`|`error`), ms, errClass, reason}; warn `ask timed out` {timeoutMs}; error `sdk load failed` {missingModule, err}.
- warn `result error` {subtype, authFailed}; warn `query threw` {errClass, aborted}.
- info `chat starting` {fresh, kind, source, resuming}; error `chat dependencies failed to load` {missingModule, err}; info `chat closed` {ms, session8, model}.
- info `sdk session spawned` {resuming}; info `turn started` {chars}; info `turn aborting` {outcome}; info `turn ended` {outcome, ms, reason?}; warn `sdk stream threw` {errClass}; warn `sdk stream ended unexpectedly` {authFailed}; warn `authentication failed`; warn `interrupt grace expired; recycling` {graceMs}; warn `session recycled`.
- warn `state write failed` {code}; warn `exit hook aborting requests` {count}.

`reason`/`err` values are scrubbed with the credential redactor and clipped to 300 characters.

Never logged: the prompt (only its length), assistant text, tool arguments and results, file contents, the environment, the credential or any part of it.

`registerLogRedaction` (`src/credentials.ts`) adds an exact-value redactor for the resolved credential to the logger (once per credential, keyed by a SHA-256 digest) before `credential resolved` and every later record, in addition to the host's built-in patterns. `credentials.ts` stays the only code that reads credential names and files.

## Claude Code wrapper
`make claude` (from the host repo) runs `bin/claude`, unchanged by the `ask` work. Its `GUARD` and `HINT` strings are kept in sync with `src/config.ts` by a test. `bin/install` refreshes Claude Code in `.runtime/`, and installs the module dependencies (the Agent SDK pinned to 0.3.302, matching the runtime) when the installed SDK version differs from the pin.

## Development
From `modules/claude`: `npm install && npm run typecheck && npm test` (`npm test` runs the `.ts` and `.tsx` tests under `tests/`; `typecheck` also checks them via `tests/tsconfig.json`). `tsc` and `tsx` still come from the host's `node_modules` and types are imported from the host's `src/api.ts`, so this only works inside the host tree. The SDK and its peers are installed in the module's own `node_modules`. Tests fake the SDK. `ink` and `react` come from the host (`/app/node_modules`) and must not be added to this module's dependencies. Every `.tsx` file must start with `import React from 'react'`: yena runs tsx from `/app`, where the module's JSX settings do not apply, and `npm test` (cwd = the module) would not notice. `tests/ui/runtime.test.ts` renders the UI components in a subprocess started from the host root to catch this (on failure it reports a missing frame text, not the `ReferenceError`). From the host root, `npm run typecheck:modules` and `npm run test:modules` run these for every module.

Manual live check: use a throwaway session and a cheap model, with the credential only in the environment and never printed:
```
make sh
ANTHROPIC_MODEL=claude-haiku-5-5 npm run dev
claude ask hello
claude new
```

## Host-side steps
- `make rebuild` (or recreate the container) so the image has `ripgrep` and the container gets `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from the host environment. These variables also reach `make claude`, where the API key takes precedence over `.token`.
- Commit the module changes in this repo, and `Dockerfile` / `compose.yaml` in the host repo.
- `npm install --prefix` on a completely fresh clone through `bin/install` has not been tested end to end.
