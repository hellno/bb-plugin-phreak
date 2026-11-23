Phreak sits in a panel beside a thread. You talk; it answers from the chat, keeps track of what you decide, and messages the agent when you say so.

## What you get

- **A voice partner that knows the thread.** It holds the recent messages, the agent's work and any question cards, and keeps them current while the agent runs.
- **The agent does the work.** Ask for a check or a change and Phreak sends it to the agent; when it thinks something needs the agent, it asks first. Say "check it yourself" and it looks quietly through a hidden fork of the thread instead.
- **Actions in your own words.** "Send that", "tell it now", "stop it", "take that back", "put it in the chat box" or "start a new thread". Each shows as a card with bb's status and the exact text.
- **News in one line.** Phreak tells you when the agent finishes, fails or asks you something, and can answer the agent's question cards by voice.
- **What is happening, at a glance.** A state chip (Listening, Thinking, Speaking, Muted), a mic level meter, live captions, and errors that lead with the fix.
- **A shortcut.** `Ctrl+Shift+Space` starts or ends a session; the palette lists it as "Phreak: start or end voice".

## Requirements

- bb 0.50 or later.
- The ChatGPT Realtime Connection plugin (`codex-realtime`), with `phreak` added to its allowed plugins.
- The Codex CLI signed in with ChatGPT on the machine running bb, on a plan that includes Codex. Voice use counts against that plan.
- A headset. Phreak's noise filtering is tuned for a close mic.

## Know before you install

OpenAI does not document this use of the ChatGPT sign-in, so it may stop working at any time. While a session runs, your mic audio, the thread's recent messages and any lookup answers go to OpenAI. Nothing goes out before you press Start, and Phreak stores nothing.

Source and setup: [github.com/hellno/bb-plugin-phreak](https://github.com/hellno/bb-plugin-phreak)
