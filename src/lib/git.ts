import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { MAX_COMMITS_FOR_HISTORY, MAX_COMMITS_PER_PATH } from "@/lib/constants";
import { parseGitHubUrl } from "@/lib/url";
import { hashString, slugify } from "@/lib/utils";

export type CommitSummary = {
  sha: string;
  author: string;
  date: string;
  message: string;
  changedPaths: string[];
};

function getRepoStorageRoot() {
  const configured = process.env.REPO_STORAGE_ROOT || "./data/repos";
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

export function getRepositoryClonePath(canonicalUrl: string) {
  const { owner, name } = parseGitHubUrl(canonicalUrl);
  return path.join(getRepoStorageRoot(), `${slugify(owner)}__${slugify(name)}-${hashString(canonicalUrl)}`);
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureRepositoryClone(canonicalUrl: string, existingClonePath?: string) {
  const clonePath = existingClonePath || getRepositoryClonePath(canonicalUrl);
  await fs.mkdir(getRepoStorageRoot(), { recursive: true });

  if (await pathExists(path.join(clonePath, ".git"))) {
    const git = simpleGit(clonePath);
    await git.fetch(["--all", "--prune"]);

    const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    if (currentBranch !== "HEAD") {
      await git.pull("origin", currentBranch);
    }
  } else {
    await simpleGit().clone(canonicalUrl, clonePath, ["--depth", "50"]);
  }

  const git = simpleGit(clonePath);
  const defaultBranch = await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "main");
  const headCommitSha = await git.revparse(["HEAD"]);

  return {
    clonePath,
    defaultBranch: defaultBranch === "HEAD" ? "main" : defaultBranch,
    headCommitSha
  };
}

export async function getHeadCommitSha(clonePath: string) {
  return simpleGit(clonePath).revparse(["HEAD"]);
}

function parseCommitLog(raw: string) {
  const commits: CommitSummary[] = [];
  let current: CommitSummary | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.includes("\u001f")) {
      if (current) {
        commits.push(current);
      }

      const [sha, author, date, message] = trimmed.replace(/\u001e/g, "").split("\u001f");
      current = {
        sha,
        author,
        date,
        message,
        changedPaths: []
      };
      continue;
    }

    if (current) {
      current.changedPaths.push(trimmed.replace(/\u001e/g, ""));
    }
  }

  if (current) {
    commits.push(current);
  }

  return commits;
}

export async function readRecentCommits(clonePath: string, limit = MAX_COMMITS_FOR_HISTORY) {
  const git = simpleGit(clonePath);
  const raw = await git.raw([
    "log",
    "--date=short",
    `--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e`,
    "--name-only",
    "-n",
    String(limit)
  ]);

  return parseCommitLog(raw);
}

export async function readPathCommits(clonePath: string, relativePath: string, limit = MAX_COMMITS_PER_PATH) {
  const git = simpleGit(clonePath);
  const raw = await git.raw([
    "log",
    "--date=short",
    `--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e`,
    "--name-only",
    "-n",
    String(limit),
    "--",
    relativePath
  ]);

  return parseCommitLog(raw);
}
