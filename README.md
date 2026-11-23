# Phreak

Talk a [bb](https://getbb.app) thread through by voice. Phreak sits in a panel
beside the chat, answers from the conversation, and sends the agent a message
when you say "send that".

- **Knows the thread.** It holds the recent messages, the agent's work and any
  question cards, keeps them current while the agent runs, and pages back
  further when it needs to.
- **Talks with you; the agent does the work.** Anything that needs files, code
  or running something goes to the agent: Phreak sends it when you ask,
  otherwise it offers to. Say "check it yourself" and it looks quietly through
  a hidden fork of the thread instead. What you say about Phreak, like "don't
  research", stays with Phreak.
- **Acts in your own words.** "Send that", "tell it now", "stop it", "take that
  back", "put it in the chat box" or "start a new thread". Each action shows as
  a card with bb's status and the exact text.
- **Keeps you posted.** One short line when the agent finishes, fails or asks
  you something. Talk a question card through and Phreak answers it.
- **Runs on your ChatGPT plan** through
  [`codex-realtime`](https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime).
  OpenAI does not document this use of the ChatGPT sign-in, so it may stop
  working at any time; see [the risk note](SPEC.md#41-provider).

**Status:** v0.1. A scripted spoken test passed (a reply, a lookup and a send,
about 0.8 s to first audio), and its author uses the panel. Not yet tested by
voice: announcements, unsend, drafts, new threads and question cards. See
[SPEC.md](SPEC.md).

## Requirements

- bb 0.50 or later.
- The Codex CLI signed in with **Sign in with ChatGPT** on the machine running
  bb, on a ChatGPT plan that includes Codex. Voice use counts against that plan.
- The ChatGPT Realtime Connection plugin (`codex-realtime`).
- A headset.

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

3. Install Phreak:

   ```sh
   bb plugin install git:github.com/hellno/bb-plugin-phreak
   ```

## Use

Open a thread, open the **Phreak** panel, press **Start**, and talk. Use a
headset: speaker output can trigger the voice detection, and Phreak filters
noise for a close mic. Short pauses rarely end your turn. The session
ends when you press End, hide the panel, switch threads, or stay quiet 15
minutes.

- **Shortcut:** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> (Ctrl on
  macOS too) starts or ends the session, opening the panel if it is hidden.
  Rebind it in Settings → Keyboard.
- **State:** a chip beside the buttons says Connecting, Listening, Muted,
  Thinking, Looking up, Speaking, Reconnecting or Ended, and small bars move
  while the mic hears you. A soft pulse means a reply is on its way; a quiet
  double tick, a lookup is running.
- **Captions:** Phreak's words appear as it speaks. Yours appear as a "You …"
  line the moment you start talking and fill in once you pause.
- **Latency:** turn on **Show reply latency** in Phreak's settings, or run
  `bb plugin config phreak set showLatency true`.

## Privacy

While a session runs, OpenAI receives your mic audio, the thread's recent
messages (about 16k tokens) and the answers of any lookups. Nothing goes out
before you press Start, and Phreak stores nothing.

## Troubleshooting

The panel says how to fix most problems. The common ones:

- **"Allow Phreak in ChatGPT Realtime Connection's settings":** add `phreak` to
  its allowed plugins (Setup step 2).
- **The sign-in expired, or OpenAI refused the connection:** run `codex` once on
  the machine running bb, then press Start.
- **The microphone is blocked:** allow this site to use the microphone in your
  browser.
- **It starts or stops on its own:** use a headset. After a session,
  `bb plugin logs phreak` shows its turn counts; include that line in an issue.

## Develop

```sh
npm install
npm run typecheck && npm run build
bb plugin install . --yes
```

## License

MIT
