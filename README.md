# Phreak

A realtime voice layer for [bb](https://getbb.app) chats. Open it beside a
thread, talk the chat through with a voice model that knows the whole
conversation, and when you say "send that", it writes the message and sends it
into the thread.

- **Discusses, doesn't relay.** The voice model holds the thread's transcript
  and keeps it current, so you can ask "what were the options again?" and get an
  answer instead of a new agent turn.
- **Looks things up.** It reads the chat, other threads, files and git in the
  workspace, read-only.
- **Acts when you say so.** "Send that" composes a clear message from what you
  decided and sends it. "Tell it now" steers a running turn. "Stop it" stops the
  agent.
- **Runs on your ChatGPT plan.** The voice comes from OpenAI Realtime through
  the Codex sign-in, via the
  [`codex-realtime`](https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime)
  plugin. Any plugin that offers a `realtimeConnection` works too. OpenAI does
  not document this use of the ChatGPT sign-in, so it may stop working at any
  time; see [the risk note](SPEC.md#41-provider-codex-through-realtimeconnection).

**Status:** spec stage, nothing to install yet. See [SPEC.md](SPEC.md).

## License

MIT
