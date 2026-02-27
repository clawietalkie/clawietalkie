# ClawieTalkie — OpenClaw Plugin

Walkie-talkie voice interface for your [OpenClaw](https://openclaw.ai) agent. Pairs with the ClawieTalkie iOS and macOS apps.

The plugin handles the full STT → Agent → TTS pipeline: receives audio from the app, transcribes it (ElevenLabs Scribe or OpenAI Whisper), sends the text to your agent via WebSocket RPC, converts the response to speech, and returns the audio.

## Install

```bash
openclaw plugins install clawietalkie
openclaw restart
```

Or from source:

```bash
git clone https://github.com/clawietalkie/clawietalkie.git
openclaw plugins install ./clawietalkie
```

## Configure the app

On first run the plugin auto-generates a secret key. Retrieve it with:

```bash
openclaw config get plugins.entries.clawietalkie.config.secretKey
```

Open ClawieTalkie on your device and enter:

- **Gateway URL** — your OpenClaw gateway address (e.g. `https://your-server.com`)
- **Secret Key** — the plugin's secret key (see above)

## Config options

Set via `openclaw config set plugins.entries.clawietalkie.config.<key> <value>`:

| Key           | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `secretKey`   | Bearer token for app authentication (auto-generated on first run)            |
| `voicePrompt` | System prompt prepended to transcribed speech (controls response style)      |
| `agentName`   | Display name shown on the device for push notifications (defaults to "main") |

## Requirements

- **TTS and STT must both be configured** in your OpenClaw gateway settings — the plugin uses your existing providers for speech-to-text (to transcribe your voice) and text-to-speech (to generate the agent's voice response)
- ClawieTalkie app ([iOS](https://apps.apple.com/app/clawietalkie) / [macOS](https://github.com/clawietalkie/clawietalkie/releases))
