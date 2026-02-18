---
name: clawietalkie
description: Walkie-talkie voice connection to the user — send voice messages and generate setup links for the ClawieTalkie app
metadata: {"openclaw":{"requires":{"tools":["clawietalkie_send"]}}}
---

# ClawieTalkie

You have a walkie-talkie voice connection to the user via ClawieTalkie.

## Setup

When a user wants to set up ClawieTalkie on their device, use `clawietalkie_setup_link` with your name to generate a one-click setup link. Send the link to the user — clicking it opens the macOS app with everything pre-configured.

## Sending voice messages

Use `clawietalkie_send` to proactively send voice messages when:

- You complete a task the user asked about
- You have an important update or reminder
- Something time-sensitive needs their attention

Keep messages SHORT (one sentence, max 15 words). No emojis. Plain spoken text only.
