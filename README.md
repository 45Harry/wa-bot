# WhatsApp AI Bot — Auto-replies on your personal number

Links as a second WhatsApp Web device on your own number using Baileys (unofficial library, no Meta Business approval needed). Every incoming text from someone else is sent to an LLM and the reply is sent back automatically.

Notes the model is asked to save are appended to `./notes.md`.

---

## Quick start

```bash
# 1. Install
cd whatsapp-bot
npm install           # or: npm ci

# 2. Fill .env (copy first)
cp .env.example .env
# Then edit .env and set:
#   OPENCODE_API_KEY = your Zen key (sk-...)
#   OPENCODE_MODEL   = claude-sonnet-4-5   (bare id, no "opencode/" prefix)
#   WHATSAPP_NUMBER  = 9779814743551     (country code + digits only, no + or spaces)

# 3. Pair with WhatsApp on your phone
#    a. Get to the code screen first:
#         WhatsApp → Settings → Linked Devices → Link a Device → “Link with phone number instead”
#       Keep that screen open.
#    b. Start the bot:
        npm start
#    c. An 8-character pairing code prints. Type it into the phone screen from step a.
#    d. Leave the process running — do NOT Ctrl+C.

# 4. Test
#    Send a text from another phone:  "remember to buy milk Friday"
#    Check notes.md for the appended line.
```

---

## How it works

- **Baileys** drives WhatsApp Web as a second device on your number. `requestPairingCode()` prints a code; entering it on the phone completes the handshake.
- **OpenCode Zen** (`https://opencode.ai/zen/v1`) is the LLM gateway. Requests go to `POST /chat/completions` with `Authorization: Bearer $OPENCODE_API_KEY`.
- **OpenAI-style tool calling** — the model returns `choices[0].message.tool_calls`; the bot parses them, runs the `save_note` handler (appends to `notes.md`), and feeds the result back so the model can generate the actual reply.
- **Only plain text** is handled — images, audio, and other media are silently skipped.

---

## .env template

```env
# OpenCode Zen (OpenAI-compatible LLM gateway)
OPENCODE_API_KEY=<your Zen API key, starts with "sk-">
OPENCODE_MODEL=claude-sonnet-4-5

# WhatsApp — your number in FULL international form, digits only, no + or spaces.
# Example (Nepal): 9779814743551
WHATSAPP_NUMBER=
```

**Important:** The model id must be **bare** — `claude-sonnet-4-5` not `opencode/claude-sonnet-4-5`. Verified against the live API: the prefixed form is rejected as “Model … is not supported”.

---

## Pairing flow

1. On your phone, navigate to **WhatsApp → Settings → Linked Devices → Link a Device → “Link with phone number instead”** and keep that screen open.
2. Run `npm start`. An 8-character code prints in your terminal.
3. Type that code into the phone screen from step 1.
4. **Leave the process running.** The session is persisted to `./auth_info/` and will auto-reconnect on future runs.
5. If the code expires (~60s), just run `npm start` again — the abandoned attempt is cleared automatically.

**Why it sometimes fails:** The phone number must include its country code in E.164 form. A 10-digit number without a code (e.g. `9814743551`) will issue a code fine, but WhatsApp rejects it at submission time with “check that the phone number is correct”. Always use the full form: `9779814743551` for Nepali numbers, `919812345678` for Indian, `14155550123` for US/Canada.

---

## Notes

Every time the model is asked to remember/save/write something, it calls the `save_note` tool. That handler appends a line to `./notes.md`:

```
- [2026-08-25T10:34:40.073Z] (from Alice) Buy milk on Friday
```

The line includes an ISO timestamp, the sender's WhatsApp display name (`pushName`), and the note text.

---

## LLM replies — billing required

Your OpenCode Zen key authenticates but every completion is refused with `401 CreditsError` until a payment method is added:

https://opencode.ai/workspace/wrk_01KRG2XWMPFRBGC1FGSX352EZF/billing

Once billing is active, any model in Zen's catalog works. Until then the bot connects to WhatsApp and receives messages, but sends nothing back (the console will show `OpenCode Zen HTTP 401 ... CreditsError`).

---

## Project layout

```
whatsapp-bot/
├── index.js          # entry point — baileys + OpenCode Zen + tool handling
├── .env.example      # template — copy to .env and fill
├── .env              # filled in (gitignored)
├── .gitignore        # node_modules/, auth_info/, .env
├── package.json      # ESM, deps: @whiskeysockets/baileys@7.0.0-rc14, @hapi/boom
├── notes.md          # appended-to by the model (created on first save)
└── auth_info/        # persisted Baileys session (created after first pairing)
```

---

## License

MIT (or whatever you choose). No OmniRoute dependency — this is a self-contained bot.