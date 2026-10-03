import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyDeviceToken } from "@dave/db";
import type { CompletionMessage, ContentBlock } from "@dave/brain";
import { buildImageContentBlock, transcribeAudioBytesWithKeyFailover, NoGroqKeyError } from "@dave/vision";
import { speechVocabularyPrompt } from "./speech-vocabulary.js";
import { activityAfter, activityBetween, latestActivityId, publishActivity, subscribeActivity, type ActivityEvent, type ActivityFeed } from "./activity-bus.js";
import { getCall, setCallStatus, placeCall, callOpeningInstruction } from "./dave-calls.js";
import { runAppChatTurn, sharedHistoryKey, newTurnId, createAppSink, appRegistry, type AppChatDeps } from "./app-chat.js";
import { dispatchCallback } from "./command-router.js";
import { ANSWERED_EARLIER, loadConversationHistory, saveConversationHistory } from "./conversation-store.js";
import { startLiveSession, runLiveTool, NoGeminiKeyError } from "./live-voice.js";
import { getVoiceSettings, synthesizeSpeechWithStoredKeys } from "@dave/notifications";
import type { ToolRegistry } from "./tool-registry.js";
import { getBusyState, getAutonomousBusyState } from "./busy-state.js";
import { abortTurn, isTurnRunning } from "./turn-abort.js";
import { readAppFile, saveUserUpload, isImageName } from "./app-files.js";
import { nousDepsFor, placeNousSignal, skipNousSignal, applyNousUpdate, skipNousUpdate, closeNousTrade } from "./nous/service.js";

/**
 * The app's chat, served by the bot process itself (where Dave runs), at /api/app/chat/*. Every
 * other /api/app route lives in the admin panel; these can't, because they need the live turn --
 * its events as they happen, and a real Stop. Same paired-device token as the admin routes
 * (verifyDeviceToken, @dave/db), same answer for any bad token.
 *
 *   GET  history            the shared conversation (app + Telegram), for display
 *   POST send               {text, images?: [{data: base64, mediaType}], files?: [{name, data: base64}], whenFree?: bool}
 *   GET  file/<id>          download a file Dave sent in the chat
 *   GET  stream             Server-Sent Events of the activity bus (Last-Event-ID / ?after=, ?feeds=)
 *   GET  activity           the same events as JSON (catch-up, background notifications)
 *   GET  activity/range     loop/background events between ?from=&to= (ms), newest first -- the Live tab's periods
 *   GET  state              is Dave busy, and with what
 *   POST stop               stop whatever Dave is doing right now
 *   POST action             {callback, messageId?} -- a card button from the app (Nous, trade approvals, ...)
 *   POST transcribe         {audio: base64, name?} -> {text} -- the trader's voice, via Groq Whisper
 *   POST voice/turn         {audio: base64, name?} -> {heard, reply, audio?, contentType?} -- one turn of
 *                           an ElevenLabs call: Whisper -> Dave's full brain -> ElevenLabs/Fish voice
 *   POST live/start         {thinking?, voice?} -> a one-use Gemini Live token + session setup (live-voice.ts)
 *   POST live/tool          {name, args} -> the tool's answer, for Gemini (trade actions need confirmed: true)
 *   POST live/end           {transcript: [{who, text}], seconds} -> saved into the shared conversation
 */

export const APP_CHAT_PREFIX = "/api/app/chat/";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PING_MS = 25_000;
const WAIT_FOR_FREE_MS = 10 * 60_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("That's too large to send (16 MB max)."), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Expected a JSON body."), { status: 400 });
  }
}

function feedsParam(url: URL): ActivityFeed[] | undefined {
  const raw = url.searchParams.get("feeds");
  if (!raw) return undefined;
  const feeds = raw.split(",").filter((f): f is ActivityFeed => f === "chat" || f === "loop" || f === "background");
  return feeds.length ? feeds : undefined;
}

/** A stored conversation message -> what the chat list shows. */
export interface ChatHistoryItem {
  role: "user" | "assistant";
  text: string;
  pictures?: number;
  tools?: { name: string }[];
}

export function historyForDisplay(history: CompletionMessage[], limit = 60): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const pictures = typeof m.content === "string" ? 0 : m.content.filter((b) => b.type === "image").length;
      items.push({ role: "user", text: text.trim(), ...(pictures ? { pictures } : {}) });
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" && m.content !== ANSWERED_EARLIER ? m.content : "";
      const last = items.at(-1);
      const tools = (m.toolCalls ?? []).map((c) => ({ name: c.name }));
      // A run of tool-calling steps and the final answer read as ONE Dave message.
      if (last?.role === "assistant") {
        last.tools = [...(last.tools ?? []), ...tools];
        if (text.trim()) last.text = last.text ? `${last.text}\n\n${text.trim()}` : text.trim();
      } else {
        items.push({ role: "assistant", text: text.trim(), ...(tools.length ? { tools } : {}) });
      }
    }
  }
  return items.filter((i) => i.text || i.pictures || i.tools?.length).slice(-limit);
}

