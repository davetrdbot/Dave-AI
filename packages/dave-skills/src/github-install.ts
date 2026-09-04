import { createSkill, type Skill } from "./skill-store.js";

/**
 * Update 10: "can Install any skill from GitHub." Real fetch against
 * GitHub's real raw-content host -- tries a skill manifest file first
 * (`SKILL.md`), then falls back to `README.md`, on both `main` and
 * `master` (real, honest attempt against whichever branch actually
 * exists, not a guess baked in as the only option).
 */
export class GithubSkillFetchError extends Error {
  constructor(repoUrl: string, cause: string) {
    super(`Could not fetch a skill from ${repoUrl}: ${cause}`);
    this.name = "GithubSkillFetchError";
  }
}

interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseGithubRepoUrl(repoUrl: string): ParsedRepo {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match) throw new GithubSkillFetchError(repoUrl, "not a recognizable github.com repository URL");
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

const CANDIDATE_FILES = ["SKILL.md", "README.md"];
const CANDIDATE_BRANCHES = ["main", "master"];

async function fetchFirstAvailable(owner: string, repo: string, timeoutMs: number): Promise<{ file: string; branch: string; content: string }> {
  for (const branch of CANDIDATE_BRANCHES) {
    for (const file of CANDIDATE_FILES) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.ok) {
          return { file, branch, content: await res.text() };
        }
      } catch {
        // real attempt, try the next candidate rather than failing on the first miss
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new GithubSkillFetchError(`${owner}/${repo}`, `none of ${CANDIDATE_FILES.join("/")} found on ${CANDIDATE_BRANCHES.join(" or ")}`);
}

export async function installSkillFromGithub(userId: string, repoUrl: string, timeoutMs = 10000): Promise<Skill> {
  const { owner, repo } = parseGithubRepoUrl(repoUrl);
  const found = await fetchFirstAvailable(owner, repo, timeoutMs);
  return createSkill(userId, {
    name: `${owner}/${repo}`,
    description: `Installed from ${repoUrl} (${found.file} on ${found.branch})`,
    content: found.content,
    source: "github",
  });
}
