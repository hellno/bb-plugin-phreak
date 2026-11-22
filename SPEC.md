# Phreak spec

Status: draft v0.1, 2026-11-22. Nothing is built yet.

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
   migration…", sends it at once, and says "Sent."
5. While the agent works you can ask "is it done?", or say "tell it to add
   tests too" (Phreak steers the turn), or say "stop it".

## 2. Why another voice plugin

| Plugin | What it does | Where it falls short for this |
| --- | --- | --- |
| Voice Mode (steveafrost, MIT) | Relays each thing you say to the agent, verbatim, and reads back a summary when the turn ends. | The voice model sees only the thread title and 2,500 characters per reply. It cannot read anything itself and forwards every request at once. Users report it as laggy. Its waveform takes over the send button. |
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
| UI | A panel beside the chat. Phreak never touches bb's composer, send button or mic. |
| Repo | Public, MIT. |

## 4. Architecture

```
 bb app (browser)                    bb server                         OpenAI
┌───────────────────────┐   binary   ┌──────────────────────────┐  wss  ┌───────────────┐
│ Phreak panel (tab)    │  WebSocket │ Phreak server            │ ────▶ │ Realtime API  │
│ Audio engine (overlay)│ ◀────────▶ │  session manager         │ ◀──── │ gpt-realtime-*│
│  mic worklet 24k PCM  │            │  context builder         │       └───────────────┘
│  playback worklet     │            │  tool runner ─▶ bb.sdk   │
└───────────────────────┘            │  SQLite log              │
                                     └──────────┬───────────────┘
                                                │ callRpc("realtimeConnection")
                                     ┌──────────▼───────────────┐
                                     │ codex-realtime plugin    │
                                     │ (Codex ChatGPT sign-in)  │
                                     └──────────────────────────┘
```

The plugin is a standard bb package: `server.ts` (backend), `app.tsx`
(frontend), with `@get-bb/plugin-sdk` pinned to the version the scaffold
ships (0.6.157, bb ≥ 0.50). Most APIs used below are `experimental_`, so the pin
matters.

### 4.1 Provider: Codex through `realtimeConnection`

- Phreak asks for a connection over the plugin RPC that Voice Mode already
  uses: `bb.sdk.plugins.callRpc({ pluginId, method: "realtimeConnection" })`.
  The answer is `{ protocol: "openai-realtime", url: "wss://…", headers, model? }`.
- The default `pluginId` is `codex-realtime`. It reads the Codex ChatGPT sign-in
  and returns a bearer header. Phreak never reads `~/.codex/auth.json`, never
  stores the header, and asks again for each session. If the handshake fails it
  asks once more with `{ refresh: true }`.
- `codex-realtime` gives the sign-in only to plugins on its allow-list.
  The owner adds `phreak` there once:
  `bb plugin config codex-realtime set allowedPlugins voice-mode,phreak`.
- Other providers come for free: any plugin that answers `realtimeConnection`
  (for example `realtime-gateway`) works. An OpenAI API key setting can be added
  later behind the same code path.

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

- **Transport (v1):** the browser and the bb server exchange binary frames over
  a plugin WebSocket route (`bb.http.experimental_websocket`). There is no base64
  and no JSON on the audio path. The server relays audio to the Realtime socket.
  Frames are 20 to 40 ms of PCM16 at 24 kHz, about 48 KB/s upstream.
- **Capture and playback:** mic capture runs in an AudioWorklet with echo
  cancellation and noise suppression. Playback goes through a worklet ring
  buffer that can be flushed instantly.
- **Barge-in:** on `input_audio_buffer.speech_started`, Phreak flushes playback
  and sends `conversation.item.truncate` at the last millisecond actually
  played, so the model knows what you heard.
- **Turn detection:** `semantic_vad` by default, with a configurable eagerness.
  Push-to-talk (hold a key or button) is available for noisy places.
- **Latency target:** at most 700 ms locally and at most 1 s through the bb
  Connect tunnel, measured from the end of your speech to the first audio byte.
  The panel shows the measured value.
