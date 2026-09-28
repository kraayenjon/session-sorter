/**
 * Everything here runs on fixtures: a fake ~/.claude, a fake editor state
 * database, and canned Jev answers. No real session or editor is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, decide, stateFor } from "../src/classify.mjs";
import { applyPlan, validateCategories } from "../src/plan.mjs";
import { encodeProject, listSessions } from "../src/sessions.mjs";
import { readState } from "../src/store.mjs";

const line = (o) => JSON.stringify(o);
const user = (text, extra = {}) => line({ type: "user", message: { role: "user", content: text }, timestamp: "2026-09-20T10:00:00Z", gitBranch: "main", ...extra });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "session-sorter-"));
  const project = join(base, "work", "kaptex");
  mkdirSync(project, { recursive: true });
  const config = join(base, "claude");
  const dir = join(config, "projects", encodeProject(project));
  mkdirSync(dir, { recursive: true });

  const sessions = {
    s1: [user("Fix the Stripe webhook for Kaptex checkout"), line({ type: "ai-title", aiTitle: "Kaptex Stripe webhook" })],
    s2: [user("<command-name>/seo-audit</command-name>"), user("Audit madewithjev.com for SEO issues", { timestamp: "2026-09-21T10:00:00Z" })],
    s3: [user("Write a LinkedIn post about launching Sift"), line({ type: "custom-title", customTitle: "Sift launch post" })],
    grouped: [user("Kaptex pricing page copy")],
    archived: [user("Old experiment")],
    agent: [line({ type: "user", isSidechain: true, message: { content: "subagent work" } })],
  };
  for (const [id, lines] of Object.entries(sessions)) writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);

  const db = join(base, "state.vscdb");
  const state = {
    [`sessionGroups:${realpathSync(project)}`]: [{ id: "g1", name: "Kaptex", collapsed: false, sessionIds: ["grouped"] }],
    [`sessionGroups:/somewhere/else`]: [{ id: "g9", name: "Other project", collapsed: true, sessionIds: ["x"] }],
    hiddenSessionIds: ["archived"],
    thinkingLevel: "default_on",
  };
  execFileSync("sqlite3", [db, "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); CREATE TABLE other (x);"]);
  writeFileSync(join(base, "seed.json"), JSON.stringify(state));
  execFileSync("sqlite3", [db, `INSERT INTO ItemTable VALUES ('Anthropic.claude-code', CAST(readfile('${join(base, "seed.json")}') AS TEXT)); INSERT INTO ItemTable VALUES ('other.extension', '{"keep":true}');`]);

  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, SESSION_SORTER_DB: db, SESSION_SORTER_HOME: join(base, "home"), JEV_BACKEND: "offline" };
  delete env.AI_GATEWAY_API_KEY;
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_ENV_FILE;

  return { base, project, root: realpathSync(project), config, db, env };
}

const cli = (f, ...args) => execFileSync("node", [join(import.meta.dirname, "../src/cli.mjs"), ...args, "--project", f.project], { env: f.env, encoding: "utf8" });

test("sessions: titles by priority, subagent transcripts skipped, commands unwrapped", async () => {
  const f = fixture();
  const sessions = await listSessions(f.project, f.env);
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

  assert.equal(byId.agent, undefined);
  assert.equal(byId.s1.title, "Kaptex Stripe webhook"); // ai-title
  assert.equal(byId.s3.title, "Sift launch post"); // custom-title wins
  assert.equal(byId.s2.title, "Audit madewithjev.com for SEO issues"); // last prompt
  assert.equal(byId.s2.firstPrompt, "/seo-audit");
});

test("decide: bands and other", () => {
  assert.equal(decide({ choice: "SEO", confidence: 0.85 }), "move");
  assert.equal(decide({ choice: "SEO", confidence: 0.6 }), "review");
  assert.equal(decide({ choice: "SEO", confidence: 0.4 }), "leave");
  assert.equal(decide({ choice: "other", confidence: 0.99 }), "leave");
});

test("state sent to Jev is clipped and redacted", () => {
  const s = stateFor({ title: "t", firstPrompt: `use key sk-abcdefghijklmnop12345 ${"x ".repeat(600)}`, lastPrompt: "same", branch: "main", updatedAt: "2026-09-20T00:00:00Z" });
  assert.ok(!s.first_request.includes("sk-abc"));
  assert.ok(s.first_request.length <= 700);
});

test("classify: one call per session; a failed call leaves the session alone", async () => {
  const sessions = [{ id: "a", title: "Kaptex", firstPrompt: "k", lastPrompt: "k", updatedAt: "2026-01-01" }, { id: "b", title: "boom", firstPrompt: "b", lastPrompt: "b", updatedAt: "2026-01-01" }];
  const ask = async ({ state }) => {
    if (state.title === "boom") throw new Error("timeout");
    return { answers: { category: { choice: "Kaptex", confidence: 0.93, probabilities: { Kaptex: 0.93, SEO: 0.07 } } }, cost: 0.00002 };
  };
  const { items } = await classify(sessions, [{ name: "Kaptex" }, { name: "SEO" }], { ask });

  assert.equal(items[0].decision, "move");
  assert.equal(items[0].runnerUp, "SEO (0.07)");
  assert.equal(items[1].decision, "leave");
  assert.match(items[1].error, /timeout/);
});

test("applyPlan: reuses groups by name, creates the rest, never moves a grouped session", () => {
  const groups = [{ id: "g1", name: "Kaptex", collapsed: false, sessionIds: ["old"] }];
  const plan = {
    items: [
      { sessionId: "a", category: "kaptex", decision: "move" },
      { sessionId: "b", category: "SEO", decision: "move" },
      { sessionId: "c", category: "SEO", decision: "review" },
      { sessionId: "old", category: "SEO", decision: "move" },
      { sessionId: "d", category: "SEO", decision: "leave" },
    ],
  };

  const { groups: next, skipped } = applyPlan(groups, plan);
  assert.deepEqual(next[0].sessionIds, ["old", "a"]);
  assert.equal(next[1].name, "SEO");
  assert.deepEqual(next[1].sessionIds, ["b"]);
  assert.equal(skipped[0].why, "already in a group");

  assert.deepEqual(applyPlan(groups, plan, { includeReview: true }).groups[1].sessionIds, ["b", "c"]);
  assert.deepEqual(groups[0].sessionIds, ["old"]); // input untouched
});

test("categories: validation", () => {
  assert.deepEqual(validateCategories({ categories: [{ name: "A" }, { name: "B" }] }), []);
  assert.equal(validateCategories({ categories: [{ name: "A" }] }).length, 1);
  assert.match(validateCategories({ categories: [{ name: "A" }, { name: "Other" }] })[0], /reserved/);
  assert.match(validateCategories({ categories: [{ name: "A" }, { name: "a" }] })[0], /twice/);
});

test("end to end on a fixture: scan, classify, apply, undo", () => {
  const f = fixture();

  assert.match(cli(f, "scan"), /ungrouped   3/);
  cli(f, "categories");
  writeFileSync(join(f.env.SESSION_SORTER_HOME, encodeProject(f.root), "categories.json"), JSON.stringify({ categories: [{ name: "Kaptex" }, { name: "SEO" }, { name: "Content" }] }));

  f.env.JEV_OFFLINE_ANSWERS = JSON.stringify({ category: { type: "choice", choice: "SEO", confidence: 0.9, probabilities: { SEO: 0.9 } } });
  assert.match(cli(f, "classify"), /move 3/);

  assert.match(cli(f, "apply"), /Nothing written/);
  assert.deepEqual(readState(f.db).state[`sessionGroups:${f.root}`].length, 1);

  assert.match(cli(f, "apply", "--yes"), /Written/);
  const after = readState(f.db).state;
  const seo = after[`sessionGroups:${f.root}`].find((g) => g.name === "SEO");
  assert.deepEqual(seo.sessionIds.sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(after[`sessionGroups:/somewhere/else`][0].sessionIds, ["x"]); // other projects untouched
  assert.equal(after.thinkingLevel, "default_on");
  assert.equal(execFileSync("sqlite3", [f.db, "SELECT value FROM ItemTable WHERE key = 'other.extension'"], { encoding: "utf8" }).trim(), '{"keep":true}');

  assert.match(cli(f, "undo", "--yes"), /Restored/);
  assert.deepEqual(readState(f.db).state[`sessionGroups:${f.root}`], [{ id: "g1", name: "Kaptex", collapsed: false, sessionIds: ["grouped"] }]);
});
