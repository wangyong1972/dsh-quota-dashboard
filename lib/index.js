/**
 * dsh-quota-dashboard — host half.
 *
 * One HTTP route on the dsh web server:
 *
 *   GET /api/quota-dashboard
 *
 * combining both providers:
 *
 *   - OpenRouter: real balance (`/credits`), daily/weekly/monthly usage
 *     (`/auth/key`), and last-hour spend from the local ledger.
 *   - DeepSeek: balance (`/user/balance`) and last-hour / today spend from
 *     the local ledger priced with the official DeepSeek price table
 *     (lib/pricing.js, MIT, ported from dsh-web-billing).
 *
 * The local ledger is fed by a `session/event` listener that prices every
 * `assistant/message` usage sample per provider (OpenRouter via the cached
 * `/models` price table, DeepSeek via the official price engine).
 *
 * Response envelope:
 *
 *   {
 *     "ok": true,
 *     "providers": {
 *       "openrouter": { "balance": number|null, "totalCredits": number|null,
 *         "totalUsage": number|null, "usageDaily": number|null,
 *         "usageWeekly": number|null, "usageMonthly": number|null,
 *         "hourSpend": number|null, "currency": "USD" },
 *       "deepseek": { "balance": number|null, "hourSpend": number|null,
 *         "todaySpend": number|null, "currency": "USD" }
 *     }
 *   }
 *
 * Provider errors return `{ ok:false, error, message }`. API keys never
 * leave the host: the browser only talks to this route.
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  mkdirSync, readFileSync, writeFileSync, renameSync,
  appendFileSync, existsSync,
} from "node:fs";
import { priceAt, costOf } from "./pricing.js";

const name = "dsh-quota-dashboard";
const inject = ["credentials", "webServer"];

const OR_BASE = "https://openrouter.ai/api/v1";
const DS_BASE = "https://api.deepseek.com";
const OR_CREDENTIAL_REF = credentialRef("OPENROUTER_API_KEY");
const DS_CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
const ROUTE_PATH = "/api/quota-dashboard";
const TIMEOUT_MS = 15000;

/** Local ledger file name inside `$DSH_HOME/storages`. */
const LEDGER_FILE = "quota-dashboard-ledger.jsonl";
/** Cached OpenRouter model price table, refreshed at most daily. */
const MODELS_CACHE_FILE = "quota-dashboard-models-cache.json";
const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Ledger retention: keep 7 days so hourly/daily aggregation has history. */
const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
  } catch {}
  return `Provider 接口返回 HTTP ${status}`;
}

// ---- storage paths -------------------------------------------------------

function storagePath(ctx, file) {
  let storages;
  const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") {
    storages = homeFn("storages");
  } else if (process.env.DSH_HOME) {
    storages = join(process.env.DSH_HOME, "storages");
  } else {
    storages = join(homedir(), ".dsh", "storages");
  }
  return join(storages, file);
}

// ---- small helpers -------------------------------------------------------

function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Canonicalize the provider id from session sources (deepseek-official → deepseek). */
function normalizeProvider(provider) {
  return provider === "deepseek-official" ? "deepseek" : provider;
}

async function orFetch(url, key) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(providerMessage(text, response.status));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Provider 返回了无法解析的响应");
  }
}

// ---- OpenRouter ----------------------------------------------------------

async function fetchOrKeyData(key) {
  const body = await orFetch(`${OR_BASE}/auth/key`, key);
  const data = body && typeof body === "object" ? body.data : void 0;
  if (data === void 0 || typeof data !== "object") throw new Error("OpenRouter /auth/key 响应缺少 data");
  return {
    usageDaily: toFinite(data.usage_daily),
    usageWeekly: toFinite(data.usage_weekly),
    usageMonthly: toFinite(data.usage_monthly),
  };
}

