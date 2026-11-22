# Phreak spec

Status: draft v0.2, 2026-11-22. Nothing is built yet.

## 1. What Phreak is

Phreak is a realtime voice layer that sits on top of a bb thread. You open it
beside a chat and talk the chat through with a voice model that knows the whole
conversation. When you say so, it writes the message and sends it into the
thread.

The voice model is a second participant, not a relay. It answers from the chat,
looks things up and keeps track of what you decided. Nothing reaches the
thread's agent until you ask for it.

A typical session:

1. You open a thread where the agent has laid out options A to D. You press the
   Phreak button.
2. You ask: "Remind me what B costs us. Did it already touch the auth module?"
   Phreak answers from the transcript and checks `git diff`.
3. You talk it through: "Skip the migration. Actually, A plus D."
4. You say: "Okay, send that." Phreak writes "Go with A and D. Skip the
   migration…", sends it at once, and says "Sent" once bb confirms.
5. While the agent works you can ask "is it done?", or say "tell it now to add
   tests too" (Phreak steers the turn), or say "stop it".

## 2. Why another voice plugin

| Plugin | What it does | Where it falls short for this |
| --- | --- | --- |
| Voice Mode (steveafrost, MIT) | Relays each thing you say to the agent, verbatim, and reads back a summary when the turn ends. | The voice model sees only the thread title and 2,500 characters per reply. It cannot read anything itself and forwards every request at once. Its waveform takes over the send button. In the owner's use it felt laggy. |
| Hands-Free (mattwynne) | Dictate on iPhone, send with a tap, hear replies. | No discussion: speech is sent without review. |
| Handsfree (swairshah) | A voice operator that focuses threads and sends messages. | Uses `gpt-live-1`, which refuses the ChatGPT sign-in. No licence, so we reuse nothing from it. |
| Side chat (bb builtin) | A text fork of the thread in a side panel, with "Send to main thread". | Text only. Closest in spirit; Phreak is its voice counterpart. |

Phreak fills the gap: discussion with full context, read-only lookups, steer
and stop, and a send that happens only when you ask.

## 3. Decisions made

Decided with the owner on 2026-11-22:

| Topic | Decision |
| --- | --- |
| Audio provider | Codex (ChatGPT subscription), reached through the installed `codex-realtime` plugin. |
| What the voice model can do in v1 | Read the chat and other threads, read files and git, steer and stop the agent. |
| Sending | Sends immediately when you ask. No confirmation step. |
| Repo | Public. |

Proposed but not yet confirmed: the name Phreak, the MIT licence, and the
panel UI (section 4.6).

## 4. Architecture

```
 bb app (browser)                    bb server                         OpenAI
┌───────────────────────┐ WebSocket  ┌──────────────────────────┐  wss  ┌───────────────┐
│ Phreak panel (tab)    │ binary PCM │ Phreak server            │ ────▶ │ Realtime API  │
│ Audio engine (overlay)│ + JSON ctl │  session manager + gate  │ ◀──── │ gpt-realtime-*│
│  mic capture 24k PCM  │ ◀────────▶ │  context builder         │ JSON+ └───────────────┘
│  playback buffer      │            │  tool runner ─▶ bb.sdk   │ base64
└───────────────────────┘            │  SQLite store            │
                                     └──────────┬───────────────┘
                                                │ callRpc("realtimeConnection")
                                     ┌──────────▼───────────────┐
                                     │ codex-realtime plugin    │
                                     │ (Codex ChatGPT sign-in)  │
                                     └──────────────────────────┘
```

The plugin is a standard bb package: `server.ts` (backend), `app.tsx`
(frontend), with `@get-bb/plugin-sdk` pinned to the version the scaffold
ships (0.6.157, bb ≥ 0.50). Most APIs used below are `experimental_`, so the
pin matters. All bb calls go through one module, so an SDK change touches one
file.

### 4.1 Provider: Codex through `realtimeConnection`

- Phreak asks for a connection over the plugin RPC that Voice Mode already
  uses: `bb.sdk.plugins.callRpc({ pluginId, method: "realtimeConnection" })`.
  The answer is `{ protocol: "openai-realtime", url: "wss://…", headers, model? }`.
