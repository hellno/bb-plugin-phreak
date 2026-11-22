# Phreak

A realtime voice layer for [bb](https://getbb.app) chats. Open the Phreak panel
beside a thread, talk the chat through with a voice model that knows the
conversation, and when you say "send that", it writes the message and sends it
into the thread.

- **Discusses, doesn't relay.** The voice model holds the thread's recent
  messages and keeps them current, and pages back through older messages and
  agent work on demand.
- **Looks things up through bb's own agents.** Questions about files, git or
  other threads go to a fresh hidden fork of the thread, the way side chat
  works, and the answer is spoken when it arrives.
- **Acts when you ask, in your own words.** "Send that", "yeah, push it over"
  or "pass that on" sends a message composed from what you decided; "tell it
  now" delivers it into the running turn; "stop it" stops the agent. The panel
  shows bb's status and the exact text of every action.
- **Talks questions through.** When the agent asks you a question card, Phreak
  sees it. Discuss it, say what you picked, and Phreak answers the card.
- **Runs on your ChatGPT plan.** The voice comes from OpenAI Realtime through
  the Codex sign-in, via the
  [`codex-realtime`](https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime)
  plugin. OpenAI does not document this use of the ChatGPT sign-in, so it may
  stop working at any time; see [the risk note](SPEC.md#41-provider).

**Status:** v0.1. A scripted spoken test through the server passed: a reply, a
lookup and a send, with about 0.8 s to first audio. The browser panel is still
untested. See [SPEC.md](SPEC.md).

## Setup

1. Install and sign in to `codex-realtime` (see its README).
2. Let Phreak use it. Append `phreak` to its allowed plugins; don't replace the
   list:

   ```sh
   bb plugin config codex-realtime          # shows the current allowedPlugins
   bb plugin config codex-realtime set allowedPlugins voice-mode,phreak
   ```

3. Install Phreak:

   ```sh
   bb plugin install git:github.com/hellno/bb-plugin-phreak
   ```

## Use

Open a thread, open the **Phreak** panel, press **Start**, and talk. Use
headphones: speaker output can trigger the voice detection. The session ends
when you press End, hide the panel, switch threads, or after 15 quiet minutes.

## Develop

```sh
npm install
npm run typecheck && npm run build
bb plugin install . --yes
```

## License

MIT
