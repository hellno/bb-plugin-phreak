# Phreak

Talk a [bb](https://getbb.app) thread through by voice. Phreak sits in a panel
beside the chat, answers from the conversation, and sends the agent a message
when you say "send that".

- **Knows the thread.** It reads the recent messages and question cards,
  catches up each time the agent finishes a turn, and reads the agent's work
  or older messages when it needs to.
- **Talks with you; the agent does the work.** Anything that needs files, code
  or running something goes to the agent: Phreak sends it when you ask,
  otherwise it offers to. Say "check it yourself" and it looks quietly through
  a hidden fork of the thread instead; that runs an agent turn on the thread's
  provider and is read-only by instruction, not by enforcement. What you say
  about Phreak, like "don't research", stays with Phreak.
- **Acts in your own words.** "Send that", "tell it now", "stop it", "take that
  back" (while the message is still queued), "put it in the chat box" or
  "start a new thread". Each action shows as a card with the result and the
  text.
- **Keeps you posted.** One short line when the agent finishes, fails or asks
  you something. Talk a question card through and Phreak answers it.
- **Runs on your ChatGPT plan** through
  [`codex-realtime`](https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime).
  OpenAI does not document this use of the ChatGPT sign-in, so it may stop
  working at any time, and nobody has checked whether the ChatGPT or Codex
  terms allow it; see [the risk note](SPEC.md#41-provider).

**Status:** v0.1. On 2026-11-22 a scripted spoken test of an earlier build
passed through the server (a reply, a lookup and a send, about 0.8 s to the
first audio byte). On 2026-11-23 its author's first voice session showed room
noise taken for speech and cutting replies off. With the noise gate added
since, the author's sessions on 2026-11-24 (AirPods, about 4 minutes) went
well: talking the thread through and sending, with no false starts, and the
gate kept out sounds up to -25 dBFS. Not separately confirmed by voice: stop,
"tell it now", announcements, reconnects, unsend, drafts, new threads and
question cards. See [SPEC.md](SPEC.md).

## Requirements

- bb 0.50 or later.
- The Codex CLI signed in with **Sign in with ChatGPT** on the machine running
  bb, on a ChatGPT plan that includes Codex. Voice use counts against that plan.
- The ChatGPT Realtime Connection plugin (`codex-realtime`).

A headset is recommended: speaker output can trigger the voice detection.

## Setup

1. Install ChatGPT Realtime Connection:

   ```sh
   bb plugin install codex-realtime
   ```

2. Let Phreak use the sign-in: add `phreak` to its allowed plugins, keeping the
   ones already there.

   ```sh
   bb plugin config codex-realtime          # shows allowedPlugins, voice-mode by default
   bb plugin config codex-realtime set allowedPlugins voice-mode,phreak
   ```

3. Install Phreak from bb's community store (Settings → Plugins, or):

   ```sh
   bb plugin install phreak
   ```

   It tracks releases tagged `v0.1.0` and later; bb offers each update and
   never installs one on its own.

## Use

Open a thread, open the **Phreak** panel, press **Start**, and talk. Use a
headset: speaker output can trigger the voice detection, and Phreak filters
noise for a close mic. Short pauses rarely end your turn. The session
ends when you press End, hide the panel, switch threads, stay quiet 15
minutes, or reach 60 minutes.

- **Shortcut:** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> (Ctrl on
  macOS too) starts or ends the session, opening the panel if it is hidden.
  Rebind it in Settings → Keyboard.
- **State:** a chip beside the buttons says Connecting, Listening, Muted,
  Thinking, Looking up, Speaking, Reconnecting or Ended. A soft pulse means a
  reply is on its way; a quiet double tick, a lookup is running.
- **Mic bars:** faint bars show sound the gate is holding back. Full bars show
  audio reaching Phreak. To talk over a reply, speak at your normal headset
  volume. The gate checks for voicing and changes in loudness to screen out
  clothing rustle and passing traffic. Nearby voices and some horns can still
  get through.
- **Captions:** Phreak's words appear as it speaks. Yours appear as a "You …"
  line the moment you start talking and fill in once you pause.
- **Latency:** turn on **Show reply latency** in Phreak's settings, or run
  `bb plugin config phreak set showLatency true`.

## Privacy

While a session runs, OpenAI receives your mic audio and what Phreak reads from
the thread: the recent messages (about 16k tokens at Start), new replies as the
agent finishes turns, the title, status and question cards, older messages or
agent work it pages through (commands, file paths, queries, URLs), action
results, and lookup answers. Only sound Phreak's noise gate takes for speech
leaves your browser; the rest goes out as silence. Nothing goes out before you
press Start. Phreak keeps no audio or transcript; each lookup leaves an
archived hidden thread in bb. bb's plugin log keeps, per session, the turn
counts, your mic's name and settings, and sound levels, never words.

## Troubleshooting

The panel says how to fix most problems. The common ones:

- **"Allow Phreak in ChatGPT Realtime Connection's settings":** add `phreak` to
  its allowed plugins (Setup step 2).
- **The sign-in expired, or OpenAI refused the connection:** run `codex` once on
  the machine running bb, then press Start.
- **The microphone is blocked:** allow this site to use the microphone in your
  browser.
- **It starts or stops on its own:** use a headset, and watch the mic bars.
  Full bars while you are quiet mean the noise passes as speech. After a
  session, `bb plugin logs phreak` ends with two lines, the turn counts and a
  mic report; include both in an issue.
- **It doesn't hear you:** if the bars stay faint while you talk, speak closer
  to the mic, or include the mic report line in an issue.

## Develop

```sh
npm install
npm run typecheck && npm run build
bb plugin install . --yes
```

## License

MIT
