# Phreak

A realtime voice layer for [bb](https://getbb.app) chats. Open the Phreak panel
beside a thread, talk the chat through with a voice model that knows the
conversation, and when you say "send that", it writes the message and sends it
into the thread.

- **Discusses, doesn't relay.** The voice model holds the thread's recent
  messages and keeps them current. You can ask "what were the options again?"
  and get an answer instead of a new agent turn. Older messages are fetched on
  demand.
- **Looks things up through bb's own agents.** Questions about files, git or
  other threads go to a hidden fork of the thread, the way side chat works, and
  the answer is spoken when it arrives.
- **Acts only on your words.** "Send that" composes a clear message from what
  you decided and sends it. "Tell it now" steers a running turn. "Stop it" stops
  the agent. A send or stop runs only when your own transcribed words ask for
  it.
- **Runs on your ChatGPT plan.** The voice comes from OpenAI Realtime through
  the Codex sign-in, via the
  [`codex-realtime`](https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime)
  plugin. OpenAI does not document this use of the ChatGPT sign-in, so it may
  stop working at any time; see
  [the risk note](SPEC.md#41-provider-codex-through-realtimeconnection).

**Status:** v0.1. A scripted spoken test through the server passed: a spoken
reply, a lookup, and a gated send, with about 0.8 s to first audio. The browser
panel is still untested. See [SPEC.md](SPEC.md).

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
when you press End, hide the panel, switch threads, or after 10 quiet minutes.

## Develop

```sh
npm install
npm run typecheck && npm run build
bb plugin install . --yes
```

## License

MIT
