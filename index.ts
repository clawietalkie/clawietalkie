import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createSign, randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Constants — all paths relative to plugin directory                 */
/* ------------------------------------------------------------------ */

const PLUGIN_DIR = __dirname;
const DATA_DIR = join(PLUGIN_DIR, "data");
const DEVICES_PATH = join(DATA_DIR, "devices.json");
const MESSAGES_PATH = join(DATA_DIR, "messages.json");
const AUDIO_DIR = join(DATA_DIR, "audio");
const APNS_CONFIG_PATH = join(PLUGIN_DIR, "apns.json");
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
    req.resume();
  });
}

async function readBodyRaw(req: IncomingMessage): Promise<Buffer> {
  // Try async iterator first (handles stream state more robustly)
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (e: any) {
    throw new Error("Body read error: " + (e.message || e));
  }
}

/** Ask the agent via the Gateway's internal WebSocket RPC. */
async function getAgentResponse(
  api: any,
  message: string = "clawietalkie_request",
  agentIdOverride?: string,
): Promise<string> {
  const port = api.config?.gateway?.port || 18789;

  // Resolve gateway auth from config (plugin runs inside the gateway process).
  const authCfg = api.config?.gateway?.auth || {};
  const gwToken = authCfg.token || "";
  const gwPassword = authCfg.password || "";
  const authMode: string = authCfg.mode || (gwPassword ? "password" : "token");
  const connectAuth: any =
    authMode === "password" && gwPassword
      ? { password: gwPassword }
      : gwToken
        ? { token: gwToken }
        : undefined;

  var connectId = "ct-conn-" + Date.now();
  var agentId =
    "ct-agent-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  return new Promise(function (resolve, reject) {
    var settled = false;
    var phase = "challenge";

    var ws = new WebSocket("ws://127.0.0.1:" + port);

    var timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch (_) {}
        reject(new Error("Agent request timed out after 120s"));
      }
    }, 120000);

    function finish(err: any, text?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (_) {}
      if (err) reject(err);
      else resolve(text || "");
    }

    ws.onmessage = function (event: any) {
      var raw =
        typeof event.data === "string" ? event.data : String(event.data);
      var data: any;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        return;
      }

      if (data.type === "event" && data.event === "connect.challenge") {
        phase = "connecting";
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "gateway-client",
                displayName: "ClawieTalkie",
                version: "1.0.0",
                platform: process.platform,
                mode: "backend",
              },
              auth: connectAuth,
              scopes: ["operator.write"],
            },
          }),
        );
        return;
      }

      if (data.type === "res" && data.id === connectId) {
        if (!data.ok) {
          var connErr = data.error
            ? data.error.message || data.error.code
            : "Connect rejected";
          finish(new Error("Gateway auth failed: " + connErr));
          return;
        }
        phase = "connected";
        api.logger.info(
          "[clawietalkie] WS connected (connId: " +
            (data.payload &&
              data.payload.server &&
              data.payload.server.connId) +
            ")",
        );

        var targetAgent = agentIdOverride || "main";
        ws.send(
          JSON.stringify({
            type: "req",
            id: agentId,
            method: "agent",
            params: {
              message: message,
              idempotencyKey: agentId,
              agentId: targetAgent,
              sessionKey: "agent:" + targetAgent + ":clawietalkie",
            },
          }),
        );
        return;
      }

      if (data.type === "res" && data.id === agentId) {
        if (
          phase === "connected" &&
          data.ok &&
          data.payload &&
          data.payload.status === "accepted"
        ) {
          phase = "accepted";
          api.logger.info(
            "[clawietalkie] Agent request accepted (runId: " +
              (data.payload.runId || agentId) +
              ")",
          );
          return;
        }

        if (!data.ok) {
          var errMsg = data.error
            ? data.error.message || data.error.code
            : "Agent request failed";
          finish(new Error(errMsg));
          return;
        }

        var p = data.payload;
        if (!p) {
          finish(new Error("Empty payload from agent"));
          return;
        }

        if (p.status === "error") {
          finish(new Error("Agent error: " + (p.summary || "unknown")));
          return;
        }

        var result = p.result;
        if (typeof result === "string") {
          finish(null, result);
        } else if (result && typeof result === "object") {
          var payloads = result.payloads;
          if (
            Array.isArray(payloads) &&
            payloads.length > 0 &&
            typeof payloads[0].text === "string"
          ) {
            finish(null, payloads[0].text);
          } else {
            var text = result.text || result.content || result.message;
            if (typeof text === "string") {
              finish(null, text);
            } else {
              api.logger.warn(
                "[clawietalkie] Unexpected result shape: " +
                  JSON.stringify(result).slice(0, 300),
              );
              finish(null, JSON.stringify(result));
            }
          }
        } else {
          finish(new Error("Empty result from agent"));
        }
        return;
      }
    };

    ws.onerror = function (err: any) {
      finish(new Error("WebSocket error: " + (err.message || String(err))));
    };

    ws.onclose = function () {
      finish(new Error("WebSocket closed unexpectedly (phase: " + phase + ")"));
    };
  });
}

