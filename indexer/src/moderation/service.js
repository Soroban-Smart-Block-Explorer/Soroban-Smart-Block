/**
 * Registry moderation workflow (#934): scoring on submission, user reports,
 * moderator actions, and submitter appeals. Every state change is written to
 * moderation_actions. Moderation only curates explorer metadata — on-chain
 * events for a contract are never hidden.
 */
import { db } from "../db.js";
import { logger } from "../logger.js";
import { scoreSubmission, reporterWeight, REPORT_ESCALATION_THRESHOLD } from "./riskScore.js";

export const REPORT_REASONS = ["impersonation", "phishing", "offensive", "spam", "incorrect_abi", "other"];
export const HIDDEN_STATUSES = ["held", "hidden", "rejected"];
const MAX_REPORTS_PER_HOUR = 5;
// When set, hide/reject/ban actions are queued for mirroring via the explorer
// contract's Moderator role (deregister_contract) by the signer service.
const MIRROR_ONCHAIN = process.env.MODERATION_ONCHAIN_MIRROR === "true";

// Templated notices sent with moderator actions (shown to the submitter).
export const NOTICE_TEMPLATES = {
  approve: "Your registration for {id} was reviewed and approved.",
  reject: "Your registration for {id} was rejected: {reason}. You may appeal this decision.",
  hide: "The metadata for {id} has been hidden pending review: {reason}. On-chain activity remains visible.",
  ban: "Your account can no longer submit registrations: {reason}.",
};

export function renderNotice(action, { id, reason }) {
  const template = NOTICE_TEMPLATES[action];
  return template ? template.replace("{id}", id).replace("{reason}", reason || "policy violation") : null;
}

const ACTION_STATUS = { approve: "published", reject: "rejected", hide: "hidden", ban: "rejected" };

export class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Score a new registration and set its moderation status. */
export async function evaluateSubmission(contractId, submission, { submitter, abiMismatches = 0, ownershipVerified = false } = {}) {
  const ctx = await db.getModerationContext(submitter);
  const result = scoreSubmission(submission, { ...ctx, abiMismatches, ownershipVerified });
  await db.setContractModeration(contractId, { status: result.status, score: result.score, signals: result.signals });
  await db.insertModerationAction({
    contractId,
    action: "submit",
    actor: submitter ?? "anonymous",
    toStatus: result.status,
    evidence: { score: result.score, signals: result.signals },
  });
  if (result.status !== "published") {
    logger.info({ contractId, score: result.score, status: result.status }, "[moderation] submission flagged");
  }
  return result;
}

/** A user report; rate-limited and weighted by reporter reputation. */
export async function reportContract(contractId, { reporter, reason, details }) {
  if (!REPORT_REASONS.includes(reason)) throw new ModerationError(400, `reason must be one of ${REPORT_REASONS.join(", ")}`);
  const meta = await db.getContractMeta(contractId);
  if (!meta) throw new ModerationError(404, "Not found");
  const stats = await db.getReporterStats(reporter);
  if (stats.recent >= MAX_REPORTS_PER_HOUR) throw new ModerationError(429, "Too many reports; try again later");
  if (await db.hasOpenReport(contractId, reporter)) throw new ModerationError(409, "You already reported this contract");

  const weight = reporterWeight(stats);
  const total = await db.insertModerationReport({ contractId, reporter, reason, details: details?.slice(0, 2000), weight });
  await db.insertModerationAction({ contractId, action: "report", actor: reporter, evidence: { reason, weight, total } });

  let escalated = false;
  if (total >= REPORT_ESCALATION_THRESHOLD && ["published", "pending"].includes(meta.moderation_status)) {
    await db.setContractModeration(contractId, { status: "held" });
    await db.insertModerationAction({
      contractId,
      action: "escalate",
      actor: "system",
      fromStatus: meta.moderation_status,
      toStatus: "held",
      evidence: { report_weight: total },
    });
    escalated = true;
  }
  return { ok: true, escalated };
}

/** Moderator action: approve | reject | hide | ban. */
export async function moderate(contractId, { action, actor, reason, notice }) {
  const toStatus = ACTION_STATUS[action];
  if (!toStatus) throw new ModerationError(400, "action must be approve, reject, hide or ban");
  const meta = await db.getContractMeta(contractId);
  if (!meta) throw new ModerationError(404, "Not found");

  await db.setContractModeration(contractId, { status: toStatus });
  await db.resolveModerationReports(contractId, action !== "approve");
  const submitter = meta.registered_by_key_id ?? meta.registered_by;
  if (action === "ban" && submitter) await db.banSubmitter(String(submitter), { reason, bannedBy: actor });

  return db.insertModerationAction({
    contractId,
    action,
    actor,
    fromStatus: meta.moderation_status,
    toStatus,
    notice: notice || renderNotice(action, { id: contractId, reason }),
    evidence: { reason: reason ?? null, submitter: submitter ?? null },
    onchainStatus: MIRROR_ONCHAIN && action !== "approve" ? "pending" : null,
  });
}

/** Submitter appeal against a held/hidden/rejected registration. */
export async function fileAppeal(contractId, { submitter, message }) {
  if (!message || message.length < 10) throw new ModerationError(400, "message must be at least 10 characters");
  const meta = await db.getContractMeta(contractId);
  if (!meta) throw new ModerationError(404, "Not found");
  const owner = String(meta.registered_by_key_id ?? meta.registered_by ?? "");
  if (!submitter || owner !== String(submitter)) throw new ModerationError(403, "Only the submitter may appeal");
  if (!HIDDEN_STATUSES.includes(meta.moderation_status)) throw new ModerationError(409, "Registration is not under moderation");

  const appeal = await db.insertModerationAppeal({ contractId, submitter: String(submitter), message: message.slice(0, 4000) });
  await db.insertModerationAction({ contractId, action: "appeal", actor: String(submitter), evidence: { appeal_id: appeal.id } });
  return appeal;
}

export async function decideAppeal(appealId, { granted, actor, notice }) {
  const appeal = await db.decideModerationAppeal(appealId, { granted, decidedBy: actor });
  if (!appeal) throw new ModerationError(404, "Open appeal not found");
  if (granted) await db.setContractModeration(appeal.contract_id, { status: "published" });
  await db.insertModerationAction({
    contractId: appeal.contract_id,
    action: granted ? "appeal_granted" : "appeal_denied",
    actor,
    toStatus: granted ? "published" : null,
    notice: notice ?? null,
    evidence: { appeal_id: appeal.id },
  });
  return appeal;
}