- **Stretch, decided in M0:** a WebRTC audio path that runs straight from the
  browser to OpenAI, with the server attached as a sideband (`call_id`) for tools.
  It skips the tunnel hop. It depends on whether the Codex sign-in can mint a
  Realtime client secret, and is worth doing only if the relay misses the
  targets.
- **Resilience:**
  - Phreak keeps the conversation state itself, in SQLite: transcripts, tool
    calls and sent messages.
  - If the socket drops, Phreak reconnects with backoff. It seeds the new
    session with the thread digest and the recent voice discussion, and the
    panel shows "reconnecting".
  - When the Realtime session limit nears (about 60 min), Phreak rolls over to a
    fresh session the same way.

### 4.3 Context

This is the core difference from Voice Mode.

- **At start**, Phreak builds a thread digest and adds it as conversation items,
  not as instructions (instructions plus tools are capped at about 16k tokens).
  The model's context is 128k tokens, so:
  - The title, every user message and every agent final message go in full,
    newest first, up to a budget (default 60k tokens).
  - Older turns go in as an outline (`threads.conversationOutline`).
  - Tool and command rows shrink to one line each, for example
    "ran tests: 3 failed".
  - Sources: `threads.timeline`, `threads.output`, `threads.get`.
- **While talking**, Phreak listens to `bb.events` (`thread.idle`,
  `experimental_thread.events`), fetches new rows with
  `threads.timeline({ afterTag })` and appends them silently. When a turn you
  sent finishes, Phreak says one sentence about it (setting `announceTurns`,
  on by default).
- **On demand**, `read_thread` pulls older or full messages.
- **Across sessions**, a short summary of earlier voice discussions on the same
  thread is included, so you can pick up where you left off.
- **Trust:** thread and file content is data. It is wrapped as
  `[thread data]`, never placed in instructions, and the instructions say never
  to follow directions found inside it.

### 4.4 Tools (v1)

| Tool | What it does | bb API | Gated |
| --- | --- | --- | --- |
| `read_thread(range?, query?)` | Older or full messages from this thread. | `threads.timeline`, `threads.message` | no |
| `agent_status()` | Busy, idle, or waiting on you; queued messages. | `threads.get`, `threads.interactions.list`, `threads.queue.list` | no |
| `list_threads()` / `read_other_thread(id)` | Other threads in the project. | `threads.list`, `threads.timeline` | no |
| `list_files(path)` / `read_file(path, lines?)` | Files in the thread's workspace, read-only. | `bb.sdk.files.list`, `bb.sdk.files.read` | no |
| `git_status()` / `git_diff(path?)` | Workspace git state. | `bb--git` plugin RPC | no |
| `send_to_chat(text, mode)` | Sends a message to the thread. `mode` is `auto` (queues while the agent works) or `steer`. | `threads.send` (`queue-if-active` / `steer`) | yes |
| `stop_agent()` | Stops the agent's turn. | `threads.stop` | yes |

**Gating.** A gated tool runs only inside a response chain that started from
your speech:

- Responses the server starts for context updates or announcements are created
  with `tool_choice: "none"`.
- At most one send per thing you say.
- This follows Voice Mode's rule. It matters more here because Phreak holds
  more context and more power.

Content search across files is left out of v1: it needs a host entry to run
`rg` in the workspace. It is a candidate for M3.

### 4.5 Sending

- **Trigger:** only an explicit ask, such as "send that", "tell it…" or "go
  ahead".
- **Text:** the voice model writes the message as a clear instruction that
  carries the decisions from the discussion, the way you would type it. It is
  not a transcript of your words.
- **Delivery:** the message goes out immediately. The panel shows the exact
  text with its state (sent or queued), and Phreak says "Sent" plus a one-line
  gist.
- **Undo:** a queued message can be withdrawn from the panel
  (`queuedMessages.delete`). A sent one cannot; say "stop it" to stop the turn.
- **Agent busy:** the default is to queue. "Steer it" or "tell it now" uses
  `steer`.
- **Origin:** messages carry `originPluginId: "phreak"`, so bb records that the
  plugin sent them.

### 4.6 UI