- The default `pluginId` is `codex-realtime`. It reads the Codex ChatGPT sign-in
  and returns a bearer header.
  - Phreak never reads `~/.codex/auth.json`, never stores the header, and asks
    again for each session.
  - `codex-realtime` also picks the model (`gpt-realtime-2.1` by default, in
    its own settings). Phreak has no model setting and reads the model from the
    answer.
- `codex-realtime` gives the sign-in only to plugins on its allow-list, checked
  by caller plugin id. The owner adds `phreak` there once:
  `bb plugin config codex-realtime set allowedPlugins voice-mode,phreak`.
- **The sign-in can expire.** `{ refresh: true }` only makes `codex-realtime`
  re-read the file; it never renews the token. If a handshake still fails after
  one refresh, the session ends with "Codex sign-in expired: run `codex` once,
  then resume." Reconnect and rollover follow the same rule.
- **Other providers:** any plugin that answers `realtimeConnection` (for
  example `realtime-gateway`) works by changing the `connectionPlugin` setting.
  An OpenAI API key provider is a v2 addition.

What we tested on 2026-11-22:

- **Codex's own realtime API fails with a ChatGPT sign-in.** In codex-cli
  0.170.0, `codex app-server` has an experimental `thread/realtime/*` API.
  With a ChatGPT login it answers "realtime conversation requires API key auth"
  for the default protocol version, v2 and v3. That rules out using Codex as the
  voice backend directly. If OpenAI opens it up, a `codex-app-server` provider
  can sit behind the same interface.
- **The `codex-realtime` path is not re-verified today.** Its logs show
  sessions opening through Voice Mode on Nov 11, 12 and 16. M0 confirms it still
  works.

Known risks: OpenAI does not document this use of the ChatGPT sign-in. It
already refuses it for `gpt-live-1`, so it can stop working without notice.
Whether the ChatGPT/Codex terms allow it is unchecked. Usage counts against the
ChatGPT plan.

### 4.2 Audio path and latency

The owner reported Voice Mode as laggy and flaky, so latency is a first-class
requirement with a number attached.

- **Browser to server:** one plugin WebSocket route
  (`bb.http.experimental_websocket`) carries two kinds of frames.
  - Binary frames hold the audio: 20 to 40 ms of PCM16 at 24 kHz, about
    48 KB/s upstream, with no base64.
  - Text frames hold JSON control messages:
    - server to browser: captions, status, tool activity, sent-message events
    - browser to server: mute, push-to-talk press and release, and the playback
      position (item id and milliseconds played)
- **Server to OpenAI:** the Realtime protocol is JSON with base64 audio. The
  server converts between the two.
- **Capture and playback:**
  - Mic capture uses echo cancellation and noise suppression.
  - Playback goes through a buffer that can be flushed instantly.
  - AudioWorklet is preferred, but it is unproven here. Voice Mode's code says
    bb's Content Security Policy may block worklet modules, so it uses
    `ScriptProcessor` (1024-sample frames, about 43 ms, on the main thread).
  - A bb source checkout from 2026-11-07 shows no CSP on the web app. M0 tests a
    worklet loaded from a Blob URL, and the `ScriptProcessor` path adapted from
    Voice Mode is the fallback.
- **Turn detection:**
  - `semantic_vad` is the default, with configurable eagerness. `server_vad` is
    also available.
  - `manual` is push-to-talk. Realtime turn detection is off; Phreak commits
    the audio buffer and creates the response on release.
- **Barge-in:**
  - With VAD, `input_audio_buffer.speech_started` triggers it.
  - With push-to-talk, the key press triggers it and Phreak sends
    `response.cancel`.
  - Either way, the browser flushes playback and reports the item id and the
    milliseconds actually played. The server sends `conversation.item.truncate`
    with those values, so the model knows what you heard.
- **Latency target:** at most 700 ms locally and at most 1 s through the bb
  Connect tunnel, measured from the end of your speech to the first audio byte,
  with the thread digest loaded. The panel shows the measured value.
- **WebRTC (not in v1):** a direct browser-to-OpenAI audio path would skip the
  tunnel hop. The `{ url, headers }` contract cannot express it, so it needs a
  contract extension or its own provider. It is revisited only if the relay
  misses the targets.
