/**
 * One Jev call, through whichever key is present. Questions are written once,
 * in TypeSafe's own format (`noul`, `choice`, `score`), and every backend
 * returns the same normalized answers:
 *
 *   noul   → { type, p, confidence }            p = P(yes)
 *   choice → { type, choice, probabilities, confidence }
 *   score  → { type, score, probabilities, confidence }
 *
 * A Noul has no confidence of its own in the API. Here it is max(p, 1 - p),
 * the probability of whichever answer won, so every answer can be banded the
 * same way.
 */
import { existsSync } from "node:fs";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const GATEWAY_MODEL = "typesafe-ai/jev";

/**
 * JEV_BACKEND picks one explicitly. Otherwise the Vercel AI Gateway key wins,
 * then the TypeSafe key. JEV_ENV_FILE points at a dotenv file to read keys
 * from, so a key can stay in the project that owns it.
 */
export function pickBackend(env = process.env) {
  if (env.JEV_ENV_FILE && !env.AI_GATEWAY_API_KEY && !env.TYPESAFE_API_KEY && existsSync(env.JEV_ENV_FILE)) {
    process.loadEnvFile(env.JEV_ENV_FILE);
    env = process.env;
  }

  if (env.JEV_BACKEND) return env.JEV_BACKEND;
  if (env.AI_GATEWAY_API_KEY) return "gateway";
  if (env.TYPESAFE_API_KEY) return "typesafe";

  return null;
}

export class NoBackendError extends Error {
  constructor() {
    super("No Jev key. Set AI_GATEWAY_API_KEY or TYPESAFE_API_KEY, or JEV_ENV_FILE to a file holding one.");
  }
}

export async function ask({ state, questions, model = "jev-latest", timeoutMs = 4000, env = process.env }) {
  const backend = pickBackend(env);
  if (!backend) throw new NoBackendError();

  const call = { typesafe: viaTypeSafe, gateway: viaGateway, offline: viaOffline }[backend];
  if (!call) throw new Error(`Unknown JEV_BACKEND "${backend}". Use gateway, typesafe or offline.`);

  const started = performance.now();
  const result = await call({ state, questions, model, signal: AbortSignal.timeout(timeoutMs), env: process.env });

  return { ...result, backend, ms: Math.round(performance.now() - started) };
}

async function viaTypeSafe({ state, questions, model, signal, env }) {
  const body = await post(TYPESAFE_URL, { Authorization: `Bearer ${env.TYPESAFE_API_KEY}` }, { state, model, questions }, signal);
  const answers = {};

  for (const [id, raw] of Object.entries(body.answers)) {
    answers[id] = raw.type === "noul" ? noul(raw.noul) : { ...raw, confidence: raw.confidence ?? top(raw.probabilities) };
  }

  return { answers, model: body.model, cost: null, usage: body.usage };
}

async function viaGateway({ state, questions, signal, env }) {
  // The gateway speaks the AI SDK's evaluation spec, where a Noul is "boolean".
  const translated = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, q.type === "noul" ? { ...q, type: "boolean" } : q]),
  );
  const headers = {
    Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`,
    "ai-gateway-protocol-version": "0.0.1",
    "ai-gateway-auth-method": "api-key",
    "ai-evaluation-model-specification-version": "4",
    "ai-model-id": GATEWAY_MODEL,
  };
  const body = await post(GATEWAY_URL, headers, { state, questions: translated }, signal);
  const confidence = body.providerMetadata?.typesafe?.confidence ?? {};
  const answers = {};

  for (const [id, raw] of Object.entries(body.answers)) {
    answers[id] =
      raw.type === "boolean"
        ? noul(raw.probability)
        : { ...raw, confidence: confidence[id] ?? top(raw.probabilities) };
  }

  const gateway = body.providerMetadata?.gateway ?? {};
  const cost = gateway.marketCost ?? gateway.cost;

  return { answers, model: GATEWAY_MODEL, cost: cost === undefined ? null : Number(cost), usage: body.usage };
}

/**
 * No network. Answers come from JEV_OFFLINE_ANSWERS (JSON, TypeSafe's answer
 * shape, keyed by question id); anything missing is a coin flip, which every
 * gate reads as "no opinion". Used by the dry run and the tests.
 */
async function viaOffline({ questions, env }) {
  const given = env.JEV_OFFLINE_ANSWERS ? JSON.parse(env.JEV_OFFLINE_ANSWERS) : {};
  const answers = {};

  for (const [id, q] of Object.entries(questions)) {
    const raw = given[id];
    if (q.type === "noul") answers[id] = noul(raw?.noul ?? 0.5);
    else if (raw) answers[id] = { ...raw, confidence: raw.confidence ?? top(raw.probabilities) };
    else if (q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 0 };
    else answers[id] = { type: "score", score: (q.criteria.length - 1) / 2, probabilities: {}, confidence: 0 };
  }

  return { answers, model: "offline", cost: 0, usage: null };
}

async function post(url, headers, payload, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    // The body can echo the request; keep the status and a short message only.
    const text = (await response.text()).slice(0, 200);
    throw new Error(`Jev call failed: HTTP ${response.status} ${text}`);
  }

  return response.json();
}

function noul(p) {
  return { type: "noul", p, confidence: Math.max(p, 1 - p) };
}

function top(probabilities = {}) {
  const values = Object.values(probabilities);

  return values.length ? Math.max(...values) : 0;
}
