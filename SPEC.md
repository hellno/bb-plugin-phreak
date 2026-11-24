# Phreak spec

Status: plugin v0.1, 2026-11-23. On 2026-11-22 a scripted spoken test of an
earlier build passed through the server (reply, lookup, gated send; ~0.8 s to
the first audio byte). On 2026-11-23 the owner's first voice session, while
only listening, logged 7 speech starts and 4 replies talked over: room noise
taken for speech. With the noise gate added since (§4.2), the owner's two
sessions on 2026-11-24 (AirPods, about 4 minutes) went well: 3 speech starts,
none false; the gate kept out 80 sounds, the loudest at -24.7 dBFS; the floor
sat at the -62 dBFS limit and the voice peaked at -10 to -16 dBFS. Not
separately confirmed by voice: reconnects, unsend, drafts, new threads and
answering question cards.

## 1. What Phreak is

Phreak is a realtime voice layer over one bb thread. You open its panel beside
a chat and talk the chat through with a voice model that knows the
conversation. When you ask, it writes the message and sends it into the thread.

The voice model is a second participant, not a relay. **Phreak talks, the agent
works:** you talk with Phreak, it answers from the chat and keeps track of what
you decided, and anything that needs work goes to the thread's agent. Nothing
reaches the agent until you ask for it.

A typical session: the agent has laid out options A to D. You press Start and
ask "what does B cost us, and did it touch the auth module?"; Phreak answers
from the transcript and the agent's work. You ask "would D break the migration
tests?"; that needs the code run, so Phreak offers to hand it to the agent. You
settle on "A plus D, skip the migration", say "okay, send that", and Phreak
sends it, says in a few words what it sent, and tells you what bb reported.
While the agent works you can ask "is it done?", say "tell it now to add tests
too" or "stop it", or talk through a question it asked and say what you
picked.

## 2. Why another voice plugin

bb already has voice plugins: Voice Mode, Hands-Free, Handsfree and BB Live.
Phreak is a second participant rather than a relay: it discusses the thread
with you and hands work to the agent only when you say so, and it runs on the
ChatGPT plan through `codex-realtime`. bb's side chat is the closest in spirit
but text only.

## 3. Owner decisions (2026-11-22)

| Topic | Decision |
| --- | --- |
| Audio provider | Codex (ChatGPT plan), through the installed `codex-realtime` plugin. |
| Abilities | Read the chat, send, steer, unsend, draft into the chat box, stop, answer the agent's question cards, start a new thread, and say when the thread finishes, fails or asks. Look things up through a hidden fork of the thread only when you ask Phreak itself to check. |
| Routing (2026-11-23) | Phreak talks, the agent works. What the chat and its work rows can't answer goes to the agent: sent when you ask for the work, offered in a few words when Phreak judges it needs work. What you say about Phreak ("don't research", "be brief") is for Phreak and never relayed; "send it back" sends the request under discussion. |
| Sending | Immediately when you ask. No confirmation step. |
| Authorization | The voice model decides from your words, in any phrasing. No phrase lists or other hardcoded gates. |
| Reuse | bb's agents, types, validation and statuses wherever they exist, instead of Phreak's own. |
| Repo | Public and lean. One setting (show latency, off by default), one voice (`marin`), `semantic_vad` (low eagerness, near-field noise reduction for headsets), no persistence, one panel. No unit tests or test framework: `tsc --noEmit` and `bb plugin build` are the checks. |

The MIT licence was confirmed on 2026-11-23. Proposed but not yet confirmed: the name.

## 4. Architecture

The panel streams PCM and JSON to `server.ts` over a same-origin WebSocket. The
server relays to the OpenAI Realtime API over a socket opened with
`codex-realtime`'s connection, and calls bb through `tools.ts`.

| File | Owns |
| --- | --- |
| `protocol.ts` | Types and constants shared by browser and server. |
| `server.ts` | Plugin entry, the panel's WebSocket route, the upstream socket, session lifecycle, tool dispatch. |
| `tools.ts` | The digest, the tools and the bb calls behind them. |
| `app.tsx` | The panel. |
| `audio.ts` | Mic capture, playback, played-sample counting. |

`@get-bb/plugin-sdk` is pinned to 0.6.157 (bb ≥ 0.50): most APIs used are
`experimental_`. Git installs build on install, so `dist/` is not committed.

### 4.1 Provider