- **Resilience:**
  - Phreak keeps the conversation state itself, in SQLite (section 4.7).
  - If the socket drops, Phreak reconnects with backoff. It seeds the new
    session with the thread digest and the recent voice discussion, and the
    panel shows "reconnecting".
  - Before the context fills up or the Realtime session limit nears (about
    60 min), Phreak rolls over to a fresh session the same way.

### 4.3 Context

This is the core difference from Voice Mode.

- **Budget:** Phreak derives the context size from the model the provider
  returns: 128k tokens for `gpt-realtime-2` and `2.1`, 32k for mini models, and
  a conservative 24k for unknown models. The digest gets a share of it
  (setting `contextBudgetTokens`, default 40k, tuned by M0's latency numbers).
  A large prefix costs time to first audio and plan usage, which is why M0
  measures with the digest loaded.
- **At start**, Phreak builds a thread digest and adds it as conversation items,
  not as instructions (instructions plus tools are capped at about 16k tokens).
  - The title, every user message and every agent final message go in full,
    newest first, up to the budget.
  - Older turns go in as one-line previews (`threads.conversationOutline`).
  - Tool and command rows shrink to one line each, for example
    "ran tests: 3 failed".
  - Sources: `threads.timeline`, `threads.output`, `threads.get`.
- **Truncation:** Phreak sets the session's `truncation` explicitly rather than
  rely on the default, which may drop the oldest items: the digest. It tracks
  `response.done.usage` and rolls over to a fresh, re-seeded session before the
  limit.
- **While talking:**
  - Phreak listens to `bb.events`: `thread.idle`, `thread.failed`,
    `interaction.pending` and `experimental_thread.events`.
  - `threads.timeline({ afterTag })` returns either a delta (upserted and
    patched rows) or a full snapshot. Phreak keeps a map from timeline row id to
    conversation item, and adds a turn only once it has finished. A turn
    finishes at `thread.idle`, which carries `lastAssistantText`. Rows that are
    still streaming are never appended, so nothing is duplicated.
  - New turns are added silently. When a turn you sent finishes, fails, or
    stops to ask you something, Phreak says one sentence about it (setting
    `announceTurns`, on by default; see section 4.4 for how).
- **On demand**, `read_thread` pulls older or full messages.
- **Across sessions**, a short summary of earlier voice discussions on the same
  thread is included, so you can pick up where you left off.
- **Trust:** thread, file and git content is data. It is wrapped as
  `[thread data]`, never placed in instructions, and the instructions say never
  to follow directions found inside it. The gate in section 4.4 adds hard limits
  in code on where and how often the model can act. It cannot check whether the
  model acted on your words or on injected text.

### 4.4 Tools and the gate

| Tool | What it does | bb API | Gated |
| --- | --- | --- | --- |
| `read_thread(range?, query?)` | Older or full messages from this thread. | `threads.timeline`, `threads.message` | no |
| `agent_status()` | Busy, idle, or waiting on you; queued messages. | `threads.get`, `threads.interactions.list`, `threads.queue.list` | no |
| `list_threads()` / `read_other_thread(id)` | Other threads in the project. | `threads.list`, `threads.timeline` | no |
| `list_files(path)` / `read_file(path, lines?)` | Files in the thread's workspace, read-only and confined (below). | `bb.sdk.files.list`, `bb.sdk.files.read` | no |
| `git_status()` / `git_diff(path?)` | Workspace git state. | `bb--git` plugin RPC, keyed by environment id | no |
| `send_to_chat(text, when)` | Sends a message to the thread. `when` is `queue` (wait for the current turn) or `now` (steer it). | `threads.send` | yes |
| `stop_agent()` | Stops the agent's turn. | `threads.stop` | yes |

**The gate.** Gated tools change the thread, so they run only on your direct
request:

- **User response:** Phreak marks a response as a "user response" when it is
  created for a committed user audio item. With VAD the API creates it after
  `input_audio_buffer.committed`; with push-to-talk Phreak creates it on
  release. Phreak's own bookkeeping decides this, not a VAD event.
- **Gated tools only there:** gated tools are allowed only in a user response.
  The tool runner checks this by `response_id` and refuses everything else.
  - Every follow-up response after a tool result is created with a
    `response.tools` override that lists only the read-only tools.
  - So a lookup can never lead straight to a send or a stop. A gated call needs
    a fresh utterance from you.
- **One gated call per item:** each committed user audio item allows at most
  one gated call.
- **The cost:** "check the diff, and if it touches auth tell it to add tests"
  takes two steps. Phreak reads, reports, and you say "send it". Plain "send
  that" after a discussion works in one step, because the digest is already in
  context.
- **Announcements:** turn announcements run as out-of-band responses
  (`conversation: "none"`, explicit input, no tools, tagged in `metadata`).
  - They are cancelled the moment you speak.
  - Their text is then added as a note, so the model knows what you heard.
- **No false "Sent":** Phreak says "Sent" only from the tool result, after bb
  returns.
- **What the gate does not cover:** inside a user response the model still sees
  the digest and earlier tool results. Injected text there could make it send
  on an utterance that did not ask for a send. The code guarantees only where
  gated calls happen and how many. Whether a call matches your request rests on
  the model. With "send immediately" there is no confirmation to catch a wrong
  send; the panel log, undo for queued messages, and "stop it" are the backstop.

**Read confinement.** The read tools can be triggered by injected content, so
they are fenced in code:

- **Workspace only:** `bb.sdk.files.read` accepts any absolute path on a host.
  Phreak resolves the thread's environment (`threads.get`, then
  `environments.get`) to get its host and root. It resolves every path with
  realpath and refuses anything outside the root.