export interface AppChatRouteDeps extends AppChatDeps {
  /** Overridable for tests. */
  runTurn?: typeof runAppChatTurn;
  registry?: ToolRegistry;
  fetchImpl?: typeof fetch;
}

export function createAppChatHandler(deps: AppChatRouteDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const runTurn = deps.runTurn ?? runAppChatTurn;
  const registryFor = (d: AppChatRouteDeps) => d.registry ?? appRegistry(d);
  return (req, res) => {
    void handle(req, res).catch((err: Error & { status?: number }) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message || "Something went wrong." });
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const userId = url.searchParams.get("userId")?.trim() || deps.userId;
    if (!token || userId !== deps.userId || !verifyDeviceToken(userId, token)) {
      send(res, 401, { error: "unpaired", message: "This device is not paired. Pair it again from the web panel." });
      return;
    }
    const path = url.pathname.slice(APP_CHAT_PREFIX.length).replace(/\/$/, "");
    const method = req.method ?? "GET";

    if (method === "GET" && path === "history") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 200);
      send(res, 200, { items: historyForDisplay(loadConversationHistory(deps.db, sharedHistoryKey(deps.db, userId)), limit), latestEventId: latestActivityId(userId) });
      return;
    }
    if (method === "GET" && path === "state") {
      send(res, 200, stateOf(userId));
      return;
    }
    if (method === "GET" && path === "activity/range") {
      // The Live tab's Today / 7 days / 3 weeks / custom views (activity-bus.ts's dated archive).
      const now = Date.now();
      const from = Number(url.searchParams.get("from") ?? now - 86_400_000);
      const to = Number(url.searchParams.get("to") ?? now);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return send(res, 400, { error: "from and to must be times in ms, from before to." });
      const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500) || 500, 1), 2000);
      const feeds = feedsParam(url)?.filter((f) => f !== "chat") ?? (["loop", "background"] as ActivityFeed[]);
      return send(res, 200, activityBetween(userId, from, to, { feeds, kinds, limit }));
    }
    if (method === "GET" && path === "activity") {
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      send(res, 200, { events: activityAfter(userId, after, feedsParam(url)), latestEventId: latestActivityId(userId) });
      return;
    }
    if (method === "GET" && path === "stream") {
      stream(req, res, url, userId);
      return;
    }
    if (method === "POST" && path === "send") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      let images: ContentBlock[] = [];
      try {
        images = Array.isArray(body.images) ? (body.images as { data?: string; mediaType?: string }[]).slice(0, 4).map((img) => buildImageContentBlock(Buffer.from(String(img.data ?? ""), "base64"), img.mediaType === "image/png" ? "photo.png" : "photo.jpg")) : [];
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      // Documents: saved into the inbox Dave's scripts read from (the same one Telegram uses);
      // pictures sent as files still reach him as pictures.
      const notes: string[] = [];
      const attached: string[] = [];
      try {
        for (const f of Array.isArray(body.files) ? (body.files as { name?: string; data?: string }[]).slice(0, 5) : []) {
          const data = Buffer.from(String(f.data ?? ""), "base64");
          if (!data.byteLength) continue;
          const name = saveUserUpload(userId, String(f.name ?? "file"), data);
          attached.push(name);
          if (isImageName(name) && images.length < 4) {
            images.push(buildImageContentBlock(data, name));
            notes.push(`[Image "${name}" attached]`);
          } else {
            notes.push(`[File "${name}" (${Math.max(1, Math.round(data.byteLength / 1024))} KB) received from the user] -- to read or process it, call run_script with attachUserFiles: ["${name}"]; anything your script writes to $DAVE_OUT_DIR comes back to you, and send_file_to_user hands a result file back to the app.`);
          }
        }
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const fullText = [text, ...notes].filter(Boolean).join("\n\n");
      if (!fullText && !images.length) {
        send(res, 400, { error: "Type a message or attach a picture or file." });
        return;
      }
      const busy = stateOf(userId);
      if (busy.busy && !body.whenFree) {
        send(res, 409, { error: "busy", ...busy });
        return;
      }
      const turnId = newTurnId();
      void (async () => {
        if (busy.busy) {
          const until = Date.now() + WAIT_FOR_FREE_MS;
          while (stateOf(userId).busy && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
        }
        await runTurn(deps, { text: fullText, images, ...(attached.length ? { display: { text, files: attached } } : {}), ...(body.research === true ? { research: true } : {}) }, turnId);
      })().catch((err) => console.error("[app-chat] turn failed:", err));
      send(res, 202, { turnId, queued: busy.busy });
      return;
    }
    if (method === "GET" && path.startsWith("file/")) {
      const file = readAppFile(userId, path.slice(5));
      if (!file) {
        send(res, 404, { error: "That file is gone." });
        return;
      }
      res.writeHead(200, { "content-type": file.mime, "content-length": String(file.bytes), "content-disposition": `attachment; filename="${file.name}"`, "cache-control": "private, max-age=3600" });
      res.end(file.data);
      return;
    }
    if (method === "POST" && path === "transcribe") {
      // Talking to Dave from the app: Groq's most accurate Whisper, primed with the trader's own
      // pairs and trading words (speech-vocabulary.ts), English.
      const body = await readJson(req);
      const audio = Buffer.from(String(body.audio ?? ""), "base64");
      if (audio.byteLength < 500) {
        send(res, 400, { error: "That recording is empty -- hold the mic a little longer." });
        return;
      }
      const name = typeof body.name === "string" && /\.(m4a|mp3|wav|ogg|webm|aac|flac|mp4)$/i.test(body.name) ? body.name : "voice.m4a";
      try {
        const t = await transcribeAudioBytesWithKeyFailover(deps.db, userId, audio, name, { model: "whisper-large-v3", prompt: speechVocabularyPrompt(userId), language: "en" });
        send(res, 200, { text: t.text.trim() });
      } catch (err) {
        if (err instanceof NoGroqKeyError) {
          send(res, 409, { error: "Add a Groq key first (Settings > Dave's voice > Speech to text) -- it's what turns your voice into text." });
          return;
        }
        send(res, 502, { error: `Couldn't turn that into text: ${err instanceof Error ? err.message.replace(/gsk_[A-Za-z0-9]+/g, "[key]") : String(err)}`.slice(0, 300) });
      }
      return;
    }
    if (method === "POST" && path === "voice/turn") {
      // Calling Dave with his ElevenLabs voice (the trader: "call dave via elevenlabs -- the LLM
      // talks, ElevenLabs speaks"): what the trader said -> Groq Whisper -> a normal app turn
      // (Dave's full brain: every tool, his memory, his trade rules -- he sees and acts on trades)
      // -> his chosen voice. One round trip per exchange; the app listens again after he speaks.
      const body = await readJson(req);
      const audio = Buffer.from(String(body.audio ?? ""), "base64");
      if (audio.byteLength < 500) {
        send(res, 200, { heard: "", reply: "" });
        return;
      }
      const name = typeof body.name === "string" && /\.(m4a|mp3|wav|ogg|webm|aac|flac|mp4)$/i.test(body.name) ? body.name : "voice.m4a";
      let heard: string;
      try {
        heard = (await transcribeAudioBytesWithKeyFailover(deps.db, userId, audio, name, { model: "whisper-large-v3", prompt: speechVocabularyPrompt(userId), language: "en" })).text.trim();
      } catch (err) {
        if (err instanceof NoGroqKeyError) {
          send(res, 409, { error: "Add a Groq key first (Settings > Dave's voice > Speech to text) -- it's what turns your voice into text." });
          return;
        }
        send(res, 502, { error: `Couldn't hear that: ${err instanceof Error ? err.message.replace(/gsk_[A-Za-z0-9]+/g, "[key]") : String(err)}`.slice(0, 300) });
        return;
      }
      // Whisper's stock output for silence / room noise -- not something the trader said.
      if (!heard || /^(thank you\.?|thanks for watching[.!]?|you|\.+|bye\.?)$/i.test(heard)) {
        send(res, 200, { heard: "", reply: "" });
        return;
      }
      const busy = stateOf(userId);
      let reply: string;
      if (busy.busy) {
        reply = `Give me a moment, I'm still on ${busy.task ?? "something"}.`;
      } else {
        const result = await runTurn(deps, {
          text:
            `[Voice call -- the trader said:] ${heard}\n\n(This is a live voice call and your answer is read aloud: short, natural spoken sentences, ` +
            `no tables, lists or markdown, only the key numbers. It came through speech-to-text, so if a number, pair or instruction may have been misheard, ` +
            `say what you understood and ask. Before you open, close or change a trade from this call, say exactly what you'll do and wait for their yes -- ` +
            `unless this message IS that yes to what you just proposed.)`,
          display: { text: `🎙 ${heard}`, files: [] },
        });
        reply = !result
          ? "I couldn't finish that one."
          : result.status === "done"
            ? result.text || "Done."
            : result.status === "awaiting_user"
              ? result.question.question
              : "I stopped before finishing.";
      }
      const spoken = reply.replace(/```[\s\S]*?```/g, " ").replace(/<[^>]+>/g, " ").replace(/[*_#>`|]/g, " ").replace(/\[(.*?)\]\((.*?)\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 2500);
      try {
        if (!getVoiceSettings(deps.db, userId).enabled) throw new Error("Dave's voice is switched off -- turn it on in Settings > Dave's voice.");
        const r = await synthesizeSpeechWithStoredKeys(deps.db, userId, spoken);
        send(res, 200, { heard, reply, audio: r.audio.toString("base64"), contentType: r.contentType, provider: r.provider });
      } catch (err) {
        // No voice (no key, quota): the answer still comes back as text for the screen.
        send(res, 200, { heard, reply, voiceError: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
      return;
    }
    if (method === "POST" && path === "live/start") {
      // A live voice call (live-voice.ts): a one-use Gemini token plus the whole session setup.
      const body = await readJson(req);
      try {
        // Answering a call Dave placed: the session opens knowing why he called (dave-calls.ts).
        const call = typeof body.callId === "string" ? getCall(userId, body.callId) : undefined;
        const session = await startLiveSession({ db: deps.db, userId, registry: registryFor(deps) }, { thinking: body.thinking === true, voice: typeof body.voice === "string" ? body.voice : undefined, allowActions: body.allowActions !== false, extraInstruction: call ? callOpeningInstruction(call) : undefined }, deps.fetchImpl ?? fetch);
        if (call) setCallStatus(userId, call.id, "answered");
        publishActivity(userId, "background", "voice_call", { text: call ? `📞 You answered Dave's call: ${call.reason}` : "📞 Voice call with Dave started." });
        send(res, 200, session);
      } catch (err) {
        if (err instanceof NoGeminiKeyError) return send(res, 409, { error: err.message });
        send(res, 502, { error: (err instanceof Error ? err.message : String(err)).replace(/AIza[0-9A-Za-z_-]+/g, "[key]").slice(0, 300) });
      }
      return;
    }
    if (method === "POST" && path === "call/status") {
      // The phone says what happened to a call Dave placed: declined, or nobody answered.
      const body = await readJson(req);
      const status = body.status === "declined" || body.status === "missed" || body.status === "answered" ? body.status : undefined;
      if (typeof body.callId !== "string" || !status) return send(res, 400, { error: "callId and status (answered, declined or missed) are needed." });
      const c = setCallStatus(userId, body.callId, status);
      return c ? send(res, 200, { call: c }) : send(res, 404, { error: "No such call." });
    }
    if (method === "GET" && path.startsWith("call/")) {
      const c = getCall(userId, path.slice(5));
      return c ? send(res, 200, { call: c }) : send(res, 404, { error: "No such call." });
    }
    if (method === "POST" && path === "call/test") {
      // "Ring me now" from Settings: checks the phone really rings, inside and outside the app.
      const c = placeCall(userId, { reason: "Test call -- checking that your phone rings when I call.", urgent: true });
      return send(res, 200, { call: c });
    }
    if (method === "POST" && path === "live/tool") {
      const body = await readJson(req);
      const name = String(body.name ?? "");
      const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
      const result = await runLiveTool({ registry: registryFor(deps), askDave: (request) => askDave(userId, request) }, name, args);
      publishActivity(userId, "background", "voice_tool", { text: `📞 ${name}${result.error ? " (failed)" : result.needsConfirmation ? " (waiting for your yes)" : ""}` });
      send(res, 200, result);
      return;
    }
    if (method === "POST" && path === "live/end") {
      // The call goes into the shared conversation, so Dave (and Telegram) know what was said.
      const body = await readJson(req);
      const lines = Array.isArray(body.transcript) ? (body.transcript as { who?: string; text?: string }[]) : [];
      const text = lines
        .map((l) => ({ who: l.who === "dave" ? "Dave" : "Me", text: String(l.text ?? "").trim() }))
        .filter((l) => l.text)
        .map((l) => `${l.who}: ${l.text}`)
        .join("\n")
        .slice(0, 20_000);
      const minutes = Math.max(1, Math.round((Number(body.seconds) || 0) / 60));
      if (text) {
        const key = sharedHistoryKey(deps.db, userId);
        const history = loadConversationHistory(deps.db, key);
        history.push({ role: "user", content: `[Voice call with Dave, about ${minutes} min -- transcript]\n${text}` });
        history.push({ role: "assistant", content: "📞 Voice call saved -- I've got everything we said." });
        saveConversationHistory(deps.db, key, history);
      }
      publishActivity(userId, "background", "voice_call", { text: `📞 Voice call ended (${minutes} min).` });
      send(res, 200, { saved: !!text });
      return;
    }
    if (method === "POST" && path === "stop") {
      send(res, 200, { stopped: abortTurn(userId) });
      return;
    }
    if (method === "POST" && path === "action") {
      const body = await readJson(req);
      send(res, 200, { result: await runCardAction(deps, String(body.callback ?? ""), Number(body.messageId) || undefined) });
      return;
    }
    send(res, 404, { error: "not found" });
  }

  /** ask_dave from a call: a normal app turn (every tool, every safeguard), its answer as text. */
  async function askDave(userId: string, request: string): Promise<string> {
    const busy = stateOf(userId);
    if (busy.busy) return `Dave is busy right now${busy.task ? ` (${busy.task})` : ""} -- try again in a minute.`;
    const result = await runTurn(deps, { text: `[From our voice call] ${request}\n\n(Answer for being read aloud: plain sentences, no tables or markdown, the key numbers only.)` });
    if (!result) return "Dave couldn't finish that one.";
    if (result.status === "done") return result.text || "Done.";
    if (result.status === "awaiting_user") return `Dave needs to know: ${result.question.question}`;
    return "Dave stopped before finishing.";
  }

  function stateOf(userId: string): { busy: boolean; task?: string; since?: number; autonomous?: string; appTurn: boolean } {
    const user = getBusyState(userId);
    const auto = getAutonomousBusyState(userId);
    return { busy: !!user, task: user?.taskDescription, since: user?.startedAt, autonomous: auto?.taskDescription, appTurn: isTurnRunning(userId, "app") };
  }

  function stream(req: IncomingMessage, res: ServerResponse, url: URL, userId: string): void {
    const feeds = feedsParam(url);
    const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? latestActivityId(userId)) || 0;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 5000\n\n`);
    const write = (e: ActivityEvent) => {
      if (feeds && !feeds.includes(e.feed)) return;
      res.write(`id: ${e.id}\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const e of activityAfter(userId, lastId, feeds)) write(e);
    res.write(`event: ready\ndata: ${JSON.stringify({ latestEventId: latestActivityId(userId), ...stateOf(userId) })}\n\n`);
    const unsubscribe = subscribeActivity(userId, write);
    const ping = setInterval(() => res.write(`: ping\n\n`), PING_MS);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
  }
}

/** Not a real chat: the app's stand-in chat id for button presses (must be truthy for the router). */
const APP_CARD_CHAT_ID = 1;

/**
 * A card's button tapped in the app -- Nous's Place/Skip, a trade approval, any other button
 * Dave's cards carry. Nous answers directly; everything else runs through the very same handler
 * Telegram's button presses do, with its replies landing in the app's chat.
 */
export async function runCardAction(deps: AppChatDeps, callback: string, messageId?: number): Promise<string> {
  const userId = deps.userId;
  const [prefix, action, arg] = callback.split(":");
  if (!callback || callback.length > 128) return "Unknown button.";
  if (prefix !== "nous") {
    const client = createAppSink(userId, () => ({ channel: "app" }));
    await dispatchCallback(
      { db: deps.db, client, userId, executor: deps.executor, publicBaseUrl: deps.publicBaseUrl },
      { id: `app-${Date.now()}`, from: { id: 0 }, data: callback, message: { message_id: messageId ?? 0, chat: { id: APP_CARD_CHAT_ID, type: "private" }, date: Math.floor(Date.now() / 1000) } as never },
    );
    return "Done.";
  }
  if (!arg) return "Unknown button.";
  const nous = nousDepsFor(userId);
  if (!nous) return "Nous isn't running on this server.";
  switch (action) {
    case "y":
      return placeNousSignal(nous, arg);
    case "n":
      await skipNousSignal(nous, arg);
      return "Skipped.";
    case "uy":
      return applyNousUpdate(nous, arg);
    case "un":
      await skipNousUpdate(nous, arg);
      return "Ignored.";
    case "c":
      await closeNousTrade(nous, arg);
      return `Closing #${arg}.`;
    case "k":
      return `Keeping #${arg} open.`;
    default:
      return "Unknown button.";
  }
}