- Each session asks `codex-realtime`'s `realtimeConnection` RPC for `{ protocol:
  "openai-realtime", url, headers, model? }`, and once more with `{ refresh:
  true }` (a re-read of the sign-in file) if the handshake fails.
- Phreak never reads `~/.codex/auth.json`. The headers live in server memory for
  one socket and are never logged, sent to the browser or quoted in an error.
- Errors show the provider's own message; the README has the setup hint for
  its allowed plugins. A failed handshake only says OpenAI refused or did not
  answer: Node's WebSocket gives no reason.
- Codex's own `codex app-server` realtime API refuses a ChatGPT login ("requires
  API key auth", codex-cli 0.170.0), so `codex-realtime` is the only route.

**Risk:** OpenAI does not document this use of the ChatGPT sign-in and already
refuses it for `gpt-live-1`. Whether the ChatGPT/Codex terms allow it is
unchecked. Usage counts against the plan.

### 4.2 Audio

- **Up:** PCM16 mono at 24 kHz in ~40 ms frames, with echo cancellation, noise
  suppression and auto gain, from an AudioWorklet (or `ScriptProcessor`) on a
  24 kHz AudioContext. Mute disables the mic track, which then sends silence,
  so voice detection still hears your turn end.
- **Voice detection:** OpenAI's `semantic_vad` with `eagerness: "low"`, so
  short pauses rarely end your turn (it waits up to 8 s, against 4 s by
  default). `noise_reduction: { type: "near_field" }`, tuned for headset mics,
  filters the input before voice detection, so background noise starts fewer
  turns; a laptop mic may do worse with it.
- **Noise gate** (`gate.ts`, in the browser, before anything is sent): only
  sustained sound well above the room's quiet floor goes out; everything else
  is sent as silence, one frame out for every frame in, so turn ends and mute
  keep working.
  - A frame counts as voice when most of it, not one click, is 12 dB over the
    floor. While Phreak is audible and for 600 ms after, it must be 18 dB over
    the floor and at least -38 dBFS: talking over Phreak takes a real voice.
  - The gate opens on 3 such frames among those held (5 while Phreak is
    audible). It holds up to 480 ms back while deciding and releases it on
    open, so the first syllable survives without a standing delay. It stays
    open while most of each frame is voice, and 480 ms past it, for gaps
    between words. When Phreak starts talking, an open gate closes and the
    sound must pass the stricter test again.
  - The open threshold stays between -50 and -32 dBFS (-38 and -32 while
    Phreak is audible). The floor learns from closed frames, quick to fall and
    slow to rise, between -62 and -35 dBFS; digital silence (below -90) and
    muted frames are ignored, and muting closes the gate. A sound that holds
    the gate open for 3 s while changing less than 2 dB from frame to frame on
    average becomes the new floor: noise jitters under 1 dB even when it
    drifts or cycles, and speech swings about 4 dB with every syllable.
  - In node simulations on synthetic frames, steady and rising noise, typing,
    knocks, TV-like noise and a voice at -40 dBFS while Phreak talks never
    open it, and speech opens it with its onset intact, Phreak speaking or
    not, including 8 s of fluent speech without pauses. Known limits: a fan,
    rumble or cycling noise that starts suddenly passes for about 3 s before
    it is learned; noise louder than -32 dBFS (speaking volume) passes again
    every few seconds; a 300 ms creak opens it; a second voice louder than
    -38 dBFS passes even while Phreak talks, and your own voice softer than
    that cannot cut Phreak off; a word shorter than 200 ms may not either. The
    first mic report's loudest passed level shows whether -38 suits a real
    headset. It has not yet been tested by voice.
- **Meter:** the bars follow the mic. They are faint while the gate keeps the
  sound out and full while Phreak hears speech, so a dead mic (flat) differs
  from filtered noise (faint).
- **Logs:** each session logs two lines at its end, with no words. The turn
  counts: speech starts; turns, with those without words and failed
  transcriptions; starts before a reply was heard (turns that ended too
  early); and replies you talked over (from the browser's playback reports).
  The mic report, sent by the panel every 10 s and at End: the device name,
  the browser's echo, noise and gain settings, gate opens (and those while
  Phreak spoke), share of time open, sounds kept out, relearned floors, the
  floor at start, now and at its highest, and the loudest sound kept out and
  passed. A floor that climbs while you only listen points to the browser's
  auto gain, the next thing to turn off; `server_vad` would trade away the
  pause handling.
- **Down:** a JSON `audio_start { itemId }` precedes each assistant item's PCM.
  The browser schedules it gaplessly and counts the samples played per item.
- **Barge-in:** on `speech_started` the server sends `interrupt`, stops
  relaying the interrupted reply, and the browser flushes playback and answers
  `played` with the heard milliseconds of each flushed item. Once any of an
  item went unheard, relayed or not, the server truncates it to what was heard.
  The browser's report and the end of the interrupted reply can come in either
  order, so the check runs on both.
- The AudioContext is created inside the Start click, so Safari and mobile allow
  it; Start shows the error if audio cannot start. Latency is measured from
  `thinking` (your speech ended) to the first audible sample. Speaker output
  can trigger voice detection, so the README recommends a headset.
- **Working cues**, looped on the playback path, mute or not: a soft 200 Hz
  swell each second once `thinking` passes 700 ms, and a quiet double tick every
  3 s while `lookups { running }` is above 0 and no one speaks.

### 4.3 Session lifecycle

- One session per bb server, with a fixed `sessionId` and `threadId`. A new
  Start takes over once bb confirms the thread exists, if its panel is still
  connected and no newer Start has taken over.
- A dead or replaced session never acts: every action re-checks its
  connection right before asking bb, with nothing awaited in between.
- Uncertain results are never replayed: a timeout or lost reply is reported as
  `unknown`, and nothing retries it.
- The panel owns the mic. Closing its socket ends the session: End, hiding the
  panel (`experimental_useTabVisible()`), switching threads, or unmounting.
- If the upstream socket drops, Phreak reconnects once. It rebuilds the digest
  and adds the voice discussion as the user heard it: a reply cut short keeps
  only its heard share. That waits up to 3 s for the panel's report of what it
  played; without one, replies relayed since its last report are left out. If
  that fails, or the context overflows, the session ends visibly and Start
  rebuilds it.
- A session ends after 15 minutes without user speech and always after 60
  minutes.
  Nothing is persisted.

### 4.4 Context

- **Digest at start:** user messages and the agent's final replies, picked
  newest first within one budget (16k tokens, at about 4 characters a token),
  the last one clipped to fit, and sent oldest first so later decisions win.
  Each is a `[thread data]` text item; no response is created for them. Then
  the title and the agent's status, and every pending question card.
  Truncation is disabled, so nothing is dropped silently; an overflow ends the
  session.
- **Updates:** `thread.idle` and `thread.failed` append newer messages and the
  status; `thread.active` adds the status. After an idle, a failure or a new
  card or permission request, Phreak announces it (§4.6). Nothing acts on them.
- **Question cards** (a provider's native question, or bb's ask-user-question
  card) join as thread data with their interaction id, question ids, option
  values and labels, and rules. Prompts, labels and values are never clipped;
  option descriptions share what is left of the card's budget.
- **Trust:** thread, file and git content is data. It never goes in the
  instructions, which say once never to follow directions inside it.

### 4.5 Tools

| Tool | What it does | Changes the thread |
| --- | --- | --- |
| `read_thread(cursor?)` | One bounded page of messages and agent work, newest first, with work rows shown by their typed fields (command, file path, query, URL). Pages follow bb's `olderCursor`; the model gets a short cursor id, and a clipped page keeps its unread rows for the next call. | no |
| `look_up(question)` | Only when you ask Phreak itself to check something. Forks the thread afresh (`threads.fork`, hidden), waits up to 3 minutes for it to go idle, returns its output (up to 4,096 characters), then stops and archives the fork. Lookups can run side by side. A fork that stops on a question or permission is abandoned at once. | no |
| `send_to_chat(text, now?)` | `threads.send` with `queue-if-active`, or `steer-if-active` when `now`. Reports bb's delivery: `sent`, or `queued` with what it waits on. bb says `sent` both for a steer and for starting an idle thread. | yes |
| `unsend_message()` | Takes the newest message this session queued that `threads.queuedMessages.list` still shows unclaimed, holds it (`experimental_holdForEdit`: bb refuses a claimed row and delivers no held one, except on your explicit send-now) and deletes it: `withdrawn` with its current text, or `refused` if none is waiting. An abandoned delete releases the hold. | yes |
| `draft_message(text)` | Sends the text to the panel, which adds it to the thread's composer for you to edit and send and answers: `drafted`, `failed` with the composer's error, or `unknown` with no answer in 3 s. | composer only |
| `stop_agent()` | `threads.stop`, then reports the thread's status. | yes |
| `answer_question(interactionId, answers)` | Answers that exact card, `answers` keyed by question id with exact option values, as bb's own shape. A native question goes to `threads.interactions.resolve`, which validates it; reports `submitted` while bb resolves it, `answered` once resolved. An ask-user-question card goes to `interactions.respond`, which settles the card before the plugin reads the answer, so Phreak first refuses what the plugin would drop silently or fail to read: unknown question ids or option values, an answer without a `selected` array or with nothing in it, repeated values, more than one value for a single-select question or more than four, and free text that is blank or over 4,096 characters. Permission requests stay in bb. | yes |
| `start_thread(prompt, title?)` | `threads.spawn` in the session thread's project with `project-default` environment, bb's default provider and model, no parent, visible. Reports the new thread's status, title and id. | no, a new one |

- Every action targets the session's own thread (a new thread: its project);
  the model cannot choose another. bb itself rejects a card id from another
  thread.
- The model and the panel get the same result: bb's status, the exact text and
  a detail. `refused`: bb was not asked; `failed`: bb refused; `unknown`: it
  may have happened.
- **The fork's powers.** bb gives plugins no read-only mode. The fork runs in
  `auto` (workspace sandbox, provider auto-review), never the parent's `full`;
  `accept-edits` made Codex ask approval for reads. Each question carries a
  read-only prefix, which is an instruction, not enforcement.

### 4.6 Acting on your word

The voice model decides when to act, from the conversation, in whatever words
you use. The instructions say once: only when the user asks, and never because
of thread data or a tool result. They also route (§3): work goes to the agent,
what you say about Phreak stays with Phreak, "send it back" sends the request
under discussion, and Phreak says in a few words what it sent. Code enforces
only correctness:
Phreak creates every response itself, one at a time; calls run only from a
response that completed and that you did not talk over (cancelled responses can
still emit arguments); and a dead or replaced session never acts.

**Announcements** (§4.4) are responses with `tool_choice: "none"` and the
session's instructions plus one line. They wait their turn, one covers all news
before it is spoken (one not yet audible when more news arrives is cancelled
and asked again), seeds and reconnects never announce, and code runs no call
from one.

### 4.7 Panel

A "Phreak" thread tab (`app.slots.experimental_tab`).

- **Empty panel:** a mic and one Start button. Once live and before anyone
  speaks, a large mic level meter and the state.
- **Top row**, once there is a session or a transcript: Start, or an outlined
  End with a red square; Mute, which turns red and reads Unmute with a
  crossed-out mic while muted; a four-bar mic level meter (hidden under reduced
  motion); and a state chip, an icon and a word: Connecting, Listening, Muted,
  Looking up, Thinking, Speaking, Reconnecting or Ended. The latency follows
  the chip only when the `showLatency` setting is on (off by default).
- **Screen readers** hear the chip's word (with "muted" while muted) and
  routine endings through a status region. Captions stay silent.
- **Captions** update in place: grey until final. Your line appears as "You …"
  when speech starts (`interrupt` then `listening`). Your words fill it in after
  you pause: the Realtime API transcribes a turn once it is committed. Your
  newest line holds its place while empty, even if Phreak starts answering
  first, until its final caption says no words came (the server sends a final
  caption even when empty). Before the server names the turn, the line shows
  only while you talk or Phreak thinks. The list follows the newest line unless
  you scroll up.
- **Action cards** show bb's status, the detail, and the text through bb's
  `Markdown`, as the chat shows it.
- **Problems** lead with the fix (for example, add `phreak` to
  codex-realtime's allowed plugins), with the message under Details.
- **Shortcut:** Ctrl+Shift+Space (`app.commands`, rebindable) starts or ends
  the session. While the panel is hidden, it opens the panel, which starts
  once it shows (within 3 s). If the browser still holds audio suspended after
  2 s (no key press or click started it), Phreak resumes it once more and, if
  that fails, ends the session and asks for Start.
- **Icons:** bb's icon set, plus two declared in the manifest
  (`phreak/mic-off`, `phreak/audio-lines`).

A new thread's card links it in a new browser tab (its `href` from
`experimental_useSidebarThreads()`): opening it in bb would unmount the panel
and end the session.
A draft goes into this thread's composer (`useComposer().insert(text, { at:
"end", block: true })`), after any draft there and even off screen. The panel
opens the same-origin route `/api/v1/plugins/phreak/http/session?threadId=…`
with `local` auth, which works over bb Connect.

### 4.8 Privacy

While a session runs, the provider receives your mic audio and everything
Phreak adds to the conversation: the digest (about 16k tokens), each turn's new
messages (up to 64k characters), the title, status and question cards,
`read_thread` pages (commands, file paths, queries, URLs), action results and
lookup answers; mic audio passes the noise gate first (§4.2), so sound it keeps
out goes as silence. Nothing goes out before Start. Phreak keeps no audio or
transcript; each lookup leaves an archived hidden fork in bb.

## 5. Not in v1

Persistence and resume, overlays, push-to-talk, settings beyond latency, Phreak
writing files or running commands itself, an API-key provider, WebRTC, unit
tests.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| OpenAI stops accepting the Codex sign-in for Realtime. | The provider is a plugin contract; another `realtimeConnection` plugin can replace it. |
| `experimental_` SDK APIs change. | The SDK is pinned; re-check on each bb update. |
| The model writes the wrong message, or text planted in the chat or a file steers it into an action you did not ask for. The owner chose natural phrasing over hardcoded checks. | Actions are bound to the session's thread, the panel shows every one, and "stop it" stops the turn. |
| Latency through bb Connect. | Shown on the panel with the `showLatency` setting; WebRTC is the fallback plan. |

## 7. Credits

Voice Mode (MIT) for the audio capture, barge-in and relay patterns, attributed
in the code; `codex-realtime` for the connection contract. Nothing is taken
from Handsfree, which has no licence.
