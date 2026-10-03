/**
 * Research mode (the trader: "give it a provider and say do research on it -- it will not just do one
 * search; it uses Firecrawl, E2B and the rest and keeps searching, not conclude after three or four").
 *
 * A research turn is a normal chat turn with two differences:
 *   1. the message carries a research brief (how to research, what to deliver, how to ask), and
 *   2. when the model tries to finish early -- too few sources read, or it hasn't declared the work
 *      complete -- the turn is handed back to it with what it has done so far and an order to find
 *      what is still unknown, for up to `maxRounds` rounds.
 * It ends with the findings saved (knowledge, and a skill or a provider when that's what was asked).
 * A question to the trader (ask_user) pauses the research; their answer resumes it where it was.
 */

export const RESEARCH_DONE_MARK = "RESEARCH COMPLETE";

/** Tools that count as a research source. */
const SEARCH_TOOLS = /^(web_search|search_web|firecrawl_search|exa_search|tavily_search|brave_search)$/;
const READ_TOOLS = /^(scrape_url|crawl_url|firecrawl_scrape|firecrawl_crawl|browse_url|browser_[a-z_]+|fetch_url|read_url|get_youtube_transcript)$/;
const RUN_TOOLS = /^(run_script|run_python|run_code)$/;

export interface ResearchProgress {
  topic: string;
  round: number;
  searches: number;
  pagesRead: number;
  scripts: number;
  queries: string[];
  startedAt: number;
}

export interface ResearchDepth {
  maxRounds: number;
  minSources: number;
}

export const DEFAULT_RESEARCH_DEPTH: ResearchDepth = { maxRounds: 8, minSources: 12 };

const active = new Map<string, ResearchProgress>();

export function getActiveResearch(userId: string): ResearchProgress | undefined {
  return active.get(userId);
}
export function startResearch(userId: string, topic: string, now = Date.now()): ResearchProgress {
  const p: ResearchProgress = { topic: topic.slice(0, 300), round: 1, searches: 0, pagesRead: 0, scripts: 0, queries: [], startedAt: now };
  active.set(userId, p);
  return p;
}
export function endResearch(userId: string): void {
  active.delete(userId);
}

/** Adds one run's tool calls to the tally. */
export function countResearchSteps(p: ResearchProgress, steps: { toolName: string; arguments?: Record<string, unknown>; isError?: boolean }[]): void {
  for (const s of steps) {
    if (s.isError) continue;
    if (SEARCH_TOOLS.test(s.toolName)) {
      p.searches++;
      const q = s.arguments?.query ?? s.arguments?.q;
      if (typeof q === "string") p.queries.push(q.slice(0, 120));
    } else if (READ_TOOLS.test(s.toolName)) p.pagesRead++;
    else if (RUN_TOOLS.test(s.toolName)) p.scripts++;
  }
}

export function researchSources(p: ResearchProgress): number {
  return p.searches + p.pagesRead;
}

/** The research brief that goes in front of the trader's message. */
export function researchBrief(topic: string, depth: ResearchDepth = DEFAULT_RESEARCH_DEPTH): string {
  return [
    `[RESEARCH MODE] Research this properly, the way a careful analyst would -- not one search and a summary.`,
    `Topic: ${topic}`,
    ``,
    `How:`,
    `- Search many times with DIFFERENT wording (web_search): official site and docs, API reference, pricing, changelog / release notes, GitHub, status page, independent reviews, forums. Read the best pages IN FULL (scrape_url) -- a search snippet is not a source.`,
    `- Verify anything testable with run_script (E2B): call the API, list the models, check a number, compute a statistic. Never invent an endpoint, model name, price or limit -- if you couldn't confirm it, say "unconfirmed".`,
    `- Keep notes as you go: what's confirmed (with the URL), what's contradictory, what's still unknown. Every round, go after the unknowns.`,
    `- You need at least ${depth.minSources} real sources (searches + pages read) before you may finish.`,
    ``,
    `Asking the trader: whenever you need permission or a choice (adding a provider or key, spending credits, changing a setting, creating a skill), use ask_user with short options (e.g. "Yes, add it" / "No") -- never a plain-text question.`,
    ``,
    `Deliver: a clear report (what it is, how it works, exact facts with sources, what's unconfirmed, a recommendation). Save it with knowledge_save titled "Research: <topic>". If the topic is a provider the trader wants added, add it with the provider tools once the endpoint and models are verified. If it is a skill or a strategy, write it as a skill with create_skill. When everything is covered, end your answer with the line ${RESEARCH_DONE_MARK}.`,
  ].join("\n");
}

/**
 * After a run: the order to keep going, or null when the research is finished (declared complete
 * with enough sources) or out of rounds.
 */
export function researchContinuation(p: ResearchProgress, result: { status: string; text?: string }, depth: ResearchDepth = DEFAULT_RESEARCH_DEPTH): string | null {
  if (result.status !== "done") return null;
  const declared = (result.text ?? "").includes(RESEARCH_DONE_MARK);
  const enough = researchSources(p) >= depth.minSources;
  if ((declared && enough) || p.round >= depth.maxRounds) return null;
  p.round++;
  const recent = p.queries.slice(-12).map((q) => `"${q}"`).join(", ");
  return [
    `[RESEARCH ROUND ${p.round} of ${depth.maxRounds}] Not finished yet -- so far ${p.searches} searches, ${p.pagesRead} pages read, ${p.scripts} scripts run (${researchSources(p)} of the ${depth.minSources} sources needed).`,
    declared && !enough ? `You declared it complete, but with too few sources -- keep going.` : ``,
    recent ? `Queries already used (don't repeat them): ${recent}.` : ``,
    `1. List, from your notes, what is still unknown, unverified or contradictory.`,
    `2. Search for each with NEW wording and other kinds of source; read the best pages in full.`,
    `3. Test what can be tested with run_script.`,
    `Then update the report. End with ${RESEARCH_DONE_MARK} only when nothing important is left open.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One Live/chat line saying where the research is. */
export function describeResearch(p: ResearchProgress, depth: ResearchDepth = DEFAULT_RESEARCH_DEPTH): string {
  return `Research round ${p.round} of ${depth.maxRounds}: ${p.searches} searches, ${p.pagesRead} pages read, ${p.scripts} scripts so far -- digging further.`;
}
