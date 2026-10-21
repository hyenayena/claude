# claude
Claude Code integration for yena.

It is a yena plugin (`runtime: "node"`, `entry: src/index.ts`, version 0.5.0): the host loads it at startup and adds the `claude` command. It requires core 0.2.0+ (declared in `yena.json`): text helpers and UI pieces come from core's public kit, imported only through `src/kit.ts` and `src/ui/kit.ts`; `ping` and `ask` never load React, Ink or the kit UI. `claude ask` and `claude chat` run the Claude Agent SDK in a read-only mode.

## Commands
- `claude ping` — prints `pong`; confirms the module is loaded.
- `claude ask [--new] <text>` — asks Claude, continuing the last session. `--new` starts a fresh session. Use `--` before text that starts with `--`. Text starting with `/` is rejected. Only one ask runs at a time; an ask is cancelled after 5 minutes. Output ends with a footer:
  ```
  Asking Claude…
  <answer>
  [session d503c507 · model claude-haiku-5-5 · subscription token]
  ```
- `chat [model]` — top-level command: opens a new chat (fresh session) with `model` or, without it, the chat model from the settings. It has `autostart: true`, so core opens it at startup, and it contributes the `Claude` settings tab, stored in `state.json` (unset keeps the Claude Code default): `Permission mode` (`chatPermissionMode`: Default, Accept edits, Auto), `Chat model` (`chatModel`: Default, Fable 5.1, Opus, Sonnet, Haiku), `Effort` (`chatEffort`: low…max, SDK `effort`), `Thinking` (`chatThinking`: Adaptive or Off, SDK `thinking: {type: 'disabled'}`), `Fast mode` (`chatFastMode`, settings flag `fastMode`), `Output style` (`chatOutputStyle`: Explanatory or Learning, settings flag `outputStyle`), `MCP servers` (`chatMcp`: On by default, servers from the Claude Code config; Off keeps `strictMcpConfig`), `Settings hooks` (`chatHooks`: Off by default; On sets `disableAllHooks: false`; yena's policy hook runs either way), `Input mode` (`chatInputMode`: Normal or Vim). MCP and hooks apply to new chats. All of them apply to the open chat at once (`Query.setModel`, `setMaxThinkingTokens`, `applyFlagSettings` for effort, fast mode and output style; a respawned query gets them in its options) and to new chats. Code: `src/chat-prefs.ts`. A model argument must match `[A-Za-z0-9][A-Za-z0-9._[\]-]*` (at most 100 chars) and is used for that chat only.
- `claude chat [--new]` — opens an interactive streaming chat (see below). Continues the last session; `--new` starts a fresh one. Uses the chat model from the settings.
- `claude new [model]` — opens a new chat, like `chat [model]`.
- `claude resume [session]` — continues an earlier chat of this project. Without an argument a list opens in the console (newest first: Claude Code's title or the first prompt, age, number of prompts; ↑↓, Enter resumes, Esc closes); with an argument the session whose id starts with it is resumed. The resumed chat shows its last 40 prompts and answers (text only, tool calls left out), read from `config/projects/<project>/<session>.jsonl` (`src/chat/history.ts`).
- `claude rewind` — a list of your messages in this chat (newest first); picking one restores the files Claude changed since then (Claude Code file checkpoints, `enableFileCheckpointing`, `Query.rewindFiles`) and reopens the chat on a branch from just before it (`forkSession` + `resumeSessionAt`), with that message back in the input. Rewinding to the first message opens a fresh chat.
- `claude fork` — continues the current (or last) chat on a new branch; the original stays as it was.
- `claude rename <name>` — names the chat (a `custom-title` entry in the transcript, as Claude Code's /rename writes); the bar shows it.
- `claude export [file]` — writes the chat's prompts and answers as Markdown, by default to `<dataDir>/exports/<date>-<session8>.md`; a given path must be inside the project or the data directory and must not exist yet.
- `claude copy [N]` — puts Claude's last (or Nth last) answer on the terminal clipboard (OSC 52 through core's `ctx.copyToClipboard`; at most 50 000 characters; the terminal must allow OSC 52).
- `claude memory [file]` — opens `CLAUDE.md` (or another md file in `md/`) in `$VISUAL`/`$EDITOR`/`vi` through the terminal handoff.
- `claude tasks` — the chat's tasks (background Bash, subagents) with status and age; picking a running one stops it (`Query.stopTask`).
- `claude mcp [reconnect <server>]` — status of the chat's MCP servers (after its first message), or reconnects one.
- A new chat starts on a clean screen (core clears its transcript when a chat view mounts).
- `claude session` — prints `Session`, `Model`, `Chat model`, `Claude Code runtime`, `Agent SDK` and `Binary in use` (`runtime` or `bundled`).
- `claude auth status` — active credential (for example `Active credential: subscription token (from environment)`), other available sources, file-mode warnings, and the one-time subscription notice.
- `claude auth key --from-file <path>` — stores an API key from a file in `<dataDir>/credentials.json` (mode 0600). The source file is left untouched; delete it yourself.
- `claude auth logout` — removes only `credentials.json`. Environment variables and `.token` are untouched.
- `claude auth login` — hands the terminal over (core `ctx.suspend`), runs Claude Code's `setup-token`, then asks for the printed token with hidden input and saves it to `<dataDir>/.token` (0600); the token never goes through arguments, history or logs.

- `claude <command> [args…]` — any other name is a Claude Code command (built-in such as `compact` or `context`, a custom command from `config/commands`, a skill): it is sent to the open chat as `/<command> args` and runs there, its output appears in the chat. Without an open chat it fails with `No chat is open…`; while Claude is answering it is refused; once the session has reported its command list, names outside it are refused. Hints after `claude ` list the session's commands (with descriptions and argument hints from `supportedCommands()`), or, before the first message, the custom commands and skills found in `config/`.

Without a subcommand the command fails with `Usage: claude <ping|ask|chat|new|session|auth|<Claude Code command>>`.

`<dataDir>` is `<YENA_DATA>/claude` (`/data/claude` in the container). It holds `md/`, `config/`, `state.json`, `credentials.json` and `.token`. `md/` is a symlink to the shared hub of the `md` module, `<YENA_DATA>/md` (a dependency in `yena.json`), so instructions and Claude Code config folders are shared with other agents. The hub holds `agents/`, `skills/`, `commands/` and `output-styles/`; `config/<folder>` is a symlink to `../md/<folder>` so Claude Code finds them (`MD_LINKED_DIRS`; settings and hooks stay in `config/`, since they can run code and change permissions). The links are created when missing at the start of a chat or ask (and by `bin/claude`): an old real `md/` moves into the hub while the hub is blank, a real `config/<folder>` moves into the hub while the hub's folder is empty; otherwise they are left alone (`ensureMdLinks` in `src/config.ts`). Claude is pointed at the hub's own path (system prompt hint, `additionalDirectories`).

## Chat
`chat` and `claude chat [--new]` show the chat as core's main view (needs a core that provides `ctx.mount`; otherwise it fails with `"claude chat" needs an interface that can show views`). Opening a chat closes the open one first; a chat cannot run together with an ask (`A chat is already open`, `An ask is already running`). Unknown arguments give `Usage: claude chat [--new]` / `Usage: chat [model]`.

Next to core's console (`control.host` present) the chat reads keys only while focused, lays out in the width the host gives, ignores the console toggle (`§` or Ctrl+T, via `host.isHostKey(input, key)`), moves the input to the console with → on an empty draft, and Esc never leaves it (only Ctrl+C does): Esc twice on an idle, empty draft opens the console (`host.togglePanel()`), and Esc while an interrupt is pending does nothing.

Keys:
- Enter sends. Alt+Enter or Shift+Enter inserts a newline; a bracketed paste is inserted sanitized and never submitted. The input line scrolls by cells (widths by grapheme, wide characters count as two) and marks cut text with `…`. Input is limited to 32000 characters (`Input truncated to 32000 characters`).
- Esc while an answer runs interrupts it; the next message continues the same conversation. Esc while idle clears the draft, or leaves the chat when the draft is empty. Ctrl+C interrupts a running answer, or leaves the chat when idle.
- Enter while an answer runs is refused (`Wait for the answer or press Esc to interrupt`) and the draft is kept; there is no message queue.
- `:q` (or `:q!`) as the whole message exits yena (through `host.quit()`; without a host it leaves the chat); it is never sent.
- The chat has no slash commands: every line, including one starting with `/`, is sent to Claude as written (`client_composed`, so Claude Code does not run it as a command; such a turn also skips Claude Code's per-turn attachments). Claude Code commands run from the console with `claude <command>`; a new chat is `chat` there, settings are `settings`.

Permission modes: the `Permission mode` setting (`chatPermissionMode` in `state.json`) is the mode new chats start in and switches the open chat at once. Shift+Tab still cycles default → accept-edits → plan → auto for the open chat only (switching to accept-edits or auto asks for confirmation with Enter).
- `plan`: SDK `permissionMode: 'plan'`; Claude researches and proposes a plan without changing anything. When it calls `ExitPlanMode` the prompt asks to start (Yes: default mode; "Yes, and accept edits": accept-edits; No with a reason: Claude keeps planning). Plan needs no confirmation to enter. Claude Code writes the plan to `config/plans/`, the one part of the config dir Claude may write: the chat's settings deny the rest by listing its parts (`CONFIG_EDIT_DENY` in `src/policy.ts`), and the policy hook refuses any other write into the config dir, symlinks resolved.
- Writes: the md hub (`<YENA_DATA>/md`, at its own path) is Claude's own: Edit/Write there never ask, in any mode (class `free`; the chat settings allow `Edit(<hub>/**)`, so auto mode's classifier skips it too; secret-looking names stay denied). The data dir `<YENA_DATA>/claude` is closed for writes by the given and the resolved path (class `deny-locked`), including the `md` link and the `config/<folder>` links into the hub; the one exception is `config/plans/`, where plan mode writes its plan. The chat settings carry no deny rule for the `md` link or the linked `config/<folder>`s: Claude Code resolves symlinks in rule paths, so such a rule would deny the hub itself (the policy hook refuses those paths instead). When yena runs outside the container (data under `./.yena`) the `Edit(./.yena/**)` deny rule also closes the hub.
- `default`: every Edit/Write and Bash call asks.
- `accept-edits`: Edit/Write inside the project are accepted without asking (the bridge decides; the SDK stays in `default`).
- `auto`: the SDK `permissionMode: 'auto'` — Claude Code's model classifier approves or denies each tool call and only asks (through the usual prompt) when it cannot decide. A running query is switched with `Query.setPermissionMode`; a new one gets it in its options. If the SDK rejects it (account, model or version without auto mode), the chat falls back to `default` and prints `Auto mode is unavailable: <reason>`.
- The hard path policy holds in every mode: a `PreToolUse` hook (`src/chat/policy-hook.ts`, passed as the SDK `hooks` option, which `disableAllHooks` does not cover) denies reads outside the roots, Edit/Write outside the project or into guarded/secret paths, and background Bash, even when the classifier approved the call. Settings deny rules still apply too. What auto mode does not limit: Bash commands inside the container that the classifier approves.

Display: the answer streams in a live area (tail only; running tools with a spinner, thinking with a corner-square spinner, and retry status); a completed answer or tool block is then printed once into the scrollback. Tool blocks show the call and the first 3 lines of the result plus `… +N more lines`. Next to core (`host.setTitle` present) a bar above the chat shows the chat's name on the left and the status on the right: `subscription token · claude-haiku-5-5 · 5646e143 · idle · mode: default` (credential, model, session prefix, phase or `awaiting approval`, mode); without a host the same status is the last line of the chat. No cost is shown. The name is `New chat`, then the first message (first line, at most 60 characters), then the title Claude Code generates (`ai-title`, or a `/rename` `custom-title`) read from the session transcript `config/projects/<project>/<session>.jsonl` after each turn and again 3 s and 10 s later; a resumed chat reads it at once (`src/chat/title.ts`). Leaving prints `[chat closed · session <id8> · model <model>]`.

Behaviour and limits:
- One streaming query per chat; a turn ends at the SDK `result`. After an interrupt the same query is reused; if no result arrives within 8 s it is recycled and the next message respawns it with `resume`.
- Subagents: the chat tools are Read, Glob, Grep, Bash, Edit, Write, AskUserQuestion, `Agent`, `SendMessage`, `Skill`, `TodoWrite`, `WebSearch` and `WebFetch`, so agents from `config/agents` (and `claude pipeline …`) run. They run in the foreground and in place: `run_in_background` and `isolation` (worktree, remote) are denied (`src/chat/agent-policy.ts`, in the bridge and the policy hook). Starting an agent does not ask; each tool call it makes goes through the same prompts, mode and path policy. Subagent messages are not shown; the running `Agent(<type>: <description>)` line shows its latest tool call (`→ Edit(/app/src/x.ts)`). `claude ask` still has no agents.
- `Skill`, `TodoWrite` and `WebSearch` run without asking; `WebFetch` always asks (the prompt shows the URL and warns that it leaves the container), in auto mode only when the classifier is unsure. The open TodoWrite checklist (☐ pending, ◐ in progress, ☑ done; at most 8 rows) shows above the input until everything on it is done; its tool block is one line (`checklist: 2/5 done`).
- Input: ↑/↓ walk through the messages sent in this run of yena (the draft comes back after the newest); Shift+↑/↓ still scroll. Enter while Claude answers queues the message (`↳ queued: …`, at most 20); the queue is sent as one message when the turn ends, and goes back into the draft if the turn was interrupted.
- Editing: Ctrl+A/E (line start/end), Ctrl+U/K (kill to start/end), Ctrl+W and Alt+Backspace (kill word back), Alt+D (kill word forward), Ctrl+Y (put the last kill back), Alt+B/F and Ctrl/Alt+←/→ (word moves), Ctrl+_ or Ctrl+/ (undo). Ctrl+R searches the sent messages (type to narrow, Ctrl+R again for older, Enter takes the match into the input, Esc cancels). Ctrl+G opens the draft in the external editor. `@` lists project files (skipping node_modules, .git, build output, .yena and secret-looking names; read on the first `@`), ↑↓ choose, Tab or Enter completes; Claude Code reads mentioned files, images included.
- Vim mode (`Input mode` setting): Esc enters NORMAL (`-- NORMAL --` under the input), `i a I A o O s S C` and `:` go back to INSERT; `h l 0 ^ $ w e b` move, `x X D dd dw de db d$ cc cw yy p u` edit, `j k` walk the history, Enter sends. Esc in NORMAL, or while Claude answers, does what Esc does in the chat.
- Ctrl+O opens the whole transcript of the chat (prompts, answers, thinking, every tool call with its input and up to 400 lines of its result), read from the session file; ↑↓ or j k scroll, space/b by a page, g/G to the ends, Esc, q or Ctrl+O close.
- Mouse (needs a core whose `ViewHost` provides `subscribeMouse`; feature-detected, older cores lack it, `src/ui/view-mouse.ts`): a left click in the input moves the cursor, only while it is editable (not during permission or question prompts, the Ctrl+O viewer, Ctrl+R search, a pending mode switch or the Waiting row; in Vim NORMAL it lands on a character). The wheel scrolls the Ctrl+O viewer by 1 line while it is open; otherwise core scrolls the transcript. A click can land on the wrong row if a key that changes the input's line count has not been rendered yet.
- Ctrl+B moves the running Bash commands and subagents to the background (`Query.backgroundTasks`); the bar then counts `N in background`, and a settled background task prints `⚙ Background task completed: …`.
- Display: answers are rendered as Markdown (headings, bold, italic, code spans, links, lists, task lists, quotes, rules) and fenced code is framed and highlighted (keywords, strings, numbers, comments; `src/ui/markdown.ts`), always after scrubbing, so only constant SGR codes are added. Finished thinking blocks print dim before the answer (`✻ Thinking`, first 6 lines) when the API returns their text.
- The turn timeout counts silence: 5 minutes without any SDK message (subagent messages included) ends the turn (`Request timed out: no activity for 300 seconds`). At most 20 turns per user message (reaching it ends the turn with an error and the next message resumes).
- The session id is saved after each successful turn, so `claude chat` and `claude ask` continue the same session.
- All text shown (model output, tool arguments and results, errors, your own input) is stripped of terminal escapes and bidi/control characters first, then redacted for credentials. `ask` output gets the same treatment.
- The live area is kept shorter than the terminal (rows-3, rows-1 under 12 rows); on tiny terminals the streaming tail can shrink to nothing and several tools show as `N tools running`.
- Same read-only policy as `ask` (Glob/Grep/Read). Permission prompts, Edit/Write and a diff view are a later phase.

Residual risks:
- Output escaping relies on core's kit sanitizer (`sanitizeBlock`, then this module's redaction), because Ink passes OSC/SGR/bidi sequences through.
- A view that ignores Ctrl+C cannot be interrupted; the chat handles it.
- If yena is killed by SIGTERM/SIGKILL, the `claude` child lingers until its stdin closes (a few seconds; a turn in progress may keep running until then). Closing the chat on unmount is a mitigation, not a guarantee.
- Sub-agent messages are not shown.
- Automated tests use fake terminal streams; real TTY behaviour needs the manual check below.

Manual TTY check (cheap model, credential only in the environment):
```
./yena sh
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
- Permission deny rules: the credential and state files under `<dataDir>`, edits (not reads) of the `config/` directory, `.yena`, `/proc`, `~/.ssh`, `.env*`, `*.pem`, `id_rsa*`, and edits of `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` in the project. `md/` and `config/` stay readable in `<dataDir>`.
- `canUseTool`: every path is resolved with realpath and must be inside the project (`/app`) or the md dir; symlinks leaving them are refused.
- At most 20 turns and a 5-minute timeout. `bypassPermissions` is never used.

Residual risks:
- The model can read any non-denied file in `/app`, the md dir and the config dir (including agents, commands, settings, history and transcripts). Its content goes to the Anthropic API and into session transcripts under `<dataDir>/config/projects`.
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
- info `chat starting` {fresh, kind, source, resuming, model} (`model` is the chosen id or `default`); info `chat setting set` {key, value}; error `chat dependencies failed to load` {missingModule, err}; info `chat closed` {ms, session8, model}.
- info `sdk session spawned` {resuming}; info `turn started` {chars}; info `turn aborting` {outcome}; info `turn ended` {outcome, ms, reason?}; warn `sdk stream threw` {errClass}; warn `sdk stream ended unexpectedly` {authFailed}; warn `authentication failed`; warn `interrupt grace expired; recycling` {graceMs}; warn `session recycled`.
- warn `state write failed` {code}; warn `exit hook aborting requests` {count}.

`reason`/`err` values are scrubbed with the credential redactor and clipped to 300 characters.

Never logged: the prompt (only its length), assistant text, tool arguments and results, file contents, the environment, the credential or any part of it.

`registerLogRedaction` (`src/credentials.ts`) adds an exact-value redactor for the resolved credential to the logger (once per credential, keyed by a SHA-256 digest) before `credential resolved` and every later record, in addition to the host's built-in patterns. `credentials.ts` stays the only code that reads credential names and files.

## Claude Code wrapper
`./yena claude` (from the host repo) runs `bin/claude`, unchanged by the `ask` work. Its `GUARD` and `HINT` strings are kept in sync with `src/config.ts` by a test. `bin/install` refreshes Claude Code in `.runtime/`, and installs the module dependencies (the Agent SDK pinned to 0.3.302, matching the runtime) when the installed SDK version differs from the pin.

## Development
From `modules/claude`: `npm install && npm run typecheck && npm test` (`npm test` runs the `.ts` and `.tsx` tests under `tests/`; `typecheck` also checks them via `tests/tsconfig.json`). `tsc` and `tsx` still come from the host's `node_modules` and types are imported from the host's `src/api.ts`, so this only works inside the host tree. The SDK and its peers are installed in the module's own `node_modules`. Tests fake the SDK. `ink` and `react` come from the host (`/app/node_modules`) and must not be added to this module's dependencies. Every `.tsx` file must start with `import React from 'react'`: yena runs tsx from `/app`, where the module's JSX settings do not apply, and `npm test` (cwd = the module) would not notice. `tests/ui/runtime.test.ts` renders the UI components in a subprocess started from the host root to catch this (on failure it reports a missing frame text, not the `ReferenceError`). From the host root, `npm run typecheck:modules` and `npm run test:modules` run these for every module.

Manual live check: use a throwaway session and a cheap model, with the credential only in the environment and never printed:
```
./yena sh
ANTHROPIC_MODEL=claude-haiku-5-5 npm run dev
claude ask hello
claude new
```

## Host-side steps
- `./yena rebuild` (or recreate the container) so the image has `ripgrep` and the container gets `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from the host environment. These variables also reach `./yena claude`, where the API key takes precedence over `.token`.
- Commit the module changes in this repo, and `Dockerfile` / `compose.yaml` in the host repo.
- `npm install --prefix` on a completely fresh clone through `bin/install` has not been tested end to end.

## Permissions that persist
"Always" for a Bash command or an MCP tool (`mcp:<tool>`) is saved in `state.json` (`allowedCommands`, at most 200) and applies to later chats; the `Permissions` settings tab (shown when there are rules) lists them, and choosing Remove drops one (also from the open chat). MCP tool calls always ask unless allowed this way (auto mode: the classifier decides first); their prompt shows the tool and its JSON arguments.
