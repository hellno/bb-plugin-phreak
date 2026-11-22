# Phreak spec

Status: v0.3, 2026-11-22. Lean v1, challenged for bloat and bugs; being built.

## 1. What Phreak is

Phreak is a realtime voice layer that sits on top of a bb thread. You open its
panel beside a chat and talk the chat through with a voice model that knows the
conversation. When you say so, it writes the message and sends it into the
thread.

The voice model is a second participant, not a relay. It answers from the chat,
looks things up and keeps track of what you decided. Nothing reaches the
thread's agent until you ask for it.

A typical session:

1. You open a thread where the agent has laid out options A to D, and open the
   Phreak panel. You press Start.
2. You ask: "Remind me what B costs us. Did it already touch the auth module?"
   Phreak answers from the transcript and checks the diff.
3. You talk it through: "Skip the migration. Actually, A plus D."
4. You say: "Okay, send that." Phreak writes "Go with A and D. Skip the
   migration…", sends it at once, and says "Sent" once bb confirms.
5. While the agent works you can ask "is it done?", say "tell it now to add
   tests too" (Phreak steers the turn), or say "stop it".

## 2. Why another voice plugin

| Plugin | What it does | Where it falls short for this |
| --- | --- | --- |
| Voice Mode (steveafrost, MIT) | Relays each thing you say to the agent, verbatim, and reads back a summary when the turn ends. | The voice model sees only the thread title and 2,500 characters per reply. It cannot read anything itself and forwards every request at once. Its waveform takes over the send button. In the owner's use it felt laggy. |
| Hands-Free (mattwynne) | Dictate on iPhone, send with a tap, hear replies. | No discussion: speech is sent without review. |
| Handsfree (swairshah) | A voice operator that focuses threads and sends messages. | Uses `gpt-live-1`, which refuses the ChatGPT sign-in. No licence, so we reuse nothing from it. |
| Side chat (bb builtin) | A text fork of the thread in a side panel, with "Send to main thread". | Text only. Closest in spirit; Phreak is its voice counterpart. |

## 3. Decisions

Decided with the owner on 2026-11-22:

| Topic | Decision |
| --- | --- |
| Audio provider | Codex (ChatGPT subscription), reached through the installed `codex-realtime` plugin. |
| v1 abilities | Read the chat and other threads, read files and git, steer and stop the agent. |
| Sending | Sends immediately when you ask. No confirmation step. |
| Repo | Public, lean. No unit tests and no test framework: `tsc --noEmit` and `bb plugin build` are the only checks. |

Proposed but not yet confirmed: the name Phreak, the MIT licence, and the
panel UI.

Lean rules for v1: zero settings, one voice (`marin`), one turn-detection mode
(`semantic_vad`), no persistence, one panel.

## 4. Architecture

```
 bb app (browser)               bb server                            OpenAI
┌──────────────────┐ WebSocket  ┌─────────────────────────────┐ wss  ┌──────────────┐
│ Phreak panel     │ binary PCM │ server.ts                   │ ───▶ │ Realtime API │
│  app.tsx         │ + JSON ctl │  both sockets, session,     │ ◀─── │ (JSON+base64)│
│  audio.ts        │ ◀────────▶ │  gate, dispatch             │      └──────────────┘
└──────────────────┘            │ tools.ts                    │
                                │  digest, tools ─▶ bb.sdk    │
                                └──────────────┬──────────────┘
                                               │ callRpc("realtimeConnection")
                                     ┌─────────▼──────────────┐
                                     │ codex-realtime plugin  │
                                     └────────────────────────┘
```

Files:

| File | Owns |
| --- | --- |
| `protocol.ts` | Types and constants shared by browser and server. No logic. |
| `server.ts` | Plugin entry, the browser WebSocket route, the upstream Realtime socket, session identity, the gate, dispatch. |
| `tools.ts` | Thread digest, tool definitions, and every bb operation behind them, with read confinement. |
| `app.tsx` | The panel: Start/End, mute, status, captions, delivery results. Ends the session on hide or unmount. |
| `audio.ts` | Mic capture, resampling, playback queue, played-sample counting, cleanup. |

