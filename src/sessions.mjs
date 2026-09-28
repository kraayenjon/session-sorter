/**
 * Reading Claude Code sessions for one project. Each session is a JSONL file
 * in ~/.claude/projects/<encoded project path>/<session id>.jsonl. Only a
 * few fields are kept: the title the Session Manager shows, the first and
 * last thing the user asked, the branch, and the dates. Nothing is written.
 */
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

/** The folder name Claude Code uses for a project: every non-alphanumeric character becomes "-". */
export function encodeProject(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The path the extension keys its groups by: the workspace folder, resolved,
 * NFC-normalized on macOS, with a .claude/worktrees/<name> suffix removed.
 */
export function scopeRoot(path) {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {}
  if (process.platform === "darwin") resolved = resolved.normalize("NFC");

  return resolved.replace(/[/\\]\.claude[/\\]worktrees[/\\][^/\\]+$/, "");
}

export function sessionsDir(project, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

  return join(config, "projects", encodeProject(project));
}

export async function listSessions(project, env = process.env) {
  const dir = sessionsDir(project, env);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions = [];
  for (const file of files) {
    const session = await readSession(join(dir, file));
    if (session) sessions.push(session);
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One session file → a small summary, or null for subagent transcripts and empty files. */
export async function readSession(file) {
  const id = basename(file, ".jsonl");
  let customTitle = "";
  let aiTitle = "";
  let firstPrompt = "";
  let lastPrompt = "";
  let branch = "";
  let createdAt = "";
  let updatedAt = "";
  let prompts = 0;
  let first = true;

  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }

    if (first && line.isSidechain) {
      lines.close();
      return null;
    }
    first = false;

    if (line.type === "custom-title" && line.customTitle) customTitle = line.customTitle;
    if (line.type === "ai-title" && line.aiTitle) aiTitle = line.aiTitle;
    if (line.gitBranch) branch = line.gitBranch;
    if (line.timestamp) {
      if (!createdAt) createdAt = line.timestamp;
      updatedAt = line.timestamp;
    }

    const text = line.type === "user" && !line.isMeta ? userText(line.message?.content) : "";
    if (text) {
      prompts++;
      if (!firstPrompt) firstPrompt = text;
      lastPrompt = text;
    }
  }

  if (!prompts && !customTitle && !aiTitle) return null;

  return {
    id,
    title: customTitle || aiTitle || firstLine(lastPrompt) || firstLine(firstPrompt) || id,
    firstPrompt,
    lastPrompt,
    prompts,
    branch,
    createdAt: createdAt || statSync(file).mtime.toISOString(),
    updatedAt: updatedAt || statSync(file).mtime.toISOString(),
  };
}

/** What the person typed: plain text only, no tool results, no injected reminders. */
function userText(content) {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text) : [];
  const text = parts
    .join("\n")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(local-command-stdout|command-message)>[\s\S]*?<\/\1>/g, "")
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1")
    .replace(/<\/?command-args>/g, "")
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, "")
    .trim();

  return text.startsWith("[Request interrupted") ? "" : text;
}

const firstLine = (text) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "";