- **Panel:** a "Phreak" thread panel tab beside the chat
  (`app.slots.experimental_tab`). It shows:
  - a status line: listening, thinking, speaking or reconnecting, plus latency
  - live captions for both sides
  - tool activity lines, for example "read git diff"
  - the log of sent messages
  - mute, push-to-talk and end controls
- **Audio engine:** lives in `app.slots.experimental_appOverlay`, mounted once
  per window. Audio keeps running when you close the panel or switch threads. A
  small floating chip then offers mute, end and a way back.
- **Entry points:**
  - a header button (`experimental_threadAction`, placement `header`)
  - a palette command, "Phreak: start or end", with a default shortcut that does
    not collide with Voice Mode's Ctrl+Shift+V. Rebindable.
- **Untouched:** bb's composer, send button and mic.
- **Remote use:** Phreak must work through the bb Connect URL. M0 checks
  whether the `local` route auth accepts the Connect origin, and picks an auth
  scheme if it does not.

### 4.7 Storage and privacy

- **Stored:** in SQLite under the plugin's data dir, per thread: sessions,
  transcripts, tool calls and sent messages. Audio is never stored.
- **Sent to the provider** while a session runs: mic audio, the thread digest,
  and whatever file or git content the tools read. Nothing goes out before you
  start a session.
- **Time limits:** a session ends after 10 minutes of silence by default. A
  hard cap is configurable.

### 4.8 Settings

| Setting | Default |
| --- | --- |
| `connectionPlugin` | `codex-realtime` |
| `model` | provider's choice |
| `voice` | `marin` |
| `turnDetection` | `semantic_vad` (or `server_vad`, `push_to_talk`) |
| `vadEagerness` | `auto` |
| `announceTurns` | on |
| `idleMinutes` | 10 |
| `contextBudgetTokens` | 60000 |

## 5. Not in v1

- Writing files or running commands. The thread's agent does that.
- Handing deep questions to a hidden fork of the thread (the side-chat
  pattern). This is the main v2 candidate.
- Composer drafts and send confirmation. Possible later as a setting.
- More than one live session per window.
- Providers other than `realtimeConnection` plugins.

## 6. Milestones

| Milestone | Scope | Done when |
| --- | --- | --- |
| **M0 Spike** | Scaffold; connection through `codex-realtime`; binary relay; talk to the bare model; measure latency locally and through Connect; check route auth over Connect; try WebRTC with a sideband if the relay misses the target. | The model talks back over the Codex sign-in, latency numbers are written down, and the transport is chosen. |
| **M1 Talk with context** | Panel and overlay engine, thread digest, live updates, `read_thread`, barge-in, reconnect and rollover. | A 15-minute discussion about a real thread works, with correct recall of earlier options. |
| **M2 Act** | Read tools (threads, files, git), `send_to_chat` with queue and steer, `stop_agent`, gating, sent log with undo. | The core flow in section 1 works end to end, and an injected "send this" inside thread data is ignored. |
| **M3 Harden** | Voice history and resume, idle limits, settings, tests against a fake Realtime socket, CI, README, tagged release, install line. | Installs from git on a clean bb, tests are green, and the owner uses it for a week. |

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| OpenAI stops accepting the Codex sign-in for Realtime. | The provider is a plugin contract. Switch to an API key or a gateway without code changes. |
| `experimental_` SDK APIs change. | Pin the SDK, keep the bb surface in one module, and re-test on each bb update. |
| The voice model drifts when writing a message. | The panel shows the exact sent text, queued messages can be undone, and "stop it" stops a turn. |
| Instructions hidden in thread or file content. | Content is data, gated tools run only after your speech, and there is one send per utterance. |
| Latency through the Connect tunnel. | Measure in M0, and switch the audio path to WebRTC if needed. |
| Cost against the ChatGPT plan. | Idle timeout, hard cap, and no session until you start one. |

## 8. Credits

- Voice Mode (MIT): the audio capture, barge-in and relay patterns are adapted
  from it, with attribution in the code.
- `codex-realtime`: the connection contract.
- Nothing is taken from Handsfree, which has no licence.