/* ------------------------------------------------------------------ */
/*  STT — Speech-to-Text                                              */
/*  Config: pluginConfig.stt.{provider, apiKey, baseUrl, model}        */
/*  Fallback: env vars (ELEVENLABS_API_KEY > OPENAI_API_KEY > ...)    */
/* ------------------------------------------------------------------ */

/** Read an env var from process.env or gateway config env.vars. */
function getEnvVar(api: any, name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const vars = api.config?.env?.vars;
  if (vars && vars[name]) return vars[name];
  return undefined;
}

/** Default base URLs and models per provider. */
const STT_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  elevenlabs: { baseUrl: "https://api.elevenlabs.io/v1", model: "scribe_v1" },
  openai:     { baseUrl: "https://api.openai.com/v1",    model: "gpt-4o-mini-transcribe" },
  groq:       { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
  deepgram:   { baseUrl: "https://api.deepgram.com/v1",  model: "nova-3" },
};

/** Env var fallback order (tried when pluginConfig.stt is not set). */
const STT_ENV_FALLBACKS: { id: string; envKey: string }[] = [
  { id: "elevenlabs", envKey: "ELEVENLABS_API_KEY" },
  { id: "openai",     envKey: "OPENAI_API_KEY" },
  { id: "groq",       envKey: "GROQ_API_KEY" },
  { id: "deepgram",   envKey: "DEEPGRAM_API_KEY" },
];

/** Resolve STT provider from plugin config, falling back to env vars. */
function resolveSTTProvider(api: any): {
  id: string;
  apiKey: string;
  baseUrl: string;
  model: string;
} | null {
  // 1. Explicit plugin config takes priority
  const stt = api.pluginConfig?.stt;
  if (stt?.provider && stt?.apiKey) {
    const id = stt.provider.trim().toLowerCase();
    const defaults = STT_DEFAULTS[id] || STT_DEFAULTS.openai;
    return {
      id,
      apiKey: stt.apiKey,
      baseUrl: stt.baseUrl?.trim() || defaults.baseUrl,
      model: stt.model?.trim() || defaults.model,
    };
  }

  // 2. Fall back to env vars
  for (const fb of STT_ENV_FALLBACKS) {
    const apiKey = getEnvVar(api, fb.envKey);
    if (!apiKey) continue;
    const defaults = STT_DEFAULTS[fb.id];
    return { id: fb.id, apiKey, baseUrl: defaults.baseUrl, model: defaults.model };
  }
  return null;
}

