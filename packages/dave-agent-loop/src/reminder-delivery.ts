import { takeDueReminders, describeFiredReminder, type Reminder } from "@dave/workers";
import { appendReminderEvent } from "@dave/ea-bridge";
import { setPendingSymbolOverride } from "./autonomous-tick-state.js";
import { isAutonomousTradingEnabled } from "./autonomous-trading-state.js";

/**
 * Fires Dave's due reminders (dave-workers/reminders.ts). Called from the bot's 5-second control
 * watcher, so a reminder lands within seconds of its time whether or not autonomous trading is on.
 *
 * Each fired reminder goes three ways:
 *   - to the chat, so the trader sees it (with the reason it was set);
 *   - to the phone's event log, so the app raises a notification through the connection it
 *     already holds for trades;
 *   - back to Dave: it stays in his context as "fired" (chat turns and autonomous cycles both show
 *     it) until he deletes it, and when it names a symbol and autonomous trading is on, that symbol
 *     is analysed on the very next cycle.
 *
 * takeDueReminders marks each reminder fired before it is sent, so a slow or failed send can never
 * make the same reminder fire twice.
 */
export function deliverDueReminders(userId: string, send: (text: string) => Promise<void>, now = Date.now()): Reminder[] {
  let due: Reminder[];
  try {
    due = takeDueReminders(userId, now);
  } catch (err) {
    console.error(`[reminders] ${userId}: could not read reminders:`, err);
    return [];
  }
  for (const reminder of due) {
    void send(describeFiredReminder(reminder)).catch((err) => console.error(`[reminders] ${userId}: could not send ${reminder.id}:`, err));
    try {
      appendReminderEvent(userId, reminder, now);
    } catch (err) {
      console.error(`[reminders] ${userId}: could not queue phone notification for ${reminder.id}:`, err);
    }
    if (reminder.symbol && isAutonomousTradingEnabled(userId)) {
      setPendingSymbolOverride(userId, reminder.symbol, `reminder ${reminder.id} fired: ${reminder.text}`);
    }
    console.log(`[reminders] ${userId}: fired ${reminder.id} -- ${reminder.text}`);
  }
  return due;
}
