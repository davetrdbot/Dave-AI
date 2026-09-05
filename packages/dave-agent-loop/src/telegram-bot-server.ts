import type { Server } from "node:http";
import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "@dave/trading";
import type { RFeedTradeExecutor, HistoryRequestManager } from "@dave/rfeed";
import { generateWithKeyFailover, getModelConfig, type Provider, type CompletionRequest, type CompletionResult, type ProviderName } from "@dave/brain";
import { TelegramClient, createTelegramWebhookServer, enableTelegramWebhook, type TelegramUpdate } from "@dave/telegram";
import { type ToolRegistry } from "./tool-registry.js";
import { buildFullToolRegistry } from "./full-registry.js";
import { AgentLoop } from "./agent-loop.js";
import { loadConversationHistory, saveConversationHistory } from "./conversation-store.js";

/**
 * The real, persistent replacement for a one-off polling script: a
 * webhook server Telegram pushes every update to directly, real
 * conversation history persisted per user (survives a restart, unlike
 * an in-memory array), and the user's own configured model (primary +
 * fallback, same ModelConfig the admin UI's "AI Models" tab already
 * writes) picked via their own stored provider keys -- not a
 * hardcoded provider.
 */
export interface TelegramBotServerDeps {
  /** The single Dave account this bot serves -- all chats it talks in share this one account's credentials/settings/tools, per-chat state is only the conversation history. */
  ownerUserId: string;
  db: DaveDatabase;
  davema: DavemaClient;
  executor: TradeExecutor;
  rfeedExecutor: RFeedTradeExecutor;
  rfeedHistoryManager: HistoryRequestManager;
  botToken: string;
  publicBaseUrl: string;
  systemPrompt: string;
}

/** Tries the user's configured primary provider, then their configured fallbacks, via their own stored keys. */
function modelConfigProvider(db: DaveDatabase, userId: string): Provider {
  return {
    name: "model-config" as ProviderName,
    async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
      const config = getModelConfig(userId);
      const order = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
      let lastError: unknown;
      for (const provider of order) {
        try {
          return await generateWithKeyFailover(db, userId, provider, req, timeoutMs);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`No configured provider (${order.join(", ")}) has a working stored key for this user.`);
    },
  };
}

export interface TelegramBotServer {
  server: Server;
  webhookUrl: string;
}

/** Real, persistent per-chat registry + loop cache -- rebuilding a full 130+-tool registry on every single message would be wasteful. */
const registryCache = new Map<string, ToolRegistry>();

function getOrBuildRegistry(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number): ToolRegistry {
  // Keyed by chat too -- push_message_to_user/tg_thinking etc. bind to a
  // specific chatId, so a registry built for one chat can't be reused for
  // another, even though both share the same owner account/tools/db.
  const key = `${deps.ownerUserId}:${chatId}`;
  if (!registryCache.has(key)) {
    registryCache.set(
      key,
      buildFullToolRegistry({
        userId: deps.ownerUserId,
        db: deps.db,
        davema: deps.davema,
        executor: deps.executor,
        rfeedExecutor: deps.rfeedExecutor,
        rfeedHistoryManager: deps.rfeedHistoryManager,
        telegram: { client, chatId },
      })
    );
  }
  return registryCache.get(key)!;
}

/**
 * Starts the real webhook server AND registers it with Telegram
 * (setWebhook) -- from this point on, Telegram itself pushes every
 * update straight to this process; the bot is online for as long as
 * this process stays up, with no poll loop required.
 */
export async function startTelegramBotServer(deps: TelegramBotServerDeps): Promise<TelegramBotServer> {
  const client = new TelegramClient(deps.botToken);
  const registration = await enableTelegramWebhook(client, deps.ownerUserId, deps.publicBaseUrl);

  const server = createTelegramWebhookServer({
    onUpdate: async (_userId: string, update: TelegramUpdate) => {
      const message = update.message;
      if (!message?.text) return;
      const chatId = message.chat.id;
      // Conversation history is scoped per-chat (a group chat or a second
      // person messaging the same bot shouldn't see each other's history),
      // even though tools/credentials are shared across the one owner account.
      const historyKey = `${deps.ownerUserId}:${chatId}`;

      const registry = getOrBuildRegistry(deps, client, chatId);
      const provider = modelConfigProvider(deps.db, deps.ownerUserId);
      const loop = new AgentLoop(provider, registry);

      let history = loadConversationHistory(deps.db, historyKey);
      if (history.length === 0) history = [{ role: "system", content: deps.systemPrompt }];
      history.push({ role: "user", content: message.text });

      try {
        const result = await loop.run(history, { maxSteps: 8 });
        if (result.status === "done") {
          saveConversationHistory(deps.db, historyKey, result.history);
          await client.sendMessage({ chat_id: chatId, text: result.text || "(no text)" });
        } else {
          saveConversationHistory(deps.db, historyKey, result.history);
          await client.sendMessage({ chat_id: chatId, text: result.question.question });
        }
      } catch (err) {
        await client.sendMessage({ chat_id: chatId, text: `Something went wrong handling that: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  return { server, webhookUrl: `${deps.publicBaseUrl}${registration.path}` };
}