- **Secrets denied:** `.env*`, `*.pem`, `*.key`, `id_*`, `.ssh/`, `.aws/`,
  `.codex/`, and `credentials*` are refused even inside the root.
- **Caps:** `read_file` returns at most 64 KB and `git_diff` at most 32 KB, with
  a note when the output is cut.
- **Not stored:** tool outputs are never written to SQLite. Only the tool name,
  its arguments and the output size are logged.

Content search across files is left out of v1: it needs a host entry to run
`rg` in the workspace. It is a candidate for M3.

### 4.5 Sending

- **Trigger:** only an explicit ask, such as "send that", "tell it…" or "go
  ahead". The gate in section 4.4 enforces it.
- **Text:** the voice model writes the message as a clear instruction that
  carries the decisions from the discussion, the way you would type it. It is
  not a transcript of your words.
- **Delivery:** the message goes out immediately.
  - `when: "queue"` (the default) uses `threads.send` mode `queue-if-active`.
  - `when: "now"` ("tell it now", "steer it") uses `steer-if-active`. If bb
    answers `active-turn-not-steerable`, Phreak queues instead and says so.
- **Confirmation:** the panel shows the exact text with its state (sent or
  queued). Phreak says "Sent" or "Queued" plus a one-line gist.
- **Undo:** `threads.send` returns the queued row's id, so a queued message can
  be withdrawn from the panel with `queuedMessages.delete`. A sent one cannot;
  say "stop it".
- **Stop:** `threads.stop` stops the turn and also releases the agent's loaded
  runtime, and the thread can sit in `stopping` for a moment. Phreak reports the
  status once it settles.
- **Origin:** messages carry `originPluginId: "phreak"`, so bb records that the
  plugin sent them.

### 4.6 UI

- **Panel:** a "Phreak" thread panel tab beside the chat
  (`app.slots.experimental_tab`). It shows:
  - a status line: listening, thinking, speaking or reconnecting, plus latency
  - live captions for both sides
  - tool activity lines, for example "read git diff"
  - the log of sent messages, with undo for queued ones
  - mute, push-to-talk and end controls
- **Audio engine:** lives in `app.slots.experimental_appOverlay`, mounted once
  per window. Audio keeps running when you close the panel or switch threads. A
  small floating chip then offers mute, end and a way back.
- **Entry points:**
  - a header button (`experimental_threadAction`, placement `header`)
  - a palette command, "Phreak: start or end", with a default shortcut that does
    not collide with Voice Mode's Ctrl+Shift+V. Rebindable.
- **One session at a time per bb server**, across windows and devices. Starting
  a new one ends the old one with a notice, so two sessions can never send to
  the same thread.
