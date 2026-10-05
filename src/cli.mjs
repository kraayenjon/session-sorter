#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { classify } from "./classify.mjs";
import { pickBackend } from "./jev.mjs";
import { applyPlan, validateCategories } from "./plan.mjs";
import { archivedIds, backupGroups, dbPath, editorRunning, groupsFor, latestBackup, readState, writeGroups } from "./store.mjs";
import { encodeProject, listSessions, scopeRoot, sessionsDir } from "./sessions.mjs";

const HELP = `session-sorter — sort ungrouped Claude Code sessions into Session Manager groups, with Jev

  scan                 Count sessions: grouped, ungrouped, archived. Reads only.
  titles               List the ungrouped sessions, to decide on categories.
  categories           Create or show categories.json (existing groups are prefilled).
  classify [--limit N] Ask Jev which category each ungrouped session belongs to. Writes plan.json.
  review               Show plan.json: what would move where, and how sure Jev is.
  apply [--include-review] [--yes]
                       Without --yes: show the changes. With --yes: write them (the editor must be closed).
  undo [--yes]         Put this project's groups back as they were before the last apply.
  doctor               Paths, editor, key. Reads only.

Options: --project <path> (default: current folder)   --app cursor|vscode (default: cursor)
Keys: AI_GATEWAY_API_KEY or TYPESAFE_API_KEY (JEV_BACKEND picks one; JEV_ENV_FILE reads a dotenv file).`;

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const has = (name) => args.includes(name);

const project = resolve(flag("--project") ?? process.cwd());
const app = flag("--app") ?? "cursor";
const root = scopeRoot(project);
const db = dbPath(app);
const work = process.env.SESSION_SORTER_HOME ? join(process.env.SESSION_SORTER_HOME, encodeProject(root)) : join(homedir(), ".session-sorter", encodeProject(root));
const files = { categories: join(work, "categories.json"), plan: join(work, "plan.json"), backups: join(work, "backups") };

