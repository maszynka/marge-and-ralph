/**
 * PR URL parsing and metadata resolution.
 *
 * Resolves PR metadata from:
 * - GitHub PR URLs (using gh CLI)
 * - GitLab MR URLs (using glab CLI)
 * - Branch names (auto-detect remote and find associated PR/MR)
 *
 * Extracts: platform, owner, repo, number, branch, baseBranch, title, description, ticketUrl
 */

import { execSync } from "child_process";
import type { PRMetadata, PRPlatform } from "./types";

/**
 * Common ticket URL patterns found in PR descriptions.
 * Matches: JIRA, Linear, GitHub issues, Asana, etc.
 */
const TICKET_URL_PATTERNS = [
  // JIRA: https://company.atlassian.net/browse/PROJ-123
  /https?:\/\/[^\/\s]+\.atlassian\.net\/browse\/[A-Z]+-\d+/i,
  // Linear: https://linear.app/company/issue/PROJ-123
  /https?:\/\/linear\.app\/[^\/\s]+\/issue\/[A-Z]+-\d+/i,
  // GitHub issues: https://github.com/owner/repo/issues/123
  /https?:\/\/github\.com\/[^\/\s]+\/[^\/\s]+\/issues\/\d+/i,
  // Asana: https://app.asana.com/0/projectid/taskid
  /https?:\/\/app\.asana\.com\/\d+\/\d+\/\d+/i,
  // Shortcut: https://app.shortcut.com/company/story/12345
  /https?:\/\/app\.shortcut\.com\/[^\/\s]+\/story\/\d+/i,
];

/**
 * Detects the platform (GitHub or GitLab) from a PR URL.
 *
 * @param url - PR URL to analyze
 * @returns Platform type or undefined if not recognized
 */
export function detectPlatform(url: string): PRPlatform | undefined {
  if (url.includes("github.com")) {
    return "github";
  }
  if (url.includes("gitlab.com") || url.match(/gitlab\./)) {
    return "gitlab";
  }
  return undefined;
}

/**
 * Parses a PR URL to extract owner, repo, and PR number.
 *
 * GitHub format: https://github.com/owner/repo/pull/123
 * GitLab format: https://gitlab.com/owner/repo/-/merge_requests/123
 *
 * @param url - PR URL to parse
 * @returns Object with platform, owner, repo, number, and url
 * @throws Error if URL format is invalid
 */
export function parseUrl(url: string): {
  platform: PRPlatform;
  owner: string;
  repo: string;
  number: number;
  url: string;
} {
  const platform = detectPlatform(url);
  if (!platform) {
    throw new Error(`[pr-resolver] Unsupported URL format: ${url}`);
  }

  let match: RegExpMatchArray | null = null;

  if (platform === "github") {
    // GitHub: https://github.com/owner/repo/pull/123
    match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`[pr-resolver] Invalid GitHub PR URL: ${url}`);
    }
    const [, owner, repo, numberStr] = match;
    return {
      platform,
      owner,
      repo,
      number: parseInt(numberStr, 10),
      url,
    };
  }

  if (platform === "gitlab") {
    // GitLab: https://gitlab.com/owner/repo/-/merge_requests/123
    // Also handles self-hosted: https://gitlab.example.com/owner/repo/-/merge_requests/123
    match = url.match(/gitlab[^\/]*\/([^\/]+)\/([^\/]+)\/-\/merge_requests\/(\d+)/);
    if (!match) {
      throw new Error(`[pr-resolver] Invalid GitLab MR URL: ${url}`);
    }
    const [, owner, repo, numberStr] = match;
    return {
      platform,
      owner,
      repo,
      number: parseInt(numberStr, 10),
      url,
    };
  }

  throw new Error(`[pr-resolver] Failed to parse URL: ${url}`);
}

/**
 * Extracts the first ticket URL found in the PR description.
 *
 * @param description - PR description text
 * @returns Ticket URL or undefined if none found
 */