- **Untouched:** bb's composer, send button and mic.
- **Remote use:** Phreak must work through the bb Connect URL.
  - The browser opens the same-origin route
    `/api/v1/plugins/phreak/http/session`, as Voice Mode does.
  - The route's `local` auth runs the same origin guard as bb's own API routes
    (`browserRequestProblem` in bb's server). That guard already works over
    Connect, so it should pass. M0 confirms it.

### 4.7 Storage, limits and privacy

- **Stored:** in SQLite under the plugin's data dir, per thread: sessions,
  transcripts, gated tool calls and sent messages. Reconnect and rollover read
  from it. Audio and tool outputs are never stored.
- **Sent to the provider** while a session runs: mic audio, the thread digest,
  and whatever file or git content the tools read, within the confinement
  above. Nothing goes out before you start a session.
- **Limits:**
  - A session ends after 10 minutes of silence, or 20 minutes while an agent
    turn you sent is running.
  - A hard cap of 60 minutes applies across rollovers. It is configurable.

### 4.8 Settings

| Setting | Default |
| --- | --- |
| `connectionPlugin` | `codex-realtime` |
| `voice` | `marin` |
| `turnDetection` | `semantic_vad` (or `server_vad`, `manual` for push-to-talk) |
| `vadEagerness` | `auto` |
| `announceTurns` | on |
| `idleMinutes` | 10 (20 while a sent turn runs) |
| `maxSessionMinutes` | 60 |
| `contextBudgetTokens` | 40000 |

## 5. Not in v1

- Writing files or running commands. The thread's agent does that.
- Handing deep questions to a hidden fork of the thread (the side-chat
  pattern). This is the main v2 candidate.
- An OpenAI API key provider, and WebRTC audio.
- Composer drafts and send confirmation. Possible later as a setting.
- Content search across files.

## 6. Milestones

| Milestone | Scope | Done when |
| --- | --- | --- |
| **M0 Spike** | Scaffold, connection through `codex-realtime`, binary relay. Measure latency locally and through Connect, bare and with a 40k digest loaded. Check worklet vs CSP and route auth over Connect. | The model talks back over the Codex sign-in, latency numbers are written down, and the capture path is chosen. |
| **M1 Talk with context** | Panel and overlay engine, thread digest, live updates via the row map, `read_thread`, barge-in. SQLite store, reconnect and rollover. Idle limit, hard cap, one session per server. | A 15-minute discussion about a real thread works, recalls earlier options correctly, and survives a forced reconnect. |
| **M2 Act** | Read tools with confinement, `send_to_chat`, `stop_agent`, the gate, announcements, sent log with undo. Tests against a fake Realtime socket. | The flow in section 1 works end to end. Tests prove that gated calls are refused in follow-up and out-of-band responses, that a second gated call for the same utterance is refused, and that reads outside the workspace or of secret files are refused. |
| **M3 Harden** | Voice history and resume summary, settings polish, content search (if wanted), CI, README, tagged release, install line. | Installs from git on a clean bb, tests are green, and the owner uses it for a week. |

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| OpenAI stops accepting the Codex sign-in for Realtime. | The provider is a plugin contract. Switch to another `realtimeConnection` plugin by setting; an API key provider is a small v2 addition. |
| `experimental_` SDK APIs change. | Pin the SDK, keep the bb surface in one module, and re-test on each bb update. |
| The voice model drifts when writing a message. | The panel shows the exact sent text, queued messages can be undone, and "stop it" stops a turn. |
| Instructions hidden in thread, file or git content. | The gate limits where and how often gated calls happen, reads are confined to the workspace and secrets are denied, and M2 tests cover it. A send on an utterance that did not ask for one remains possible (section 4.4). |
| Latency through the Connect tunnel, or from a large context prefix. | Measure both in M0, tune the digest budget, and revisit WebRTC if needed. |
| Cost against the ChatGPT plan. | Idle limit, hard cap, and no session until you start one. |

## 8. Credits

- Voice Mode (MIT): the audio capture, barge-in and relay patterns are adapted
  from it, with attribution in the code.
- `codex-realtime`: the connection contract.
- Nothing is taken from Handsfree, which has no licence.