// Paths under the home folder print as ~/…, shorter and safe to paste or screenshot.
const say = (...lines) => console.log(lines.join("\n").replaceAll(homedir(), "~"));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  mkdirSync(work, { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

async function inventory() {
  const { state } = readState(db);
  const groups = groupsFor(state, root);
  const grouped = new Set(groups.flatMap((g) => g.sessionIds));
  const archived = archivedIds(state);
  const sessions = await listSessions(project);
  const ungrouped = sessions.filter((s) => !grouped.has(s.id) && !archived.has(s.id));

  return { groups, grouped, sessions, archived, ungrouped };
}

async function main() {
  switch (command) {
    case "scan": {
      const { groups, grouped, sessions, archived, ungrouped } = await inventory();
      return say(
        `project     ${root}`,
        `sessions    ${sessions.length}`,
        `grouped     ${sessions.filter((s) => grouped.has(s.id)).length} in ${groups.length} group${groups.length === 1 ? "" : "s"}${groups.length ? `: ${groups.map((g) => g.name).join(", ")}` : ""}`,
        `archived    ${sessions.filter((s) => archived.has(s.id)).length}`,
        `ungrouped   ${ungrouped.length}`,
      );
    }

    case "titles": {
      const { ungrouped } = await inventory();
      return say(...ungrouped.map((s, i) => `${String(i + 1).padStart(3)}. ${s.updatedAt.slice(0, 10)}  ${s.title}`));
    }

    case "categories": {
      if (!existsSync(files.categories)) {
        const { groups } = await inventory();
        const draft = {
          categories: groups.length
            ? groups.map((g) => ({ name: g.name, description: "" }))
            : [
                { name: "Example product", description: "Work on the example product: its site, app, pricing and launch" },
                { name: "SEO", description: "Search Console, keyword research, audits and ranking work across sites" },
              ],
        };
        writeJson(files.categories, draft);
        say(`Created ${files.categories}${groups.length ? " with your existing groups." : " with two examples."}`, "Edit it: one name and a one-line description per category. The description is what Jev reads.\n");
      }

      const data = readJson(files.categories);
      const problems = validateCategories(data);
      say(...data.categories.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`));
      if (problems.length) say("", ...problems.map((p) => `! ${p}`));

      return say("", `File: ${files.categories}`);
    }

    case "classify": {
      if (!existsSync(files.categories)) throw new Error("No categories yet. Run: session-sorter categories");
      const data = readJson(files.categories);
      const problems = validateCategories(data);
      if (problems.length) throw new Error(`Fix categories.json first:\n${problems.join("\n")}`);
      if (!pickBackend()) throw new Error("No Jev key. Set AI_GATEWAY_API_KEY or TYPESAFE_API_KEY, or JEV_ENV_FILE.");

      const { ungrouped } = await inventory();
      const limit = Number(flag("--limit") ?? ungrouped.length);
      const batch = ungrouped.slice(0, limit);
      if (!batch.length) return say("No ungrouped sessions.");

      const started = Date.now();
      const { items, cost } = await classify(batch, data.categories, {
        onProgress: (done, total) => process.stderr.write(`\r  ${done}/${total}`),
      });
      process.stderr.write("\n");
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      writeJson(files.plan, { project: root, createdAt: new Date().toISOString(), seconds, cost, categories: data.categories, items });

      const count = (d) => items.filter((i) => i.decision === d).length;
      return say(
        `Sorted ${items.length} sessions in ${seconds.toFixed(1)} s, cost $${cost}.`,
        `  move ${count("move")}   review ${count("review")}   leave ${count("leave")}${items.some((i) => i.error) ? `   failed ${items.filter((i) => i.error).length}` : ""}`,
        "",
        "Nothing has moved. Next: session-sorter review",
      );
    }

    case "review": {
      if (!existsSync(files.plan)) throw new Error("No plan yet. Run: session-sorter classify");
      const plan = readJson(files.plan);
      const out = [];
      for (const decision of ["move", "review", "leave"]) {
        const items = plan.items.filter((i) => i.decision === decision);
        if (!items.length) continue;
        out.push(`\n${decision.toUpperCase()} (${items.length})${decision === "review" ? " — moved only with --include-review" : ""}`);
        const byCategory = Object.groupBy(items, (i) => i.category ?? "(failed)");
        for (const [category, list] of Object.entries(byCategory)) {
          out.push(`  ${category}`);
          for (const i of list) out.push(`    ${i.confidence.toFixed(2)}  ${i.title}${i.runnerUp ? `   [or ${i.runnerUp}]` : ""}`);
        }
      }

      return say(...out, "", `To change a decision, edit ${files.plan} ("decision": move | review | leave, or a different "category").`, "Then: session-sorter apply");
    }

    case "apply": {
      if (!existsSync(files.plan)) throw new Error("No plan yet. Run: session-sorter classify");
      const plan = readJson(files.plan);
      // A plan can be days old. Only sessions that are still ungrouped move: not ones
      // archived, grouped by hand or deleted since classify ran.
      const { groups: current, ungrouped } = await inventory();
      const live = new Set(ungrouped.map((s) => s.id));
      const wanted = (i) => i.decision === "move" || (has("--include-review") && i.decision === "review");
      const stale = plan.items.filter((i) => wanted(i) && !live.has(i.sessionId)).length;
      const { groups, changes, skipped } = applyPlan(current, { ...plan, items: plan.items.filter((i) => live.has(i.sessionId)) }, { includeReview: has("--include-review") });

      const created = changes.filter((c) => c.type === "create").map((c) => c.group);
      const moves = changes.filter((c) => c.type === "move");
      say(`${moves.length} sessions into ${new Set(moves.map((m) => m.group)).size} groups${created.length ? `, ${created.length} new: ${created.join(", ")}` : ""}.`);
      for (const [group, list] of Object.entries(Object.groupBy(moves, (m) => m.group))) say(`  ${group}: ${list.length}`);
      if (stale) say(`Left out ${stale}: archived, grouped or deleted since the plan was made (${plan.createdAt.slice(0, 10)}). For a fresh plan, run: session-sorter classify`);
      if (skipped.length) say(`Skipped ${skipped.length}: ${[...new Set(skipped.map((s) => s.why))].join("; ")}.`);
      if (!moves.length) return;

      if (!has("--yes")) return say("", "Nothing written. Quit the editor completely (Cmd+Q), then run: session-sorter apply --yes" + (has("--include-review") ? " --include-review" : ""));

      const backup = writeGroups({ db, app, root, groups, backupDir: files.backups });
      return say("", `Written. Backup: ${backup}`, "Open the editor again to see the groups. To reverse: session-sorter undo --yes");
    }

    case "undo": {
      const backup = latestBackup(files.backups);
      if (!backup) throw new Error("No backup for this project. Nothing to undo.");
      const before = backupGroups(backup, root);
      say(`Restore this project's groups from ${backup}: ${before.length} group${before.length === 1 ? "" : "s"}, ${before.reduce((n, g) => n + g.sessionIds.length, 0)} sessions.`);
      if (!has("--yes")) return say("Nothing written. Quit the editor, then run: session-sorter undo --yes");

      writeGroups({ db, app, root, groups: before, backupDir: files.backups });
      return say("Restored. Other projects and settings were not touched.");
    }

    case "doctor": {
      return say(
        `project      ${root}`,
        `sessions     ${sessionsDir(project)} ${existsSync(sessionsDir(project)) ? "" : "(not found)"}`,
        `editor       ${app}, ${editorRunning(app) ? "running (apply and undo need it closed)" : "not running"}`,
        `state        ${db} ${existsSync(db) ? "" : "(not found)"}`,
        `work files   ${work}`,
        `jev backend  ${pickBackend() ?? "none — set AI_GATEWAY_API_KEY or TYPESAFE_API_KEY"}`,
      );
    }

    default:
      return say(HELP);
  }
}

main().catch((error) => {
  console.error(`session-sorter: ${error.message}`);
  process.exit(1);
});