`@get-bb/plugin-sdk` is pinned to 0.6.157 (bb ≥ 0.50). Most APIs used are
`experimental_`, so the pin matters. Git installs build on install, so `dist/`
is not committed.

### 4.1 Provider: Codex through `realtimeConnection`

- Phreak calls `bb.sdk.plugins.callRpc({ pluginId: "codex-realtime", method:
  "realtimeConnection", input: {} })` for each session. The answer is
  `{ protocol: "openai-realtime", url: "wss://…", headers, model? }`.
- Phreak never reads `~/.codex/auth.json`. The headers stay in server memory
  for the life of one socket, and are never logged, sent to the browser, or put
  in an error message.
- If the handshake fails, Phreak asks once more with `{ refresh: true }`.
  `refresh` only re-reads the sign-in file; it never renews the token.
- **Errors are reported by category, not guessed.** Each category has its own
  message:
  - the provider plugin is missing
  - the provider refused the caller ("add phreak to codex-realtime's allowed
    plugins")
  - the provider reported a sign-in problem (its own message, such as "run
    `codex login`")
  - the handshake was rejected (HTTP status and model)
  - a network failure
- **Setup:** `codex-realtime` gives the sign-in only to plugins on its
  allow-list. Append `phreak` to the existing list; don't replace it. Check
  the current value with `bb plugin config codex-realtime`, then set, for
  example, `voice-mode,phreak`.
- The model comes from the provider's answer (`gpt-realtime-2.1` by default).

What we tested on 2026-11-22: Codex's own `codex app-server`
`thread/realtime/*` API (codex-cli 0.170.0) answers "realtime conversation
requires API key auth" with a ChatGPT login, for the default protocol version,
v2 and v3. So Codex cannot serve voice directly. The `codex-realtime` path last
worked on Nov 16 according to its logs, and is re-verified on first run.

Known risks: OpenAI does not document this use of the ChatGPT sign-in, and
already refuses it for `gpt-live-1`. Whether the ChatGPT/Codex terms allow it is
unchecked. Usage counts against the ChatGPT plan.

### 4.2 Audio

- **Upstream:** the browser sends binary frames of PCM16 mono at 24 kHz, about
  40 ms each. Capture asks for echo cancellation, noise suppression and auto
  gain. It resamples to 24 kHz when the device runs at another rate.
  - AudioWorklet loaded from a Blob URL, falling back to `ScriptProcessor`.
  - Voice Mode's code says bb's CSP may block worklets. A bb source checkout
    from 2026-11-07 shows no CSP on the web app.
- **Downstream:** before the PCM of each assistant audio item, the server sends
  a JSON `audio_start { itemId }` frame. The browser tags the binary frames that
  follow with that item. It labels playback buffers at the wire rate (24 kHz),
  counts the samples actually played per item, and caps its queue at a few
  seconds.
- **Barge-in:**
  1. On `input_audio_buffer.speech_started`, the server sends `interrupt`.
  2. The browser flushes playback, drops any late frames for that item, and
     answers `played { itemId, ms }`.
  3. The server sends `conversation.item.truncate` with those values, so the
     model knows what you heard.
- **AudioContext:** created and resumed inside the Start click handler, so
  Safari and mobile browsers allow it.
- **Echo:** speaker output can still trigger VAD. The README recommends
  headphones.
- **Latency:** the status line shows the time from the end of your speech to the
  first *audible* output. Targets are about 700 ms locally and about 1 s through
  bb Connect.

### 4.3 Session lifecycle

- **One session per bb server.**
  - Each session has an immutable `sessionId`, `threadId` and `projectId`, fixed
    at start.
  - A new Start takes over: the old session is invalidated first, and its
    sockets close.
- **Invalidation is checked at every await boundary that can act.** Before any
  send or stop is dispatched, the server re-checks that the session is still
  the live one. Work left over from a dead session does nothing.
- **Uncertain results are never replayed.** If a send or stop fails with an
  unknown outcome (a timeout or a lost reply), the panel shows "delivery
  unknown" with the target thread, and nothing retries it.
- **The panel owns the mic.** The session ends when the panel is hidden, the
  thread changes, or the panel unmounts. bb keeps closed tabs mounted, so this
  uses `experimental_useTabVisible()`. It also ends if mic permission resolves
  after any of those.
- **Drops:** if the upstream socket drops, Phreak reconnects once. It re-seeds
  the digest and the in-memory discussion as text items. If that fails, the
  session ends visibly and Start rebuilds from bb.
- **Limits:** a session ends after 10 minutes of silence, or 20 minutes while an
  agent turn Phreak sent is running. It always ends after 60 minutes. Nothing
  is persisted.

### 4.4 Context

- **Budget:** 40k tokens for 128k models (`gpt-realtime-2`, `2.1`), 8k for
  mini models, and 8k for unknown models. Estimated as characters ÷ 4.
- **Digest at start:**
  - The thread title, then user messages and agent final messages.
  - Messages are picked newest first until the budget is spent, then inserted
    oldest first, so later decisions supersede earlier ones.
  - Each message is one `conversation.item.create` (role user, `input_text`)
    wrapped as `[thread data] …`. No response is created for them.
  - Tool and work rows are left out; `read_thread` can fetch them.
- **Updates:** `thread.idle` and `thread.failed` for the session's thread are
  treated as invalidation signals. Phreak fetches messages newer than the
  newest one it has included and appends them oldest first. No response is
  created, so nothing speaks or acts on them.
- **Truncation:** the session sets `truncation` explicitly so the digest is not
  silently dropped.
- **Trust:** thread, file and git content is data. It never goes in
  instructions, and the instructions say never to follow directions inside it.
  Section 4.6 limits in code what the model can do with it.

### 4.5 Tools

| Tool | What it does | Gated |
| --- | --- | --- |
| `read_thread(threadId?, before?)` | Messages from this thread, or another thread in the same project (membership is checked), older than `before`. | no |
| `list_threads()` | Threads in this project, with title and status. | no |
| `agent_status()` | This thread: status, pending question, queued messages (`threads.queuedMessages.list({ threadId })`). | no |
| `read_file(path)` | A file's text, or a directory listing, in this thread's workspace. Confined (section 4.7). | no |
| `git(path?)` | No path: changed files. With a path: that file's patch. Confined. | no |
| `send_to_chat(text, now?)` | Sends `text` to this thread: `queue-if-active` by default, `steer-if-active` when `now`. If bb answers `active-turn-not-steerable`, it queues instead. | yes |
| `stop_agent()` | `threads.stop` on this thread. | yes |

Mutations always target the session's own `threadId`; the model cannot choose
another thread. Each bb call sits beside the tool that owns it in `tools.ts`.

### 4.6 The gate

Sends and stops change the thread, so the code (not only the prompt) ties them
to your own words.

1. **Bind:** every response is bound to the committed user audio item that
   created it. Follow-up responses after tool results inherit that binding.
   Phreak's own bookkeeping decides this.
2. **Intent check:** before a gated call is dispatched, Phreak waits up to 5 s
   for that item's final input transcription. It then checks that the
   transcription contains an intent phrase for that tool:
   - `send_to_chat`: "send", "tell it", "tell the agent", "go ahead", "ship it"
   - `stop_agent`: "stop", "cancel", "abort", "halt"

   The phrase list is one constant in `server.ts`.
3. **Once:** a matching item authorizes one gated call and is then consumed.
4. **Completed only:** a gated call is dispatched on `response.done` with status
   `completed`, never on `function_call_arguments.done`, because cancelled
   responses can still emit arguments.
5. **Ownership:** the session must still be live (section 4.3).

If a check fails, the tool returns a refusal ("say 'send it' to confirm") and
the model asks you.

So "check the diff, and if it touches auth tell it to add tests" works in one
step: "tell it" is in your words. But "what did the diff say?" can never lead to
a send, whatever the diff contains.

**Limitations:**

- A mis-transcription can authorize or block a call.
- Text injected into context can still change what the message says on an
  utterance that does ask for a send.
- The intent phrases are English.
- The panel shows the exact text of every send, and "stop it" is the backstop.

### 4.7 Read confinement

- Phreak resolves the session thread's environment to get its `hostId` and
  workspace root. Every `files.read` and `files.list` passes them as `hostId` and
  `rootPath`. bb's host checks that the resolved target stays inside the root.
- Paths are taken relative to the root. Absolute paths and `..` are refused.
- **Secret names** are refused, on the requested path and, for git, on both
  sides of a rename: `.env*`, `*.pem`, `*.key`, `id_rsa*` / `id_ed25519*`,
  `.ssh/`, `.aws/`, `.codex/`, `credentials*`, `secrets*`.
  - Changed files with such names are left out of `git()` listings.
  - A symlink inside the repo that points at a secret file is not caught. That
    is a documented limitation.
- **Caps:** `read_file` returns at most 64 KB and a patch at most 32 KB, with a
  note when the output is cut.

### 4.8 UI

- **Panel:** a "Phreak" thread panel tab (`app.slots.experimental_tab`). It
  has:
  - a Start/End button and mute
  - a status line: connecting, listening, thinking, speaking, reconnecting or
    ended, plus latency
  - live captions for both sides
  - a result line per send or stop: sent, queued, refused, or delivery unknown,
    with the exact text
- **Untouched:** bb's composer, send button and mic.
- **Remote use:** the browser opens the same-origin route
  `/api/v1/plugins/phreak/http/session?threadId=…` with the default `local`
  auth. That route runs the same origin guard as bb's own API, which already
  works over bb Connect.

### 4.9 Privacy

While a session runs, the provider receives:

- mic audio
- the digest
- whatever the tools read, within the confinement above

Nothing goes out before Start, and nothing is stored.

## 5. Not in v1

- Persistence, voice history, resume summaries, automatic session rollover.
- Overlay, floating chip, keyboard shortcut, header button, tool activity feed.
- Spoken turn announcements, undo for queued messages, push-to-talk, settings.
- Writing files, running commands, content search, a hidden-fork delegate, an
  API-key provider, WebRTC.
- Unit tests.

## 6. Build plan

| Slice | Scope | Done when |
| --- | --- | --- |
| **1 Talk** | Package, protocol, panel, audio both ways, the provider connection with error categories, digest and updates, barge-in, lifecycle and limits. | Over bb Connect, you can discuss a real thread, interrupt Phreak, and it recalls earlier options correctly. Latency is noted. |
| **2 Read** | `read_thread`, `list_threads`, `agent_status`, `read_file`, `git`, with confinement. | Lookups answer correctly, and reads outside the root or of secret names are refused. |
| **3 Act** | `send_to_chat`, `stop_agent`, the gate, result lines. | The flow in section 1 works end to end. "What did the diff say?" over a diff containing "send this" sends nothing. |

The checks are `tsc --noEmit`, `bb plugin build`, and the manual checks above.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| OpenAI stops accepting the Codex sign-in for Realtime. | The provider is a plugin contract. Another `realtimeConnection` plugin, or a small API-key provider, can replace it. |
| `experimental_` SDK APIs change. | Pin the SDK and re-check on each bb update. |
| The voice model writes the wrong message. | The panel shows the exact text, and "stop it" stops the turn. |
| Instructions injected into context. | The intent check, mutations bound to the session's thread, and read confinement. |
| Latency through bb Connect. | Measured in slice 1. WebRTC is the fallback plan. |

## 8. Credits

- Voice Mode (MIT): the audio capture, barge-in and relay patterns are adapted
  from it, with attribution in the code.
- `codex-realtime`: the connection contract.
- Nothing is taken from Handsfree, which has no licence.