/** Real OpenRouter balance: total_credits − total_usage. */
async function fetchOrCredits(key) {
  const body = await orFetch(`${OR_BASE}/credits`, key);
  const data = body && typeof body === "object" ? body.data : void 0;
  if (data === void 0 || typeof data !== "object") throw new Error("OpenRouter /credits 响应缺少 data");
  const total = toFinite(data.total_credits);
  const used = toFinite(data.total_usage);
  return {
    totalCredits: Number.isFinite(total) ? total : null,
    totalUsage: Number.isFinite(used) ? used : null,
    balance: Number.isFinite(total) && Number.isFinite(used) ? total - used : null,
  };
}

/** OpenRouter model price table (per token USD), cached daily. */
async function resolveOrModels(ctx, key) {
  const path = storagePath(ctx, MODELS_CACHE_FILE);
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed.fetchedAt === "number" && typeof parsed.models === "object") {
        if (Date.now() - parsed.fetchedAt <= MODELS_CACHE_TTL_MS) return parsed.models;
      }
    }
  } catch {}
  try {
    const body = await orFetch(`${OR_BASE}/models`, key);
    const data = Array.isArray(body?.data) ? body.data : [];
    const table = {};
    for (const m of data) {
      if (!m || typeof m.id !== "string" || !m.pricing || typeof m.pricing !== "object") continue;
      const prompt = toFinite(m.pricing.prompt);
      const completion = toFinite(m.pricing.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        table[m.id] = { prompt, completion };
      }
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), models: table }), "utf8");
      renameSync(tmp, path);
    } catch {}
    return table;
  } catch {
    return {};
  }
}

// ---- DeepSeek ------------------------------------------------------------

async function fetchDsBalance(key) {
  const body = await orFetch(`${DS_BASE}/user/balance`, key);
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  // Prefer USD, else the first available entry.
  const usd = infos.find((i) => i && i.currency === "USD");
  const chosen = usd ?? infos[0];
  if (chosen === void 0) return { balance: null, granted: null, toppedUp: null, currency: null };
  return {
    balance: toFinite(chosen.total_balance),
    granted: toFinite(chosen.granted_balance),
    toppedUp: toFinite(chosen.topped_up_balance),
    currency: chosen.currency,
  };
}

// ---- current-conversation cost (session-log replay, per provider) ---------

/** Per-session replay cache: sessionId -> { revision, providers, at }. */
const sessionCostCache = new Map();
/** Min interval between re-decodings of the same session log. */
const REPLAY_MIN_INTERVAL_MS = 2000;

/**
 * Replay a session's persisted log and price every `assistant/message` event
 * per provider — OpenRouter via the cached `/models` table, DeepSeek via the
 * official price engine — so each provider's current-conversation cost covers
 * history from before this plugin loaded. Cached by log revision.
 * @returns `{ providers: { openrouter: {cost,calls}|null, deepseek: {cost,calls}|null }, revision }`,
 *   or `null` when the session has no stored log or the seam is unavailable.
 */
