import type { AgentEvent } from "./agent-loop.js";
import { publishActivity, type ActivityChannel, type ActivityFeed } from "./activity-bus.js";

/** Turning an agent's live steps into activity-bus events -- shared by chat turns, workers and Nous. */

/** Plain-words label for a tool, for the live "Dave is working" card. */
export function toolLabel(name: string): string {
  if (name === "run_script") return "Running a script";
  if (name === "search_tools") return "Looking for the right tool";
  if (name.startsWith("get_")) return `Checking ${name.slice(4).replace(/_/g, " ")}`;
  if (name === "find_setup" || name === "hunt_for_setup") return "Hunting for a setup";
  if (name.startsWith("trade_") || name === "full_close" || name === "partial_close" || name === "modify_sl_tp") return name.replace(/_/g, " ");
  if (name.startsWith("tg_") || name === "send_telegram") return "Writing a message";
  if (name === "create_subagent") return "Starting a worker";
  return name.replace(/_/g, " ");
}

/** AgentLoop events -> the activity bus, for any channel. */
export function chatEventPublisher(userId: string, turnId: string | undefined, channel: ActivityChannel | undefined, agent?: string, feed: ActivityFeed = "chat"): (e: AgentEvent) => void {
  return (e) => {
    const extra = { turnId, channel, agent };
    if (e.type === "tool_start") publishActivity(userId, feed, "tool_start", { id: e.id, name: e.name, label: toolLabel(e.name), args: e.args }, extra);
    else if (e.type === "tool_end") publishActivity(userId, feed, "tool_end", { id: e.id, name: e.name, label: toolLabel(e.name), result: e.result, isError: e.isError, ms: e.ms }, extra);
    else if (e.type === "text") publishActivity(userId, feed, "text", { text: e.text }, extra);
    else publishActivity(userId, feed, "thinking", { text: e.text }, extra);
  };
}

