import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Constants — all paths relative to plugin directory                 */
/* ------------------------------------------------------------------ */

const PLUGIN_DIR = __dirname;
const DATA_DIR = join(PLUGIN_DIR, "data");
const PENDING_META_PATH = join(DATA_DIR, "pending-meta.json");
const TOKENS_PATH = join(DATA_DIR, "device-tokens.json");
const APNS_CONFIG_PATH = join(PLUGIN_DIR, "apns.json");

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function readBodyRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse multipart/form-data and extract the first file part's binary data. */
function parseMultipart(body: Buffer, boundary: string): Buffer | null {
  const sep = Buffer.from("--" + boundary);
  const headerEnd = Buffer.from("\r\n\r\n");

  const start = body.indexOf(sep);
  if (start === -1) return null;

  const afterSep = start + sep.length + 2; // skip boundary + \r\n
  const headerEndIdx = body.indexOf(headerEnd, afterSep);
  if (headerEndIdx === -1) return null;

  const dataStart = headerEndIdx + 4; // skip \r\n\r\n
  const nextBoundary = body.indexOf(sep, dataStart);
  if (nextBoundary === -1) return null;

  return body.subarray(dataStart, nextBoundary - 2);
}

/** Ask the agent via the Gateway's internal WebSocket RPC. */
async function getAIResponse(
  api: any,
  message: string = "clawietalkie_request",
): Promise<string> {
  const cfgPort =
    api.config && api.config.gateway && api.config.gateway.port;
  const envPort = process.env.OPENCLAW_GATEWAY_PORT;
  const port = cfgPort || (envPort ? Number(envPort) : 18789);

  const cfgToken =
    api.config &&
    api.config.gateway &&
    api.config.gateway.auth &&
    api.config.gateway.auth.token;
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const token = cfgToken || envToken || "";

  var connectId = "ct-conn-" + Date.now();
  var agentId =
    "ct-agent-" +
    Date.now() +
    "-" +
    Math.random().toString(36).slice(2, 8);

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
              auth: token ? { token: token } : undefined,
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

        ws.send(
          JSON.stringify({
            type: "req",
            id: agentId,
            method: "agent",
            params: {
              message: message,
              idempotencyKey: agentId,
              agentId: "main",
              sessionKey: "clawietalkie",
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
      finish(
        new Error("WebSocket error: " + (err.message || String(err))),
      );
    };

    ws.onclose = function () {
      finish(
        new Error(
          "WebSocket closed unexpectedly (phase: " + phase + ")",
        ),
      );
    };
  });
}

/** Build a 44-byte WAV header for raw PCM (fallback path). */
function pcmToWav(
  pcm: Buffer,
  sampleRate: number = 24000,
  channels: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Load textToSpeech from openclaw's extensionAPI.js
 */
async function loadTextToSpeech(
  logger: any,
): Promise<((params: any) => Promise<any>) | null> {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { pathToFileURL } = await import("node:url");

  const distDir = path.resolve(
    process.execPath,
    "..",
    "..",
    "lib",
    "node_modules",
    "openclaw",
    "dist",
  );

  if (!fs.existsSync(distDir)) return null;

  const files = fs.readdirSync(distDir);
  for (const file of files) {
    if (!file.startsWith("reply-") || !file.endsWith(".js")) continue;
    const filePath = path.join(distDir, file);
    try {
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl);
      const src = fs.readFileSync(filePath, "utf-8");
      const match = src.match(/textToSpeech as (\w+)/);
      if (match) {
        const alias = match[1];
        if (typeof mod[alias] === "function") {
          logger.info(
            "[clawietalkie] textToSpeech found as '" +
              alias +
              "' in " +
              file,
          );
          return mod[alias];
        }
      }
    } catch (e: any) {
      logger.warn(
        "[clawietalkie] Failed to load " +
          file +
          ": " +
          (e.message || e),
      );
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  APNs Push Notifications                                           */
/* ------------------------------------------------------------------ */

interface APNsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
  bundleId: string;
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
  const header = base64url(
    JSON.stringify({ alg: "ES256", kid: keyId }),
  );
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
    if (
      !config.keyId ||
      !config.teamId ||
      !config.keyPath ||
      !config.bundleId
    )
      return null;
    if (!existsSync(config.keyPath)) {
      logger.warn(
        "[clawietalkie] APNs key file not found: " + config.keyPath,
      );
      return null;
    }
    const key = await readFile(config.keyPath, "utf-8");
    return { config, key };
  } catch (e: any) {
    logger.warn(
      "[clawietalkie] Failed to load APNs config: " +
        (e.message || e),
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
): Promise<void> {
  const http2 = await import("node:http2");

  return new Promise((resolve, reject) => {
    const client = http2.connect("https://api.sandbox.push.apple.com");
    let settled = false;

    client.on("error", (err: any) => {
      if (!settled) {
        settled = true;
        reject(new Error("HTTP/2 error: " + err.message));
      }
    });

    const body = JSON.stringify(payload);
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
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
          reject(
            new Error(`APNs ${responseStatus}: ${responseData}`),
          );
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
/*  Pending Audio Storage                                             */
/* ------------------------------------------------------------------ */

async function savePendingAudio(
  audioBuffer: Buffer,
  contentType: string,
  text: string,
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  const ext = contentType.includes("wav")
    ? ".wav"
    : contentType.includes("ogg")
      ? ".ogg"
      : ".mp3";
  const audioPath = join(DATA_DIR, "pending-audio" + ext);

  await writeFile(audioPath, audioBuffer);
  await writeFile(
    PENDING_META_PATH,
    JSON.stringify({
      audioFile: audioPath,
      contentType,
      text,
      timestamp: Date.now(),
    }),
  );
}

async function loadPendingAudio(): Promise<{
  audioBuffer: Buffer;
  contentType: string;
} | null> {
  try {
    if (!existsSync(PENDING_META_PATH)) return null;
    const meta = JSON.parse(
      await readFile(PENDING_META_PATH, "utf-8"),
    );
    if (!existsSync(meta.audioFile)) return null;
    const audioBuffer = await readFile(meta.audioFile);
    return { audioBuffer, contentType: meta.contentType };
  } catch {
    return null;
  }
}

async function clearPendingAudio(): Promise<void> {
  try {
    if (existsSync(PENDING_META_PATH)) {
      const meta = JSON.parse(
        await readFile(PENDING_META_PATH, "utf-8"),
      );
      if (meta.audioFile && existsSync(meta.audioFile))
        await unlink(meta.audioFile);
      await unlink(PENDING_META_PATH);
    }
  } catch {}
}

/* ------------------------------------------------------------------ */
/*  Device Token Storage                                              */
/* ------------------------------------------------------------------ */

async function loadDeviceTokens(): Promise<string[]> {
  try {
    if (!existsSync(TOKENS_PATH)) return [];
    const raw = await readFile(TOKENS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveDeviceTokens(tokens: string[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKENS_PATH, JSON.stringify(tokens));
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                            */
/* ------------------------------------------------------------------ */

const clawieTalkiePlugin = {
  id: "clawietalkie",
  name: "ClawieTalkie",
  description:
    "Walkie-talkie voice interface — relays audio between the ClawieTalkie app and your OpenClaw agent.",
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },

  register(api: any) {
    api.logger.info(
      "[clawietalkie] Registering routes and tools...",
    );

    // Pre-resolve TTS function at registration time
    let ttsFunc: ((params: any) => Promise<any>) | null = null;
    loadTextToSpeech(api.logger)
      .then((fn) => {
        ttsFunc = fn;
        if (fn) {
          api.logger.info(
            "[clawietalkie] textToSpeech loaded from extensionAPI",
          );
        } else {
          api.logger.warn(
            "[clawietalkie] textToSpeech not found, will use telephony fallback",
          );
        }
      })
      .catch(() => {
        api.logger.warn(
          "[clawietalkie] textToSpeech load failed",
        );
      });

    /** Shared TTS helper used by both the HTTP routes and the tool. */
    async function textToAudio(
      text: string,
    ): Promise<{ audioBuffer: Buffer; contentType: string }> {
      if (ttsFunc) {
        const result = await ttsFunc({ text, cfg: api.config });
        if (!result.success || !result.audioPath) {
          throw new Error(result.error || "TTS returned no audio path");
        }
        const audioBuffer = await readFile(result.audioPath);
        let contentType = "audio/mpeg";
        if (result.audioPath.endsWith(".wav"))
          contentType = "audio/wav";
        else if (
          result.audioPath.endsWith(".ogg") ||
          result.audioPath.endsWith(".opus")
        )
          contentType = "audio/ogg";
        api.logger.info(
          "[clawietalkie] TTS OK: " +
            result.provider +
            ", " +
            audioBuffer.length +
            " bytes",
        );
        return { audioBuffer, contentType };
      } else {
        const result =
          await api.runtime.tts.textToSpeechTelephony({
            text,
            cfg: api.config,
          });
        if (!result.success || !result.audioBuffer) {
          throw new Error(
            result.error || "Telephony TTS returned no audio",
          );
        }
        const sampleRate = result.sampleRate || 24000;
        const audioBuffer = pcmToWav(
          result.audioBuffer,
          sampleRate,
        );
        api.logger.info(
          "[clawietalkie] TTS OK (telephony): " +
            result.provider +
            ", " +
            audioBuffer.length +
            " bytes",
        );
        return { audioBuffer, contentType: "audio/wav" };
      }
    }

    // ──────────────────────────────────────────────────────
    //  HTTP Route: POST /clawietalkie/talk
    // ──────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: "/clawietalkie/talk",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        try {
          const contentTypeHeader = req.headers["content-type"] || "";
          const boundaryMatch = contentTypeHeader.match(/boundary=(.+)/);
          if (!boundaryMatch) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing multipart boundary" }));
            return;
          }

          const rawBody = await readBodyRaw(req);
          const audioData = parseMultipart(rawBody, boundaryMatch[1]);
          if (!audioData || audioData.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No audio data found in request" }));
            return;
          }

          api.logger.info(
            "[clawietalkie] /talk received " + audioData.length + " bytes of audio",
          );

          await mkdir(DATA_DIR, { recursive: true });
          const talkAudioPath = join(DATA_DIR, "talk-recording-" + Date.now() + ".m4a");
          await writeFile(talkAudioPath, audioData);

          api.logger.info("[clawietalkie] Saved recording to " + talkAudioPath);
          api.logger.info("[clawietalkie] Requesting AI response...");
          const responseText = await getAIResponse(
            api,
            "walkie_talkie_voice:" + talkAudioPath,
          );

          try { await unlink(talkAudioPath); } catch {}
          api.logger.info(
            "[clawietalkie] Got response (" + responseText.length + " chars)",
          );

          const { audioBuffer, contentType } = await textToAudio(responseText);

          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": String(audioBuffer.length),
          });
          res.end(audioBuffer);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          api.logger.error("[clawietalkie] /talk error: " + message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  HTTP Route: POST /clawietalkie/speak  (legacy)
    // ──────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: "/clawietalkie/speak",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        try {
          await readBody(req);

          api.logger.info("[clawietalkie] Requesting AI response...");
          const text = await getAIResponse(api);
          api.logger.info("[clawietalkie] Got text (" + text.length + " chars)");

          const { audioBuffer, contentType } = await textToAudio(text);

          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": String(audioBuffer.length),
          });
          res.end(audioBuffer);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          api.logger.error("[clawietalkie] Error: " + message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  HTTP Route: /clawietalkie/pending  (GET / DELETE)
    // ──────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: "/clawietalkie/pending",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (req.method === "GET") {
          const pending = await loadPendingAudio();
          if (!pending) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No pending audio" }));
            return;
          }
          res.writeHead(200, {
            "Content-Type": pending.contentType,
            "Content-Length": String(pending.audioBuffer.length),
          });
          res.end(pending.audioBuffer);
        } else if (req.method === "DELETE") {
          await clearPendingAudio();
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

        try {
          const body = JSON.parse(await readBody(req));
          const token = body.deviceToken;
          if (!token || typeof token !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "deviceToken required" }));
            return;
          }

          const tokens = await loadDeviceTokens();
          if (!tokens.includes(token)) {
            tokens.push(token);
            await saveDeviceTokens(tokens);
            api.logger.info(
              "[clawietalkie] Registered device token: " +
                token.substring(0, 8) +
                "...",
            );
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message || String(e) }));
        }
      },
    });

    // ──────────────────────────────────────────────────────
    //  Agent Tool: send_voice
    // ──────────────────────────────────────────────────────
    api.registerTool({
      name: "send_voice",
      label: "Send Voice Message",
      description:
        "Send a proactive voice message to the user's phone via ClawieTalkie push notification. The text will be converted to speech and delivered as a push notification.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The text to convert to speech and send as a push voice message",
          },
        },
        required: ["text"],
      } as any,
      async execute(
        toolCallId: string,
        params: any,
      ): Promise<any> {
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
            "[clawietalkie] send_voice: converting text (" +
              text.length +
              " chars)...",
          );
          const { audioBuffer, contentType } = await textToAudio(text);

          await savePendingAudio(audioBuffer, contentType, text);
          api.logger.info(
            "[clawietalkie] Saved pending audio: " +
              audioBuffer.length +
              " bytes",
          );

          const tokens = await loadDeviceTokens();
          if (tokens.length === 0) {
            api.logger.warn(
              "[clawietalkie] No device tokens registered, skipping push",
            );
            return {
              content: [
                {
                  type: "text",
                  text: "Voice message saved but no devices registered for push notifications.",
                },
              ],
              details: { audioSize: audioBuffer.length, pushSent: false },
            };
          }

          const apns = await loadAPNsConfig(api.logger);
          if (!apns) {
            api.logger.warn(
              "[clawietalkie] APNs not configured, skipping push",
            );
            return {
              content: [
                {
                  type: "text",
                  text: "Voice message saved but APNs not configured. Place apns.json in the plugin directory.",
                },
              ],
              details: { audioSize: audioBuffer.length, pushSent: false },
            };
          }

          const jwt = createAPNsJWT(
            apns.config.keyId,
            apns.config.teamId,
            apns.key,
          );
          let pushCount = 0;
          for (const token of tokens) {
            try {
              await sendPush(
                token,
                jwt,
                apns.config.bundleId,
                {
                  aps: {
                    alert: {
                      title: "Clawie",
                      body: "New voice message",
                    },
                    sound: "default",
                  },
                },
                api.logger,
              );
              pushCount++;
              api.logger.info(
                "[clawietalkie] Push sent to " +
                  token.substring(0, 8) +
                  "...",
              );
            } catch (e: any) {
              api.logger.error(
                "[clawietalkie] Push failed for " +
                  token.substring(0, 8) +
                  "...: " +
                  (e.message || e),
              );
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Voice message sent! TTS: ${audioBuffer.length} bytes, push delivered to ${pushCount}/${tokens.length} devices.`,
              },
            ],
            details: { audioSize: audioBuffer.length, pushSent: true, pushCount },
          };
        } catch (e: any) {
          api.logger.error(
            "[clawietalkie] send_voice error: " + (e.message || e),
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

    api.logger.info(
      "[clawietalkie] Plugin ready (routes: /clawietalkie/talk, /clawietalkie/speak, /clawietalkie/pending, /clawietalkie/register; tool: send_voice)",
    );
  },
};

export default clawieTalkiePlugin;
