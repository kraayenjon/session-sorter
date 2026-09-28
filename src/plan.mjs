/**
 * Turning a classification into new groups. Pure: groups and a plan in, new
 * groups and a list of changes out. The rules:
 *
 *   - Only ungrouped sessions move. A session you already filed stays put.
 *   - Existing groups are reused by name (case-insensitive); others are created.
 *   - Nothing is ever removed from a group, and no group is deleted.
 *   - The extension's limits (100 groups, 1000 grouped sessions) are respected.
 */
import { randomUUID } from "node:crypto";

import { MAX_GROUPED, MAX_GROUPS, MAX_NAME } from "./store.mjs";

export function applyPlan(groups, plan, { includeReview = false } = {}) {
  const next = groups.map((g) => ({ ...g, sessionIds: [...g.sessionIds] }));
  const grouped = new Set(next.flatMap((g) => g.sessionIds));
  const changes = [];
  const skipped = [];

  for (const item of plan.items) {
    const wanted = item.decision === "move" || (includeReview && item.decision === "review");
    if (!wanted || !item.category) continue;
    if (grouped.has(item.sessionId)) {
      skipped.push({ ...item, why: "already in a group" });
      continue;
    }
    if (grouped.size >= MAX_GROUPED) {
      skipped.push({ ...item, why: `the extension holds at most ${MAX_GROUPED} grouped sessions` });
      continue;
    }

    const name = [...item.category.trim()].slice(0, MAX_NAME).join("");
    let group = next.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (!group) {
      if (next.length >= MAX_GROUPS) {
        skipped.push({ ...item, why: `the extension holds at most ${MAX_GROUPS} groups` });
        continue;
      }
      group = { id: randomUUID(), name, collapsed: false, sessionIds: [] };
      next.push(group);
      changes.push({ type: "create", group: name });
    }

    group.sessionIds.push(item.sessionId);
    grouped.add(item.sessionId);
    changes.push({ type: "move", group: group.name, sessionId: item.sessionId, title: item.title, confidence: item.confidence });
  }

  return { groups: next, changes, skipped };
}

export function validateCategories(data) {
  const list = Array.isArray(data?.categories) ? data.categories : [];
  const problems = [];
  const seen = new Set();

  if (list.length < 2) problems.push("Add at least two categories.");
  if (list.length > 30) problems.push("Keep it to 30 categories or fewer; fewer, sharper ones sort better.");
  for (const c of list) {
    const name = String(c?.name ?? "").trim();
    if (!name) problems.push("Every category needs a name.");
    else if ([...name].length > MAX_NAME) problems.push(`"${name.slice(0, 30)}…" is longer than ${MAX_NAME} characters.`);
    else if (name.toLowerCase() === "other") problems.push('"other" is reserved: it is what a session gets when nothing fits.');
    else if (seen.has(name.toLowerCase())) problems.push(`"${name}" appears twice.`);
    seen.add(name.toLowerCase());
  }

  return problems;
}