function extractTicketUrl(description: string): string | undefined {
  for (const pattern of TICKET_URL_PATTERNS) {
    const match = description.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return undefined;
}

/**
 * Resolves full PR metadata from a GitHub PR using gh CLI.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param number - PR number
 * @param url - Full PR URL
 * @returns Complete PRMetadata object
 * @throws Error if gh CLI fails or returns invalid data
 */
function resolveGitHub(
  owner: string,
  repo: string,
  number: number,
  url: string
): PRMetadata {
  try {
    // Use gh CLI to fetch PR details in JSON format
    // Fields: headRefName (branch), baseRefName (base), title, body (description)
    const output = execSync(
      `gh pr view ${number} --repo ${owner}/${repo} --json headRefName,baseRefName,title,body`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const data = JSON.parse(output);

    return {
      platform: "github",
      owner,
      repo,
      number,
      branch: data.headRefName,
      baseBranch: data.baseRefName,
      title: data.title,
      description: data.body || "",
      ticketUrl: extractTicketUrl(data.body || ""),
      url,
    };
  } catch (error) {
    throw new Error(
      `[pr-resolver] Failed to resolve GitHub PR ${owner}/${repo}#${number}: ${error}`
    );
  }
}

/**
 * Resolves full PR metadata from a GitLab MR using glab CLI.
 *
 * @param owner - Repository owner/group
 * @param repo - Repository name
 * @param number - MR IID
 * @param url - Full MR URL
 * @returns Complete PRMetadata object
 * @throws Error if glab CLI fails or returns invalid data
 */
function resolveGitLab(
  owner: string,
  repo: string,
  number: number,
  url: string
): PRMetadata {
  try {
    // Use glab CLI to fetch MR details in JSON format
    // Note: glab uses "mr view" command and formats as JSON
    const output = execSync(
      `glab mr view ${number} --repo ${owner}/${repo} --output json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const data = JSON.parse(output);

    return {
      platform: "gitlab",
      owner,
      repo,
      number,
      branch: data.source_branch,
      baseBranch: data.target_branch,
      title: data.title,
      description: data.description || "",
      ticketUrl: extractTicketUrl(data.description || ""),
      url,
    };
  } catch (error) {
    throw new Error(
      `[pr-resolver] Failed to resolve GitLab MR ${owner}/${repo}!${number}: ${error}`
    );
  }
}

/**
 * Resolves PR metadata from a PR URL or branch name.
 *
 * For PR URLs:
 * - Parses the URL to extract platform, owner, repo, number
 * - Fetches full metadata using appropriate CLI tool (gh or glab)
 *
 * For branch names:
 * - Uses git commands to detect remote and find associated PR
 * - Falls back to gh/glab CLI to search for PR by branch name
 *
 * @param input - PR URL or branch name
 * @returns Complete PRMetadata object
 * @throws Error if input is invalid or PR cannot be resolved
 */
export function resolvePR(input: string): PRMetadata {
  // If input looks like a URL, parse it directly
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const parsed = parseUrl(input);
    if (parsed.platform === "github") {
      return resolveGitHub(parsed.owner, parsed.repo, parsed.number, parsed.url);
    }
    if (parsed.platform === "gitlab") {
      return resolveGitLab(parsed.owner, parsed.repo, parsed.number, parsed.url);
    }
  }

  // Otherwise, treat as branch name and try to find associated PR
  // First, detect the remote repo URL
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Parse remote URL to determine platform and repo
    // SSH format: git@github.com:owner/repo.git
    // HTTPS format: https://github.com/owner/repo.git
    let owner: string;
    let repo: string;
    let platform: PRPlatform;

    if (remoteUrl.includes("github.com")) {
      platform = "github";
      const match =
        remoteUrl.match(/github\.com[:/]([^\/]+)\/([^\/]+?)(\.git)?$/) ||
        remoteUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (!match) {
        throw new Error(`[pr-resolver] Cannot parse GitHub remote URL: ${remoteUrl}`);
      }
      [, owner, repo] = match;
      repo = repo.replace(/\.git$/, "");
    } else if (remoteUrl.includes("gitlab")) {
      platform = "gitlab";
      const match =
        remoteUrl.match(/gitlab[^:/]*[:/]([^\/]+)\/([^\/]+?)(\.git)?$/) ||
        remoteUrl.match(/gitlab[^\/]*\/([^\/]+)\/([^\/]+)/);
      if (!match) {
        throw new Error(`[pr-resolver] Cannot parse GitLab remote URL: ${remoteUrl}`);
      }
      [, owner, repo] = match;
      repo = repo.replace(/\.git$/, "");
    } else {
      throw new Error(
        `[pr-resolver] Unsupported remote platform for URL: ${remoteUrl}`
      );
    }

    // Search for PR by branch name
    const branchName = input;

    if (platform === "github") {
      // Use gh pr list to find PR with matching head branch
      const listOutput = execSync(
        `gh pr list --repo ${owner}/${repo} --head ${branchName} --json number,url --limit 1`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );

      const prs = JSON.parse(listOutput);
      if (prs.length === 0) {
        throw new Error(
          `[pr-resolver] No GitHub PR found for branch "${branchName}" in ${owner}/${repo}`
        );
      }

      const pr = prs[0];
      return resolveGitHub(owner, repo, pr.number, pr.url);
    }

    if (platform === "gitlab") {
      // Use glab mr list to find MR with matching source branch
      const listOutput = execSync(
        `glab mr list --repo ${owner}/${repo} --source-branch ${branchName} --output json`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );

      const mrs = JSON.parse(listOutput);
      if (mrs.length === 0) {
        throw new Error(
          `[pr-resolver] No GitLab MR found for branch "${branchName}" in ${owner}/${repo}`
        );
      }

      const mr = mrs[0];
      return resolveGitLab(owner, repo, mr.iid, mr.web_url);
    }
  } catch (error) {
    throw new Error(
      `[pr-resolver] Failed to resolve PR from branch name "${input}": ${error}`
    );
  }

  throw new Error(`[pr-resolver] Invalid input: ${input}`);
}
