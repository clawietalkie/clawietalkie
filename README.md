# ClawieTalkie — OpenClaw Plugin

Walkie-talkie voice interface for your [OpenClaw](https://openclaw.ai) agent. Pairs with the ClawieTalkie iOS and macOS apps.

This plugin relays audio between the app and your agent. Your agent handles transcription and speech generation — the plugin just passes audio back and forth.

## Install

```bash
openclaw plugins install clawietalkie
```

Or from source:

```bash
git clone https://github.com/AlexanderZaytsev/clawietalkie-openclaw-plugin.git
openclaw plugins install ./clawietalkie-openclaw-plugin
```

Then restart OpenClaw:

```bash
openclaw restart
```

## What it does

- **`/clawietalkie/talk`** — receives audio from the app, passes it to your agent, returns the agent's audio response
- **`send_voice` tool** — lets your agent proactively send voice messages to your device

## Configure the app

Open ClawieTalkie on your device and enter:

- **Gateway URL** — your OpenClaw gateway address (e.g. `https://your-server.com`)
- **Gateway Token** — found in `~/.openclaw/openclaw.json` under `gateway.auth.token`

## Requirements

- OpenClaw agent with audio transcription and TTS capabilities
- ClawieTalkie app ([iOS](https://apps.apple.com/app/clawietalkie) / [macOS](https://github.com/AlexanderZaytsev/clawietalkie/releases))