/** Call ElevenLabs Scribe API (different auth + field names from OpenAI). */
async function transcribeElevenLabs(
  apiKey: string,
  baseUrl: string,
  model: string,
  audioBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/speech-to-text";

  const form = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], {
    type: "application/octet-stream",
  });
  form.append("file", blob, fileName || "audio.m4a");
  form.append("model_id", model);

  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`ElevenLabs STT HTTP ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as any;
  const text = data.text?.trim();
  if (!text) throw new Error("ElevenLabs STT response missing text");
  return text;
}

/** Call the OpenAI-compatible /audio/transcriptions endpoint.
 *  Works with OpenAI, Groq, and any compatible router (ares, etc). */
async function transcribeOpenAICompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  audioBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/audio/transcriptions";

  const form = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], {
    type: "application/octet-stream",
  });
  form.append("file", blob, fileName || "audio.m4a");
  form.append("model", model);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`STT HTTP ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as any;
  const text = data.text?.trim();
  if (!text) throw new Error("STT response missing text");
  return text;
}

async function transcribeAudio(
  api: any,
  audioBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const provider = resolveSTTProvider(api);
  if (!provider) {
    throw new Error(
      "No STT provider available — set ELEVENLABS_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, or DEEPGRAM_API_KEY",
    );
  }

  api.logger.info(
    `[clawietalkie] STT via ${provider.id} (${provider.baseUrl}, model=${provider.model})`,
  );
  const transcribeFn =
    provider.id === "elevenlabs"
      ? transcribeElevenLabs
      : transcribeOpenAICompatible;
  const text = await transcribeFn(
    provider.apiKey,
    provider.baseUrl,
    provider.model,
    audioBuffer,
    fileName,
  );

  api.logger.info("[clawietalkie] STT result: " + (text || "").slice(0, 200));
  return text;
}

/* ------------------------------------------------------------------ */
/*  TTS — Text-to-Speech (uses OpenClaw's built-in TTS)               */
/* ------------------------------------------------------------------ */

