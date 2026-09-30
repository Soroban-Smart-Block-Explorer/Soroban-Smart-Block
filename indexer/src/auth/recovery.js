/**
 * Account recovery and email links (#933).
 *
 * Trade-off (documented): losing every passkey requires BOTH the verified
 * email link AND an unused recovery code. A compromised mailbox alone cannot
 * take over an account; a user who loses both passkeys and recovery codes
 * must contact support.
 */
import crypto from "crypto";
import { db } from "../db.js";
import { sendEmail } from "../emailService.js";
import { hashToken, randomToken } from "./session.js";

export const EMAIL_PURPOSES = ["signup", "claim", "recovery"];
const EMAIL_TOKEN_TTL_MS = 15 * 60_000;
const RECOVERY_CODE_COUNT = 10;
const APP_URL = process.env.APP_URL || "http://localhost:5173";

/** Normalized code hash: case/whitespace/dash-insensitive. */
export const hashRecoveryCode = (code) => hashToken(String(code).replace(/[\s-]/g, "").toUpperCase());

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT) {
  return Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Replace the account's recovery codes; returns the plaintext set once. */
export async function issueRecoveryCodes(accountId) {
  const codes = generateRecoveryCodes();
  await db.replaceRecoveryCodes(accountId, codes.map(hashRecoveryCode));
  return codes;
}

export async function sendEmailLink(email, purpose) {
  const token = randomToken();
  await db.insertEmailToken({
    tokenHash: hashToken(token),
    email,
    purpose,
    expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
  });
  const link = `${APP_URL}/login?purpose=${purpose}&token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: email,
    subject: "Your Soroban Explorer sign-in link",
    text: `Use this link within 15 minutes to continue (${purpose}):\n\n${link}\n\nIf you did not request it, ignore this email.`,
  }).catch(() => {});
  return token;
}

export const consumeEmailLink = (token, purpose) => db.consumeEmailToken(hashToken(token), purpose);
