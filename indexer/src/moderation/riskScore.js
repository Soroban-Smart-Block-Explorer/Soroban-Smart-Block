/**
 * Registry submission risk scoring (#934). Pure function: callers gather the
 * context (submitter history, rate, ABI verification, ownership) and this
 * returns a score, the signals behind it, and the resulting status.
 *
 *   score < MEDIUM → published
 *   score < HIGH   → pending  (published with a badge, excluded from ranking)
 *   score ≥ HIGH   → held     (moderation queue)
 *
 * A verified ownership claim outranks impersonation heuristics.
 */

export const MEDIUM = 30;
export const HIGH = 60;

// Well-known asset names/tickers commonly impersonated.
const KNOWN_TOKENS = ["usdc", "usdt", "xlm", "stellar", "eurc", "aqua", "yxlm", "btc", "eth", "circle", "tether", "soroswap", "blend"];
const IMPERSONATION_WORDS = /\b(official|verified|airdrop|giveaway|claim|support|bonus|reward)\b/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s"'<>)]+/gi;
const TRUSTED_DOMAINS = ["stellar.org", "github.com", "circle.com", "tether.to", "soroswap.finance", "blend.capital"];
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "rb.gy"];
const RISKY_TLDS = [".zip", ".mov", ".xyz", ".top", ".click", ".gq", ".tk", ".ml", ".cf", ".ga", ".ru"];
const PHISHING_WORDS = /(wallet-?connect|seed|recover|validate|unlock|claim|airdrop|login|verify)/i;

function hostOf(url) {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Score one URL; returns 0 for trusted domains. */
export function urlRisk(url) {
  const host = hostOf(url);
  if (!host) return 10;
  if (TRUSTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 0;
  let risk = 5;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) risk += 30;
  if (host.startsWith("xn--") || host.includes(".xn--")) risk += 30;
  if (SHORTENERS.includes(host)) risk += 20;
  if (RISKY_TLDS.some((t) => host.endsWith(t))) risk += 15;
  if (PHISHING_WORDS.test(url)) risk += 25;
  // Look-alikes of trusted domains, e.g. stellar-org.com, circle-usdc.io.
  if (TRUSTED_DOMAINS.some((d) => host.includes(d.split(".")[0]))) risk += 25;
  return risk;
}

function collectText(submission) {
  const parts = [submission.name, submission.description];
  for (const fn of submission.functions ?? []) parts.push(fn?.name, fn?.description);
  return parts.filter(Boolean).join(" ");
}

/**
 * @param {object} submission  POST /api/contracts body (name, description, functions)
 * @param {object} ctx
 * @param {boolean} [ctx.ownershipVerified]  on-chain ownership proof (#875)
 * @param {number}  [ctx.abiMismatches]      functions/args not matching the on-chain spec
 * @param {number}  [ctx.priorRejections]    submitter's rejected/hidden registrations
 * @param {number}  [ctx.priorApproved]      submitter's published registrations
 * @param {number}  [ctx.recentSubmissions]  submitter's registrations in the last hour
 * @param {boolean} [ctx.banned]             submitter is banned
 */
export function scoreSubmission(submission, ctx = {}) {
  const signals = [];
  const add = (signal, points, detail) => {
    if (points > 0) signals.push({ signal, points, ...(detail ? { detail } : {}) });
  };

  if (ctx.banned) add("banned_submitter", 100);

  const name = String(submission.name ?? "").toLowerCase();
  const text = collectText(submission);
  const impersonated = KNOWN_TOKENS.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(name));
  if (!ctx.ownershipVerified) {
    if (impersonated.length) add("impersonation_known_token", 35, impersonated.join(","));
    if (IMPERSONATION_WORDS.test(submission.name ?? "")) add("impersonation_wording", 30);
  }

  const urls = text.match(URL_RE) ?? [];
  const worst = urls.reduce((m, u) => Math.max(m, urlRisk(u)), 0);
  // A link scoring ≥ 50 combines several phishing traits: hold it outright.
  if (worst > 0) add("url_reputation", worst >= 50 ? HIGH : Math.min(worst, 45), urls.slice(0, 5).join(" "));

  if (ctx.abiMismatches > 0) add("abi_spec_mismatch", Math.min(10 * ctx.abiMismatches, 40));

  if (ctx.priorRejections > 0) add("submitter_history", Math.min(20 * ctx.priorRejections, 40));
  if (ctx.priorApproved >= 3 && !ctx.priorRejections) add("submitter_trusted", 0);

  if (ctx.recentSubmissions > 10) add("submission_rate", 30, `${ctx.recentSubmissions}/h`);
  else if (ctx.recentSubmissions > 3) add("submission_rate", 10, `${ctx.recentSubmissions}/h`);

  let score = signals.reduce((s, x) => s + x.points, 0);
  // Established submitters with clean history get a modest discount.
  if (ctx.priorApproved >= 3 && !ctx.priorRejections) score = Math.max(0, score - 10);
  score = Math.min(score, 100);

  const status = score >= HIGH ? "held" : score >= MEDIUM ? "pending" : "published";
  return { score, status, signals };
}

/** Reporter weight from history: new reporters 1, upheld raises, dismissed lowers. */
export function reporterWeight({ upheld = 0, dismissed = 0 } = {}) {
  return Math.max(0.1, Math.min(3, (1 + upheld) / (1 + dismissed)));
}

// Weighted report total at which a published/pending contract is queued.
export const REPORT_ESCALATION_THRESHOLD = 5;