function wrapPcmAsWav(
  pcm: Buffer,
  sampleRate: number,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function textToSpeech(api: any, text: string): Promise<Buffer> {
  const result = await api.runtime.tts.textToSpeechTelephony({
    text,
    cfg: api.config,
  });
  if (!result.success || !result.audioBuffer) {
    throw new Error("TTS failed: " + (result.error || "no audio"));
  }
  // textToSpeechTelephony returns raw PCM — wrap in WAV header
  const sampleRate = result.sampleRate || 22050;
  return wrapPcmAsWav(result.audioBuffer, sampleRate);
}

/* ------------------------------------------------------------------ */
/*  APNs Push Notifications                                           */
/* ------------------------------------------------------------------ */

interface APNsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
  bundleId: string;
  environment?: "sandbox" | "production";
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createAPNsJWT(
  keyId: string,
  teamId: string,
  privateKeyPem: string,
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = base64url(
    JSON.stringify({
      iss: teamId,
      iat: Math.floor(Date.now() / 1000),
    }),
  );
  const signingInput = `${header}.${claims}`;

  const sign = createSign("SHA256");
  sign.update(signingInput);
  const signature = sign.sign({
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  } as any);

  return `${signingInput}.${base64url(signature)}`;
}

async function loadAPNsConfig(
  logger: any,
): Promise<{ config: APNsConfig; key: string } | null> {
  try {
    if (!existsSync(APNS_CONFIG_PATH)) return null;
    const raw = await readFile(APNS_CONFIG_PATH, "utf-8");
    const config: APNsConfig = JSON.parse(raw);
    if (!config.keyId || !config.teamId || !config.keyPath || !config.bundleId)
      return null;
    const resolvedKeyPath = isAbsolute(config.keyPath)
      ? config.keyPath
      : join(PLUGIN_DIR, config.keyPath);
    if (!existsSync(resolvedKeyPath)) {
      logger.warn("[clawietalkie] APNs key file not found: " + resolvedKeyPath);
      return null;
    }
    const key = await readFile(resolvedKeyPath, "utf-8");
    return { config, key };
  } catch (e: any) {
    logger.warn(
      "[clawietalkie] Failed to load APNs config: " + (e.message || e),
    );
    return null;
  }
}

async function sendPush(
  deviceToken: string,
  jwt: string,
  bundleId: string,
  payload: object,
  logger: any,
  environment: "sandbox" | "production" = "sandbox",
  pushType: "alert" | "pushtotalk" = "alert",
): Promise<void> {
  const http2 = await import("node:http2");
  const host =
    environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    let settled = false;

    client.on("error", (err: any) => {
      if (!settled) {
        settled = true;
        reject(new Error("HTTP/2 error: " + err.message));
      }
    });

    const body = JSON.stringify(payload);
    const apnsTopic =
      pushType === "pushtotalk" ? `${bundleId}.voip-ptt` : bundleId;
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": apnsTopic,
      "apns-push-type": pushType,
      "apns-priority": "10",
      "apns-expiration": "0",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });

    let responseData = "";
    let responseStatus = 0;

    req.on("response", (headers: any) => {
      responseStatus = Number(headers[":status"]) || 0;
    });

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      responseData += chunk;
    });

    req.on("end", () => {
      client.close();
      if (!settled) {
        settled = true;
        if (responseStatus === 200) {
          resolve();
        } else {
          logger.warn(
            "[clawietalkie] APNs push failed: " +
              responseStatus +
              " " +
              responseData,
          );
          reject(new Error(`APNs ${responseStatus}: ${responseData}`));
        }
      }
    });

    req.on("error", (err: any) => {
      client.close();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Device & Message Storage (per-device queue)                       */
/* ------------------------------------------------------------------ */

interface Device {
  deviceId: string;
  platform: string;
  pushToken: string | null;
  agentName?: string;
  registeredAt: number;
  lastSeen: number;
}

interface Message {
  id: string;
  text: string;
  audioFile: string;
  contentType: string;
  timestamp: number;
  targetDeviceId?: string; // If set, only deliver to this device
}

async function loadDevices(): Promise<Device[]> {
  try {
    if (!existsSync(DEVICES_PATH)) return [];
    const raw = await readFile(DEVICES_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveDevices(devices: Device[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DEVICES_PATH, JSON.stringify(devices, null, 2));
}

async function loadMessages(): Promise<Message[]> {
  try {
    if (!existsSync(MESSAGES_PATH)) return [];
    const raw = await readFile(MESSAGES_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveMessages(messages: Message[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MESSAGES_PATH, JSON.stringify(messages, null, 2));
}

async function cleanupExpiredMessages(messages: Message[]): Promise<Message[]> {
  const now = Date.now();
  const keep: Message[] = [];

  for (const msg of messages) {
    if (now - msg.timestamp > MESSAGE_TTL_MS) {
      try {
        if (msg.audioFile && existsSync(msg.audioFile))
          await unlink(msg.audioFile);
      } catch {}
    } else {
      keep.push(msg);
    }
  }

  return keep;
}

async function deleteMessage(
  messages: Message[],
  messageId: string,
): Promise<Message[]> {
  const keep: Message[] = [];
  for (const msg of messages) {
    if (msg.id === messageId) {
      try {
        if (msg.audioFile && existsSync(msg.audioFile))
          await unlink(msg.audioFile);
      } catch {}
    } else {
      keep.push(msg);
    }
  }
  return keep;
}

function generateMessageId(): string {
  return "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/** Queue a voice message and send push notifications.
 *  If targetDeviceId is set, only deliver to that device; otherwise broadcast to all. */
async function queueMessageAndPush(
  api: any,
  text: string,
  audioBuffer: Buffer,
  targetDeviceId?: string,
): Promise<string> {
  await mkdir(AUDIO_DIR, { recursive: true });
  const msgId = generateMessageId();
  const audioPath = join(AUDIO_DIR, msgId + ".wav");
  await writeFile(audioPath, audioBuffer);

  const messages = await loadMessages();
  const msg: Message = {
    id: msgId,
    text,
    audioFile: audioPath,
    contentType: "audio/wav",
    timestamp: Date.now(),
  };
  if (targetDeviceId) msg.targetDeviceId = targetDeviceId;
  messages.push(msg);
  const cleaned = await cleanupExpiredMessages(messages);
  await saveMessages(cleaned);

  const devices = await loadDevices();
  api.logger.info(
    "[clawietalkie] Queued message " +
      msgId +
      ": " +
      audioBuffer.length +
      " bytes" +
      (targetDeviceId
        ? " (target: " + targetDeviceId.substring(0, 8) + "...)"
        : " (broadcast)") +
      ", " +
      devices.length +
      " devices registered",
  );

  // Only push to target device if specified, otherwise all
  const pushDevices = targetDeviceId
    ? devices.filter((d) => d.pushToken && d.deviceId === targetDeviceId)
    : devices.filter((d) => d.pushToken);
  if (pushDevices.length > 0) {
    const apns = await loadAPNsConfig(api.logger);
    if (apns) {
      const jwt = createAPNsJWT(
        apns.config.keyId,
        apns.config.teamId,
        apns.key,
      );
      for (const device of pushDevices) {
        try {
          await sendPush(
            device.pushToken!,
            jwt,
            apns.config.bundleId,
            { aps: {}, agentName: device.agentName || getAgentName(api) },
            api.logger,
            apns.config.environment || "sandbox",
            "pushtotalk",
          );
          api.logger.info(
            "[clawietalkie] Push sent to " +
              device.deviceId.substring(0, 8) +
              "...",
          );
        } catch (e: any) {
          api.logger.error(
            "[clawietalkie] Push failed for " +
              device.deviceId.substring(0, 8) +
              "...: " +
              (e.message || e),
          );
        }
      }
    }
  }

  return msgId;
}

/* ------------------------------------------------------------------ */
/*  Auth — verify secret key                                             */
/* ------------------------------------------------------------------ */

/** Holds the active secret key for the current process (survives config-set before restart). */
let activeSecretKey: string | null = null;

function getSecretKey(api: any): string | null {
  if (activeSecretKey) return activeSecretKey;
  return (
    api.pluginConfig?.secretKey ||
    api.config?.plugins?.entries?.clawietalkie?.config?.secretKey ||
    null
  );
}


function verifyAuth(req: IncomingMessage, api: any): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (!token) return false;

  const secretKey = getSecretKey(api);
  if (!secretKey) {
    api.logger.warn("[clawietalkie] No secretKey configured — rejecting all requests");
    return false;
  }

  return token === secretKey;
}

async function persistSecretKey(api: any, key: string): Promise<void> {
  try {
    const cfg = api.config;
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    if (!cfg.plugins.entries.clawietalkie) cfg.plugins.entries.clawietalkie = {};
    if (!cfg.plugins.entries.clawietalkie.config)
      cfg.plugins.entries.clawietalkie.config = {};
    cfg.plugins.entries.clawietalkie.config.secretKey = key;
    await api.runtime.config.writeConfigFile(cfg);
    api.logger.info("[clawietalkie] Secret key persisted to config file.");
  } catch (e: any) {
    api.logger.warn(
      "[clawietalkie] Failed to persist secret key: " + (e.message || e),
    );
  }
}

function getAgentName(api: any): string {
  return (
    api.pluginConfig?.agentName ||
    api.config?.plugins?.entries?.clawietalkie?.config?.agentName ||
    "main"
  );
}

const DEFAULT_VOICE_PROMPT =
  "[CLAWIETALKIE — You MUST reply in ONE short sentence, MAX 15 words. No emojis. No special characters. No quotes. Plain spoken text ONLY. Do NOT use tools.] ";

function getVoicePrompt(api: any): string {
  const custom =
    api.pluginConfig?.voicePrompt ||
    api.config?.plugins?.entries?.clawietalkie?.config?.voicePrompt;
  return custom ? custom + " " : DEFAULT_VOICE_PROMPT;
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                            */
/* ------------------------------------------------------------------ */

const clawieTalkiePlugin = {
  id: "clawietalkie",
  name: "ClawieTalkie",
  description:
    "Walkie-talkie voice interface — relays audio between the ClawieTalkie app and your OpenClaw agent.",
  register(api: any) {
    api.logger.info("[clawietalkie] Registering routes and tools...");

    // Auto-generate secret key on first run if not configured
    const existingKey = getSecretKey(api);
    if (!existingKey) {
      const generated = "sk-ct-" + randomBytes(16).toString("hex");
      activeSecretKey = generated;
      persistSecretKey(api, generated);
      api.logger.info("[clawietalkie] Auto-generated and persisted secret key.");
    } else {
      activeSecretKey = existingKey;
    }

    /** STT → AI → TTS pipeline. Returns result for caller to deliver. */
    async function processTalkAudio(
      audioData: Buffer,
      fileName: string,
      audioSource: string,
      agentId?: string,
    ): Promise<{ text: string; audioBuffer: Buffer } | null> {
      const t0 = Date.now();
      const transcribedText = await transcribeAudio(api, audioData, fileName);
      if (!transcribedText || !transcribedText.trim()) {
        api.logger.warn("[clawietalkie] /talk: empty transcription, skipping");
        return null;
      }
      api.logger.info(
        "[clawietalkie] Transcribed (" +
          (Date.now() - t0) +
          "ms): " +
          transcribedText.slice(0, 200),
      );

      const t1 = Date.now();
      api.logger.info("[clawietalkie] Requesting AI response...");
      const agentResponse = await getAgentResponse(
        api,
        getVoicePrompt(api) + transcribedText,
        agentId,
      );
      api.logger.info(
        "[clawietalkie] Agent response (" +
          (Date.now() - t1) +
          "ms): " +
          agentResponse.slice(0, 300),
      );

      let ttsText = agentResponse
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
        .replace(/([)("!?])\1{2,}/g, "$1")
        .replace(/"{2,}/g, "")
        .trim();
      if (ttsText.length > 150) {
        const truncated = ttsText.slice(0, 150);
        const lastSentence = truncated.search(/[.!?)]\s*[^.!?)]*$/);
        ttsText =
          lastSentence > 30
            ? truncated.slice(0, lastSentence + 1)
            : truncated;
        api.logger.warn(
          "[clawietalkie] Truncated response from " +
            agentResponse.length +
            " to " +
            ttsText.length +
            " chars",
        );
      }

      const t2 = Date.now();
      const audioBuffer = await textToSpeech(api, ttsText);
      api.logger.info(
        "[clawietalkie] TTS generated " +
          audioBuffer.length +
          " bytes (" +
          (Date.now() - t2) +
          "ms), total: " +
          (Date.now() - t0) +
          "ms",
      );

      return { text: ttsText, audioBuffer };
    }

    // ──────────────────────────────────────────────────────
    //  HTTP Route: POST /clawietalkie/talk  (synchronous)
    //  Holds connection open while STT → AI → TTS runs,
    //  returns response audio directly in the HTTP body.
    // ──────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: "/clawietalkie/talk",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        if (!verifyAuth(req, api)) {
          sendUnauthorized(res);
          return;
        }

        try {
          const talkUrl = new URL(req.url || "/", "http://localhost");
          const senderDeviceId =
            talkUrl.searchParams.get("deviceId") || undefined;
          const audioSource = talkUrl.searchParams.get("source") || "unknown";
          const agentId = talkUrl.searchParams.get("agentId") || undefined;

          api.logger.info(
            "[clawietalkie] /talk POST" +
              " source=" +
              audioSource +
              (agentId ? " agent=" + agentId : "") +
              (senderDeviceId
                ? " device=" + senderDeviceId.substring(0, 8) + "..."
                : "") +
              " content-length=" +
              (req.headers["content-length"] || "unknown"),
          );

          // Raw binary body
          const fileName = "recording.m4a";
          let audioData: Buffer;
          const gatewayBody = (req as any).body;
          if (gatewayBody && gatewayBody.length > 0) {
            audioData = Buffer.isBuffer(gatewayBody) ? gatewayBody : Buffer.from(gatewayBody);
          } else {
            audioData = await readBodyRaw(req);
          }
          if (audioData.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Empty body" }));
            return;
          }

          api.logger.info(
            "[clawietalkie] /talk received " +
              audioData.length + " bytes" +
              " source=" + audioSource +
              (senderDeviceId ? " device=" + senderDeviceId.substring(0, 8) + "..." : ""),
          );

          // Synchronous: process STT → AI → TTS and return audio in response
          const result = await processTalkAudio(audioData, fileName, audioSource, agentId);

          if (!result) {
            // Empty transcription — nothing to respond with
            res.writeHead(204);
            res.end();
            return;
          }

          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": String(result.audioBuffer.length),
          });
          res.end(result.audioBuffer);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          api.logger.error("[clawietalkie] /talk error: " + message);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: message }));
          }
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  HTTP Route: /clawietalkie/pending  (GET / DELETE)
    // ──────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: "/clawietalkie/pending",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!verifyAuth(req, api)) {
          sendUnauthorized(res);
          return;
        }

        if (req.method === "GET") {
          const getUrl = new URL(req.url || "/", "http://localhost");
          const deviceId = getUrl.searchParams.get("deviceId");

          let messages = await loadMessages();
          const beforeCount = messages.length;
          messages = await cleanupExpiredMessages(messages);
          // Remove entries whose audio file is missing to prevent blocking the queue
          messages = messages.filter((m) => existsSync(m.audioFile));
          if (messages.length !== beforeCount) {
            await saveMessages(messages);
          }

          // Return first message eligible for this device:
          // - targeted messages: only if targetDeviceId matches
          // - broadcast messages (no targetDeviceId): any device can pick it up
          const pending = deviceId
            ? messages.find(
                (m) => !m.targetDeviceId || m.targetDeviceId === deviceId,
              )
            : messages[0];
          if (!pending) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No pending audio" }));
            return;
          }

          try {
            const audioBuffer = await readFile(pending.audioFile);

            // Claim on read: delete broadcast messages immediately so no other device gets them.
            // For targeted messages, only one device can see them anyway.
            if (!pending.targetDeviceId) {
              messages = await deleteMessage(messages, pending.id);
              await saveMessages(messages);
            }

            res.writeHead(200, {
              "Content-Type": pending.contentType,
              "Content-Length": String(audioBuffer.length),
              "X-Message-Id": pending.id,
            });
            res.end(audioBuffer);
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        } else if (req.method === "DELETE") {
          const delUrl = new URL(req.url || "/", "http://localhost");
          const messageId = delUrl.searchParams.get("messageId");

          if (!messageId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "messageId query param required" }),
            );
            return;
          }

          let messages = await loadMessages();

          // Delete message immediately — first device to acknowledge wins
          messages = await deleteMessage(messages, messageId);

          const cleaned = await cleanupExpiredMessages(messages);
          await saveMessages(cleaned);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  HTTP Route: POST /clawietalkie/register
    // ──────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: "/clawietalkie/register",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        if (!verifyAuth(req, api)) {
          sendUnauthorized(res);
          return;
        }

        try {
          const body = JSON.parse(await readBody(req));
          const { deviceId, platform, pushToken, agentName } = body;
          if (!deviceId || typeof deviceId !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "deviceId required" }));
            return;
          }

          const devices = await loadDevices();
          const now = Date.now();
          const existing = devices.find((d) => d.deviceId === deviceId);
          if (existing) {
            existing.platform = platform || existing.platform;
            existing.pushToken =
              pushToken !== undefined ? pushToken || null : existing.pushToken;
            if (agentName) existing.agentName = agentName;
            existing.lastSeen = now;
          } else {
            devices.push({
              deviceId,
              platform: platform || "unknown",
              pushToken: pushToken || null,
              agentName: agentName || undefined,
              registeredAt: now,
              lastSeen: now,
            });
          }
          await saveDevices(devices);
          api.logger.info(
            "[clawietalkie] Registered device: " +
              deviceId.substring(0, 8) +
              "... (" +
              (platform || "unknown") +
              ")",
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message || String(e) }));
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  Agent Tool: clawietalkie_send
    // ──────────────────────────────────────────────────────
    api.registerTool({
      name: "clawietalkie_send",
      label: "Send Voice Message",
      description:
        "Send a voice message to the user's device via ClawieTalkie. Provide the text to speak — the plugin handles TTS.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The text to convert to speech and send as a voice message",
          },
        },
        required: ["text"],
      } as any,
      async execute(toolCallId: string, params: any): Promise<any> {
        const text = params.text;
        if (!text) {
          return {
            content: [
              {
                type: "text",
                text: "Error: text parameter is required",
              },
            ],
            details: { error: "missing text" },
          };
        }

        try {
          api.logger.info(
            "[clawietalkie] clawietalkie_send TTS for: " + text.slice(0, 100),
          );
          const audioBuffer = await textToSpeech(api, text);
          api.logger.info(
            "[clawietalkie] clawietalkie_send: " +
              audioBuffer.length +
              " bytes",
          );

          const msgId = await queueMessageAndPush(api, text, audioBuffer);

          return {
            content: [
              {
                type: "text",
                text: `Voice message sent! (${msgId}) TTS: ${audioBuffer.length} bytes.`,
              },
            ],
            details: { audioSize: audioBuffer.length, messageId: msgId },
          };
        } catch (e: any) {
          api.logger.error(
            "[clawietalkie] clawietalkie_send error: " + (e.message || e),
          );
          return {
            content: [
              {
                type: "text",
                text: "Failed to send voice message: " + (e.message || e),
              },
            ],
            details: { error: e.message || String(e) },
          };
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  Agent Tool: clawietalkie_get_secret_key
    // ──────────────────────────────────────────────────────
    api.registerTool({
      name: "clawietalkie_get_secret_key",
      label: "Get ClawieTalkie Secret Key",
      description:
        "Returns the ClawieTalkie secret key so the user can configure the app on their device.",
      parameters: { type: "object", properties: {} } as any,
      async execute(): Promise<any> {
        const key = getSecretKey(api);
        if (!key) {
          return {
            content: [
              {
                type: "text",
                text: "No ClawieTalkie secret key is configured.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: key,
            },
          ],
        };
      },
    });

    // ──────────────────────────────────────────────────────
    //  Agent Tool: clawietalkie_rotate_secret_key
    // ──────────────────────────────────────────────────────
    api.registerTool({
      name: "clawietalkie_rotate_secret_key",
      label: "Rotate ClawieTalkie Secret Key",
      description:
        "Generates a new ClawieTalkie secret key, replacing the old one. All connected devices will need to update their key.",
      parameters: { type: "object", properties: {} } as any,
      async execute(): Promise<any> {
        const newKey = "sk-ct-" + randomBytes(16).toString("hex");
        activeSecretKey = newKey;
        await persistSecretKey(api, newKey);
        api.logger.info("[clawietalkie] secret key rotated and persisted");
        return {
          content: [
            {
              type: "text",
              text: `Secret key rotated and persisted. New key: ${newKey}\n\nAll devices must update their key to reconnect.`,
            },
          ],
        };
      },
    });

    api.logger.info(
      "[clawietalkie] Plugin ready (routes: /clawietalkie/talk, /clawietalkie/pending, /clawietalkie/register; tools: clawietalkie_send, clawietalkie_get_secret_key, clawietalkie_rotate_secret_key)",
    );
  },
};

export default clawieTalkiePlugin;
