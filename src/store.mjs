/**
 * The Session Manager's groups. The Claude Code extension keeps them in the
 * editor's global state, a SQLite file, under the extension's own row:
 *
 *   state.vscdb → ItemTable → key "Anthropic.claude-code" → JSON
 *     "sessionGroups:<workspace folder>": [{ id, name, collapsed, sessionIds }]
 *     "hiddenSessionIds": [...]   (archived sessions)
 *
 * Reading is safe at any time. Writing is only safe with the editor closed:
 * it holds this state in memory and would overwrite a change on exit. So
 * write() refuses while the editor runs, and always takes a backup first.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Limits the extension enforces when it loads groups. */
export const MAX_GROUPS = 100;
export const MAX_GROUPED = 1000;
export const MAX_NAME = 100;

const APPS = {
  cursor: { folder: "Cursor", process: "Cursor" },
  vscode: { folder: "Code", process: "Code" },
};

export function dbPath(app, env = process.env) {
  if (env.SESSION_SORTER_DB) return env.SESSION_SORTER_DB;
  const { folder } = APPS[app] ?? APPS.cursor;

  return join(homedir(), "Library", "Application Support", folder, "User", "globalStorage", "state.vscdb");
}

export function editorRunning(app, env = process.env) {
  if (env.SESSION_SORTER_DB) return false; // a test database belongs to no editor
  try {
    execFileSync("pgrep", ["-x", (APPS[app] ?? APPS.cursor).process], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sql(db, query, { readonly = false, immutable = false } = {}) {
  // A backup is a lone copy of a WAL-mode file. SQLite cannot open that read-only
  // without its -shm file, unless it is told the file will not change.
  const target = immutable ? `file:${encodeURI(db).replace(/[?#]/g, encodeURIComponent)}?immutable=1` : db;

  return execFileSync("sqlite3", [...(readonly ? ["-readonly"] : []), "-json", target, query], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The extension's row. The key's case varies by editor, so it is matched case-insensitively. */
export function readState(db, { immutable = false } = {}) {
  if (!existsSync(db)) throw new Error(`No editor state at ${db}. Is the extension installed in this editor?`);

  const rows = JSON.parse(sql(db, "SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE lower(key) = 'anthropic.claude-code'", { readonly: true, immutable }) || "[]");
  if (!rows.length) throw new Error("The Claude Code extension has no saved state in this editor yet. Open its Session Manager once.");

  const row = rows.find((r) => r.value.includes("sessionGroups:")) ?? rows[0];

  return { key: row.key, state: JSON.parse(row.value) };
}

export function groupsFor(state, root) {
  return Array.isArray(state[`sessionGroups:${root}`]) ? state[`sessionGroups:${root}`] : [];
}

export function archivedIds(state) {
  return new Set(Array.isArray(state.hiddenSessionIds) ? state.hiddenSessionIds : []);
}

/**
 * Write new groups for one workspace. Backs the whole file up first and
 * returns the backup's path, which `undo` restores.
 */
export function writeGroups({ db, app, root, groups, backupDir, env = process.env }) {
  if (editorRunning(app, env)) throw new Error(`${(APPS[app] ?? APPS.cursor).folder} is running. Quit it completely (Cmd+Q), then run apply again.`);

  const { key, state } = readState(db);
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `state.vscdb.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  copyFileSync(db, backup);

  const next = { ...state, [`sessionGroups:${root}`]: groups };
  const tmp = join(tmpdir(), `session-sorter-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(next));
  sql(db, `UPDATE ItemTable SET value = CAST(readfile('${tmp.replace(/'/g, "''")}') AS TEXT) WHERE key = '${key.replace(/'/g, "''")}'`);

  return backup;
}

export function latestBackup(backupDir) {
  if (!existsSync(backupDir)) return null;
  const files = readdirSync(backupDir).filter((f) => f.startsWith("state.vscdb.")).sort();

  return files.length ? join(backupDir, files.at(-1)) : null;
}