async function replaySessionLog(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (
    persistence === void 0 ||
    typeof persistence.readRaw !== "function" ||
    typeof persistence.readStoredRevision !== "function"
  ) {
    return null;
  }
  let revision;
  try {
    revision = await persistence.readStoredRevision(sessionId);
  } catch {
    return null;
  }
  if (revision === void 0) return null;
  const cached = sessionCostCache.get(sessionId);
  if (cached !== void 0) {
    if (cached.revision === revision) return cached;
    if (Date.now() - cached.at < REPLAY_MIN_INTERVAL_MS) return cached;
  }
  try {
    const raw = await persistence.readRaw(sessionId);
    if (raw === void 0 || raw === null || typeof raw.content !== "string") return null;
    const acc = {
      openrouter: { cost: 0, calls: 0 },
      deepseek: { cost: 0, calls: 0 },
    };
    // Resolve the OpenRouter model table once per replay (cached by caller).
    const orHit = await ctx.credentials.resolve(OR_CREDENTIAL_REF);
    const orKey = orHit === void 0 || orHit === null ? "" : orHit.value;
    const orModels = await resolveOrModels(ctx, orKey);

    for (const line of raw.content.split("\n")) {
      if (line === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
      try {
        const data = event.data;
        const usage = data && typeof data === "object" ? data.usage : void 0;
        if (usage === void 0 || usage === null || typeof usage !== "object") continue;
        if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") continue;
        const source = data.message && typeof data.message === "object" ? data.message.source : void 0;
        const provider = typeof source?.provider === "string" ? normalizeProvider(source.provider) : "unknown";
        const model = typeof source?.model === "string" ? source.model : "unknown";
        const sample = {
          inputTokens: usage.inputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        };
        const bucket = acc[provider];
        if (bucket === void 0) continue;
        if (provider === "openrouter") {
          const unit = orModels[model];
          if (unit !== void 0) {
            bucket.cost +=
              (sample.inputTokens * unit.prompt) +
              (sample.cacheReadTokens * unit.prompt * 0.1) +
              (sample.cacheWriteTokens * unit.prompt) +
              (sample.outputTokens * unit.completion);
          }
        } else if (provider === "deepseek") {
          const unit = priceAt(model, event.time ?? Date.now());
          const priced = costOf(sample, unit);
          bucket.cost += priced.costUsd;
        }
        bucket.calls += 1;
      } catch {
        // one malformed message must not fail the whole replay
      }
    }
    const result = { providers: acc, revision, at: Date.now() };
    sessionCostCache.set(sessionId, result);
    return result;
  } catch {
    return null;
  }
}

// ---- local ledger --------------------------------------------------------

function appendLedger(ctx, entry) {
  try {
    const path = storagePath(ctx, LEDGER_FILE);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}

function compactLedger(ctx) {
  try {
    const path = storagePath(ctx, LEDGER_FILE);
    if (!existsSync(path)) return;
    const cutoff = Date.now() - LEDGER_RETENTION_MS;
    const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).filter((line) => {
      try {
        const row = JSON.parse(line);
        return typeof row.ts === "number" && row.ts >= cutoff;
      } catch {
        return false;
      }
    });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    renameSync(tmp, path);
  } catch {}
}

/**
 * Sum ledger cost for one provider within a time window.
 * @returns total USD, or null when no rows match.
 */
function sumLedger(ctx, provider, windowMs, sinceMs) {
  try {
    const path = storagePath(ctx, LEDGER_FILE);
    if (!existsSync(path)) return null;
    const cutoff = sinceMs !== void 0 ? sinceMs : Date.now() - windowMs;
    let total = 0;
    let found = false;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (row.provider === provider && typeof row.ts === "number" && row.ts >= cutoff && typeof row.cost === "number") {
          total += row.cost;
          found = true;
        }
      } catch {}
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

/** Local calendar day start (ms). */
function dayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---- plugin body ---------------------------------------------------------

function quotaDashboardHandler(ctx) {
  return async (req, res) => {
    const out = { ok: true, providers: {} };
    // Optional ?sessionId= enables the current-conversation cost (per provider).
    const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
    // One replay serves both provider branches.
    let replay = null;
    if (sessionId !== "") {
      replay = await replaySessionLog(ctx, sessionId);
    }
    const replayOf = (provider) => {
      const bucket = replay?.providers?.[provider];
      if (bucket === void 0) return { cost: null, calls: null };
      return {
        cost: Math.round(bucket.cost * 1e6) / 1e6,
        calls: bucket.calls,
      };
    };

    // OpenRouter
    try {
      const orHit = await ctx.credentials.resolve(OR_CREDENTIAL_REF);
      const orKey = orHit === void 0 || orHit === null ? null : orHit.value;
      if (orKey !== null && orKey !== "") {
        const [credits, keyData] = await Promise.all([
          fetchOrCredits(orKey),
          fetchOrKeyData(orKey),
        ]);
        const hour = sumLedger(ctx, "openrouter", 60 * 60 * 1000);
        const { cost: sessionCost, calls: sessionCalls } = replayOf("openrouter");
        out.providers.openrouter = {
          balance: credits.balance === null ? null : Math.round(credits.balance * 100) / 100,
          totalCredits: credits.totalCredits,
          totalUsage: credits.totalUsage,
          usageDaily: keyData.usageDaily,
          usageWeekly: keyData.usageWeekly,
          usageMonthly: keyData.usageMonthly,
          hourSpend: hour === null ? null : Math.round(hour * 1e6) / 1e6,
          sessionCost,
          sessionCalls,
          currency: "USD",
        };
      } else {
        out.providers.openrouter = { error: "missing-key", message: "未配置 OPENROUTER_API_KEY" };
      }
    } catch (error) {
      out.providers.openrouter = { error: "provider", message: String(error.message ?? error) };
    }

    // DeepSeek
    try {
      const dsHit = await ctx.credentials.resolve(DS_CREDENTIAL_REF);
      const dsKey = dsHit === void 0 || dsHit === null ? null : dsHit.value;
      if (dsKey !== null && dsKey !== "") {
        const { balance, granted, toppedUp, currency } = await fetchDsBalance(dsKey);
        const hour = sumLedger(ctx, "deepseek", 60 * 60 * 1000);
        const today = sumLedger(ctx, "deepseek", 0, dayStartMs());
        const { cost: sessionCost, calls: sessionCalls } = replayOf("deepseek");
        out.providers.deepseek = {
          balance: balance === null ? null : Math.round(balance * 100) / 100,
          granted: granted === null ? null : Math.round(granted * 100) / 100,
          toppedUp: toppedUp === null ? null : Math.round(toppedUp * 100) / 100,
          hourSpend: hour === null ? null : Math.round(hour * 1e6) / 1e6,
          todaySpend: today === null ? null : Math.round(today * 1e6) / 1e6,
          sessionCost,
          sessionCalls,
          currency: currency ?? "USD",
        };
      } else {
        out.providers.deepseek = { error: "missing-key", message: "未配置 DEEPSEEK_API_KEY" };
      }
    } catch (error) {
      out.providers.deepseek = { error: "provider", message: String(error.message ?? error) };
    }

    compactLedger(ctx);
    out.updatedAt = Date.now();
    sendJson(res, 200, out);
  };
}

/** Price one assistant/message usage sample into the ledger (per provider). */
function installLedger(ctx) {
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message") return;
    try {
      const data = event.data;
      const usage = data && typeof data === "object" ? data.usage : void 0;
      if (usage === void 0 || usage === null || typeof usage !== "object") return;
      if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return;
      const source = data.message && typeof data.message === "object" ? data.message.source : void 0;
      const provider = typeof source?.provider === "string" ? normalizeProvider(source.provider) : "unknown";
      const model = typeof source?.model === "string" ? source.model : "unknown";
      const sample = {
        inputTokens: usage.inputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
      void (async () => {
        try {
          let cost = 0;
          const ts = event.time ?? Date.now();
          if (provider === "openrouter") {
            const orHit = await ctx.credentials.resolve(OR_CREDENTIAL_REF);
            const orKey = orHit === void 0 || orHit === null ? "" : orHit.value;
            const models = await resolveOrModels(ctx, orKey);
            const unit = models[model];
            if (unit !== void 0) {
              cost =
                (sample.inputTokens * unit.prompt) +
                (sample.cacheReadTokens * unit.prompt * 0.1) +
                (sample.cacheWriteTokens * unit.prompt) +
                (sample.outputTokens * unit.completion);
            }
          } else if (provider === "deepseek") {
            const unit = priceAt(model, ts);
            const priced = costOf(sample, unit);
            cost = priced.costUsd;
          }
          // Always write the ledger row (cost may be 0 when the model has no
          // price entry) so hourly/daily aggregation is never empty.
          appendLedger(ctx, { ts, provider, model, ...sample, cost });
        } catch (error) {
          ctx.logger.warn("dsh-quota-dashboard: ledger pricing failed");
          ctx.logger.warn(error);
        }
      })();
    } catch (error) {
      ctx.logger.warn("dsh-quota-dashboard: failed to price an assistant/message event");
      ctx.logger.warn(error);
    }
  });
}

function apply(ctx) {
  installLedger(ctx);
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: quotaDashboardHandler(ctx),
    }),
    "dsh-quota-dashboard: quota route",
  );
}

export { apply, inject, name };
