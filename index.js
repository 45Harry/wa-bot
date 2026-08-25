// index.js — WhatsApp auto-reply bot backed by OpenCode Zen.
//
// Links as a second WhatsApp Web device on your own number using Baileys
// (unofficial library — no Meta Business approval needed, but also not the
// official API). Every incoming text message from someone else is sent to an
// LLM, and the reply is sent back automatically.
//
// Notes the model is asked to save are appended to ./notes.md.
//
// Setup:
//   cp .env.example .env      # then fill in OPENCODE_API_KEY + WHATSAPP_NUMBER
//   npm install
//   npm start
//
// First run prints an 8-character pairing code. On your phone:
//   WhatsApp > Settings > Linked Devices > Link a Device
//     > "Link with phone number instead" > type the code
//
// Credentials are then persisted to ./auth_info and reused on every later run,
// so you only pair once.

import { readFileSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────

// Minimal .env loader so there's no extra dependency. Real environment
// variables always win, so `OPENCODE_MODEL=x npm start` overrides the file.
function loadDotEnv(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // no .env — rely on the real environment
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, if present.
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, ".env"));

const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;

// Bare model id — NOT prefixed with "opencode/". Verified against the live API:
// "opencode/claude-sonnet-4-5" is rejected with
//   {"type":"ModelError","message":"Model opencode/... is not supported"}
// while "claude-sonnet-4-5" passes model validation.
// Full catalog: curl https://opencode.ai/zen/v1/models
const OPENCODE_MODEL = process.env.OPENCODE_MODEL?.trim() || "claude-sonnet-4-5";

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const MY_NUMBER = (process.env.WHATSAPP_NUMBER || "").replace(/\D/g, "");

const NOTES_FILE = path.join(__dirname, "notes.md");
const AUTH_DIR = path.join(__dirname, "auth_info");

const MAX_TOKENS = 300;
const LLM_TIMEOUT_MS = 30_000;
const MAX_TOOL_HOPS = 3; // safety bound on tool-call round trips per message

