/**
 * Sorting sessions into categories with Jev. One call per session, a few in
 * flight at once: a single Choice over the approved categories plus "other",
 * judged from the title and what the user asked. Jev never invents a
 * category; the list comes from categories.json, which a person approved.
 *
 *   confidence ≥ act (0.80)      → move
 *   surface (0.50) … act         → review: listed, moved only if you say so
 *   below surface, or "other"    → leave where it is
 */
import { ask as defaultAsk } from "./jev.mjs";

export const BANDS = { act: 0.8, surface: 0.5 };
const OTHER = "other";

export function questionFor(categories) {
  const criteria = Object.fromEntries(categories.map((c) => [c.name, c.description || null]));
  criteria[OTHER] = "None of the other categories fits this session well";

  return {
    category: {
      type: "choice",
      instructions:
        "Which category does this Claude Code session belong to? Judge by what the work was about (the product, the project, the kind of task), using `title`, `first_request` and `last_request`.",
      criteria,
    },
  };
}

export function stateFor(session) {
  return {
    title: clip(session.title, 160),
    first_request: clip(session.firstPrompt, 700),
    last_request: session.lastPrompt === session.firstPrompt ? "" : clip(session.lastPrompt, 400),
    branch: session.branch || "",
    date: session.updatedAt.slice(0, 10),
  };
}

export function decide(answer, bands = BANDS) {
  if (answer.choice === OTHER) return "leave";
  if (answer.confidence >= bands.act) return "move";
  if (answer.confidence >= bands.surface) return "review";

  return "leave";
}

export async function classify(sessions, categories, { ask = defaultAsk, concurrency = 6, onProgress = () => {} } = {}) {
  const questions = questionFor(categories);
  const items = new Array(sessions.length);
  let next = 0;
  let done = 0;
  let cost = 0;

  async function worker() {
    while (next < sessions.length) {
      const i = next++;
      const session = sessions[i];
      try {
        const result = await ask({ state: stateFor(session), questions, timeoutMs: 15_000 });
        const answer = result.answers.category;
        cost += result.cost ?? 0;
        items[i] = {
          sessionId: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          category: answer.choice,
          confidence: Math.round(answer.confidence * 100) / 100,
          runnerUp: runnerUp(answer),
          decision: decide(answer),
        };
      } catch (error) {
        items[i] = { sessionId: session.id, title: session.title, updatedAt: session.updatedAt, category: null, confidence: 0, decision: "leave", error: String(error.message).slice(0, 160) };
      }
      onProgress(++done, sessions.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sessions.length) }, worker));

  return { items, cost: Math.round(cost * 1e6) / 1e6 };
}

function runnerUp(answer) {
  const sorted = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1]);

  return sorted[1] && sorted[1][1] > 0.05 ? `${sorted[1][0]} (${sorted[1][1].toFixed(2)})` : null;
}

// ---------------------------------------------------------------- redaction

const SECRETS = [
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, "[redacted]"],
  [/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]"],
  [/\b(api[_-]?key|token|secret|password|passwd)\b(\s*[=:]\s*)[^\s"']+/gi, "$1$2[redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, "[redacted]"],
];

export function clip(text, n) {
  let out = String(text ?? "");
  for (const [re, replacement] of SECRETS) out = out.replace(re, replacement);
  out = out.replace(/\s+/g, " ").trim();

  return out.length > n ? `${out.slice(0, n - 1)}…` : out;
}
