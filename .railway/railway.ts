/**
 * The whole Dave deployment on Railway, in one file: the bot and MetaTrader 5 (no VPS).
 *
 *   railway config apply        (or push to GitHub -- .github/workflows/railway.yml applies it)
 *
 * On a brand-new Railway project this creates everything; on an existing one it only changes what
 * differs. Nothing secret lives here: the bot makes its own web-panel login and encryption key on
 * first start (printed in its logs / kept on its volume), and the bot and MT5 work out their shared
 * secret from the project itself. Settings someone set by hand in Railway are kept (preserve()).
 */
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

const REPO = process.env.DAVE_REPO ?? process.env.GITHUB_REPOSITORY ?? "davetrdbot/Dave-AI";
const BRANCH = process.env.DAVE_BRANCH ?? "claude/new-session-7ynkr1";
// Services and their volumes must sit in the same region. Amsterdam (EU West) is where the first
// deployment lives; moving a volume's region moves or empties it, so this stays fixed.
const REGION = process.env.DAVE_REGION ?? "ams";

export default defineRailway(() => {
  const source = github(REPO, { branch: BRANCH, checkSuites: false });

  const botVolume = volume("dave-bot-volume", { region: REGION, sizeMB: 500 });
  const mt5Volume = volume("dave-mt5-volume", { region: REGION, sizeMB: 500 });

  // MetaTrader 5 under Wine with the Dave EA (mt5/). Private network only (dave-mt5.railway.internal).
  // Networking is deliberately not declared on either service: declaring it replaces what is there,
  // which would drop the bot's public address. The workflow adds that address on a fresh project.
  const mt5 = service("dave-mt5", {
    source,
    build: { builder: "DOCKERFILE", dockerfilePath: "mt5/Dockerfile", watchPatterns: ["mt5/**", "ea/**"] },
    replicas: { [REGION]: 1 },
    volumeMounts: { "/data": mt5Volume },
    env: { MT5_AGENT_SECRET: preserve(), RAILWAY_DOCKERFILE_PATH: preserve() },
  });

  // The bot, its web panel and the phone app's API.
  const bot = service("dave-bot", {
    source,
    build: { builder: "NIXPACKS", buildCommand: "pnpm install --frozen-lockfile && pnpm run build" },
    start: "pnpm run start",
    replicas: { [REGION]: 1 },
    volumeMounts: { "/data": botVolume },
    env: {
      ADMIN_PASSWORD: preserve(),
      ADMIN_USERNAME: preserve(),
      DATABASE_PATH: preserve(),
      DAVE_CREDENTIALS_KEY: preserve(),
      HEARTBEAT_PATH: preserve(),
      MT5_AGENT_SECRET: preserve(),
      OWNER_USER_ID: preserve(),
      PUBLIC_BASE_URL: preserve(),
    },
  });

  return project("dave-ai", { resources: [mt5, bot, mt5Volume, botVolume] });
});
