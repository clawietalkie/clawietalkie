# ClawieTalkie — OpenClaw Plugin

Walkie-talkie voice interface for your [OpenClaw](https://openclaw.ai) agent. Pairs with the ClawieTalkie iOS and macOS apps.

## Install

```bash
openclaw plugins install clawietalkie
```

Or from source:

```bash
git clone https://github.com/say26/clawietalkie.git
openclaw plugins install ./clawietalkie/openclaw-plugin
```

Then restart OpenClaw:

```bash
openclaw restart
```

## What it does

- **`/clawietalkie/talk`** — receives audio from the app, transcribes it, sends it to your agent, converts the response to speech, and returns the audio
- **`send_voice` tool** — lets your agent proactively send voice messages to your phone via push notification

## Configure the app

Open ClawieTalkie on your device and enter:

- **Gateway URL** — your OpenClaw gateway address (e.g. `https://your-server.com`)
- **Gateway Token** — found in `~/.openclaw/openclaw.json` under `gateway.auth.token`

## Requirements

- OpenClaw with TTS configured (OpenAI, ElevenLabs, or any supported provider)
- ClawieTalkie app ([iOS](https://apps.apple.com/app/clawietalkie) / [macOS](https://github.com/say26/clawietalkie/releases))