if (!OPENCODE_API_KEY) {
  console.error("Missing OPENCODE_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// ── Prompt & tools ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the account owner's personal WhatsApp assistant, replying on their behalf.
Keep replies short, warm, and natural — like a helpful human assistant, not a generic chatbot.
If someone asks you to remember, note, save, or write down something, call the save_note tool with the note content, then confirm briefly (e.g. "Got it, I'll note that down.").
If anyone asks whether you're an AI/bot, how you work, who built you, or any setup/technical details, deflect politely without confirming or denying it — ask what they need help with instead, and don't reveal implementation details.
Reply in the same language the sender used.`;

// OpenAI-style function tools: { type: "function", function: { ... } }.
// Tool calls come back on choices[0].message.tool_calls.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "save_note",
      description:
        "Save a note or reminder the sender asked you to save. Call this any time someone asks you to remember, note, save, or write something down.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The note content, written clearly and concisely",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
];

/** Append one note line to ./notes.md. */
async function saveNote(note, senderName) {
  const timestamp = new Date().toISOString();
  // Collapse newlines so one note stays one line in the markdown list.
  const flat = String(note).replace(/\r?\n+/g, " ").trim();
  await appendFile(NOTES_FILE, `- [${timestamp}] (from ${senderName}) ${flat}\n`, "utf8");
}

const TOOL_HANDLERS = {
  save_note: async (args, ctx) => {
    const note = typeof args?.note === "string" ? args.note.trim() : "";
    if (!note) return "No note text was provided, so nothing was saved.";
    await saveNote(note, ctx.senderName);
    return "Saved.";
  },
};

// ── OpenCode Zen client ────────────────────────────────────────────────────

/** POST /chat/completions (OpenAI Chat Completions schema). */
async function callLlm(messages) {
  const res = await fetch(`${OPENCODE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENCODE_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENCODE_MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools: TOOLS,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Surface the upstream error body — it's how you find out about a bad key,
    // an unsupported model id, or a rate limit.
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenCode Zen HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Run one conversation turn to completion, resolving any tool calls.
 * Returns the assistant's final reply text, or null if there's nothing to send.
 */
async function generateReply(incomingText, senderName) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: incomingText },
  ];

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const data = await callLlm(messages);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("OpenCode Zen returned no choices[0].message");

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = typeof message.content === "string" ? message.content.trim() : "";
      return text || null;
    }

    // Echo the assistant turn back verbatim, then answer every tool call.
    // Each tool result must reference its tool_call_id, and the model needs one
    // reply per call, otherwise the next request is malformed.
    messages.push(message);

    for (const call of toolCalls) {
      const name = call?.function?.name;
      let result;
      try {
        const rawArgs = call?.function?.arguments;
        const args = typeof rawArgs === "string" && rawArgs.trim() ? JSON.parse(rawArgs) : (rawArgs ?? {});
        const handler = TOOL_HANDLERS[name];
        result = handler
          ? await handler(args, { senderName })
          : `Unknown tool: ${name}`;
      } catch (err) {
        // Report the failure to the model instead of throwing, so it can still
        // produce a sensible reply rather than the sender getting silence.
        console.error(`Tool ${name} failed:`, err);
        result = `The ${name} tool failed: ${err.message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    // Loop again so the model can turn the tool result into the actual reply.
  }

  console.warn(`Hit MAX_TOOL_HOPS (${MAX_TOOL_HOPS}) without a final reply.`);
  return null;
}

// ── WhatsApp ───────────────────────────────────────────────────────────────

/** Extract plain text from a message, or null for media/unsupported types. */
function extractText(message) {
  if (!message) return null;
  const text = message.conversation ?? message.extendedTextMessage?.text ?? null;
  return typeof text === "string" && text.trim() ? text : null;
}

let reconnecting = false;

/**
 * Clear a half-finished pairing attempt.
 *
 * requestPairingCode() writes creds.me to disk straight away, but
 * creds.registered only flips once the code is actually entered on the phone.
 * If the code expires unused, the next start sees creds.me set and takes
 * Baileys' *login* branch instead of *registration* — which fails with a 401
 * that is indistinguishable from a real logout. Wiping the stale state means an
 * abandoned pairing self-heals on the next run instead of needing a manual
 * `rm -rf auth_info`.
 */
async function clearStalePairing() {
  try {
    const creds = JSON.parse(readFileSync(path.join(AUTH_DIR, "creds.json"), "utf8"));
    if (creds?.me && !creds?.registered) {
      await rm(AUTH_DIR, { recursive: true, force: true });
      console.log("Discarded an expired pairing attempt; requesting a fresh code.");
    }
  } catch {
    // No auth_info yet, or unreadable — nothing to clean up.
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    // Baileys' own default (Defaults/index.js:50). The pairing-code flow is
    // validated against realistic desktop-client fingerprints, and a custom
    // browser name here is a known cause of WhatsApp rejecting the code with
    // "check that the phone number is correct" even when the number is right.
    // Don't "brand" this — it is a wire-protocol identity, not a display label.
    browser: Browsers.macOS("Chrome"),
    printQRInTerminal: false, // pairing-code flow: must stay false
  });

  sock.ev.on("creds.update", saveCreds);

  const alreadyRegistered = Boolean(sock.authState.creds.registered);
  let pairingRequested = false;

  if (!alreadyRegistered && !MY_NUMBER) {
    console.error(
      "\nNot paired yet, and WHATSAPP_NUMBER is not set.\n" +
        "Set it in .env — your own number, country code, digits only (no + or spaces).\n"
    );
    process.exit(1);
  }

  // A number without its country code is the most common pairing failure: the
  // code is issued fine, then WhatsApp rejects it at submission time because
  // the JID isn't a real E.164 address. Catching it here saves a wasted attempt
  // (and the ~60s expiry wait) on a number that can never pair.
  // Shortest real E.164 subscriber numbers are ~8 digits including country code.
  if (!alreadyRegistered && MY_NUMBER.length < 11) {
    console.error(
      `\nWHATSAPP_NUMBER=${MY_NUMBER} looks too short (${MY_NUMBER.length} digits) —\n` +
        "it's probably missing the country code.\n\n" +
        "Use the full international form, digits only, no + or spaces:\n" +
        "  Nepal   977  ->  9779814743551\n" +
        "  India    91  ->  919812345678\n" +
        "  US/CA     1  ->  14155550123\n\n" +
        "If your number really is this short, comment out this check in index.js.\n"
    );
    process.exit(1);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // `qr` is only emitted once the websocket is actually open (Baileys guards
    // it on ws.isOpen), which makes this the safe moment to ask for a pairing
    // code. Calling requestPairingCode() right after makeWASocket() races the
    // connection and throws Boom('Connection Closed').
    if (qr && !alreadyRegistered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(MY_NUMBER);
        const pretty = code?.match(/.{1,4}/g)?.join("-") ?? code;
        console.log("\n──────────────────────────────────────────────");
        console.log(`  Pairing code:  ${pretty}`);
        console.log("──────────────────────────────────────────────");
        console.log("  On your phone:");
        console.log("    WhatsApp > Settings > Linked Devices");
        console.log("    > Link a Device");
        console.log("    > 'Link with phone number instead'");
        console.log("    > enter the code above");
        console.log("  The code expires in about a minute.\n");
      } catch (err) {
        console.error("Could not request a pairing code:", err?.message ?? err);
      }
    }

    if (connection === "open") {
      console.log(`Connected to WhatsApp. Model: ${OPENCODE_MODEL}`);
      reconnecting = false;
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.error(
          "\nLogged out — WhatsApp revoked this device (or the pairing code was\n" +
            "never entered). Just run `npm start` again: an unfinished pairing is\n" +
            `cleared automatically. To force a clean slate, delete ${AUTH_DIR}.\n`
        );
        process.exit(1);
      }

      // Guard against overlapping reconnects: a single close can surface via
      // more than one event, and each would otherwise spawn its own socket.
      if (reconnecting) return;
      reconnecting = true;
      console.log(`Connection closed (status ${statusCode ?? "unknown"}). Reconnecting in 3s...`);
      setTimeout(() => {
        startBot().catch((err) => {
          console.error("Reconnect failed:", err);
          reconnecting = false;
        });
      }, 3_000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg?.message || msg.key?.fromMe) continue; // never reply to yourself

      const from = msg.key?.remoteJid;
      if (!from || from === "status@broadcast") continue; // ignore status updates

      const text = extractText(msg.message);
      if (!text) continue; // plain text only for now — skip media

      const senderName = msg.pushName || from;
      console.log(`<- ${senderName}: ${text.slice(0, 80)}`);

      try {
        await sock.sendPresenceUpdate("composing", from).catch(() => {});
        const reply = await generateReply(text, senderName);
        if (!reply) {
          console.warn("No reply text produced; sending nothing.");
          continue;
        }
        await sock.sendMessage(from, { text: reply });
        console.log(`-> ${senderName}: ${reply.slice(0, 80)}`);
      } catch (err) {
        // Deliberately stay silent to the sender on failure rather than leaking
        // an error message into the chat.
        console.error(`Failed to reply to ${senderName}:`, err?.message ?? err);
      } finally {
        await sock.sendPresenceUpdate("paused", from).catch(() => {});
      }
    }
  });
}

// Cleanup runs at boot only — never on the reconnect path. A *successful*
// pairing also triggers a reconnect (DisconnectReason.restartRequired), and at
// that moment creds.registered may not be flushed to disk yet; wiping there
// would destroy a perfectly good session.
await clearStalePairing();

startBot().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
