/**
 * Cookie sessions for developer accounts (#933).
 *
 *   - Opaque 256-bit id in an HttpOnly, Secure, SameSite=Lax cookie; only its
 *     SHA-256 hash is stored (auth_sessions.id_hash).
 *   - A new id is issued at every sign-in and on every privilege change
 *     (passkey added, step-up, recovery) — no pre-auth id is ever reused, so
 *     session fixation is not possible.
 *   - Idle timeout (last_seen_at) and absolute timeout (expires_at).
 *   - Step-up: elevated_until opens a short window for sensitive actions.
 *   - State-changing requests still pass through verifyCsrf (csrf.js): a
 *     session cookie is never accepted as a substitute for the CSRF header.
 */
import crypto from "crypto";
import { db } from "../db.js";

export const SESSION_COOKIE = "sid";
export const CHALLENGE_COOKIE = "auth-challenge";
export const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_MINUTES ?? 30) * 60_000;
export const ABSOLUTE_TIMEOUT_MS = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 12) * 3_600_000;
export const STEP_UP_MS = Number(process.env.SESSION_STEP_UP_MINUTES ?? 5) * 60_000;

export const hashToken = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
export const randomToken = () => crypto.randomBytes(32).toString("base64url");

export function getCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function cookieOptions(maxAgeMs) {
  return { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: maxAgeMs };
}

/**
 * Pure session validity check.
 * @returns {"valid"|"missing"|"revoked"|"expired"|"idle"}
 */
export function evaluateSession(row, now = Date.now()) {
  if (!row) return "missing";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= now) return "expired";
  if (new Date(row.last_seen_at).getTime() + IDLE_TIMEOUT_MS <= now) return "idle";
  return "valid";
}

export function isElevated(row, now = Date.now()) {
  return Boolean(row?.elevated_until && new Date(row.elevated_until).getTime() > now);
}

/** Issue a fresh session (revoking the caller's current one, if any). */
export async function startSession(req, res, accountId, authMethod, { elevated = false } = {}) {
  const current = getCookie(req, SESSION_COOKIE);
  if (current) await db.revokeAuthSession(hashToken(current));
  const id = randomToken();
  const now = Date.now();
  await db.insertAuthSession({
    idHash: hashToken(id),
    accountId,
    authMethod,
    expiresAt: new Date(now + ABSOLUTE_TIMEOUT_MS),
    elevatedUntil: elevated ? new Date(now + STEP_UP_MS) : null,
  });
  res.cookie(SESSION_COOKIE, id, cookieOptions(ABSOLUTE_TIMEOUT_MS));
  return id;
}

/** Rotate the id on privilege change, keeping the absolute expiry. */
export async function rotateSession(req, res, { elevated = false } = {}) {
  const session = req.session;
  if (!session) throw new Error("No session to rotate");
  await db.revokeAuthSession(session.id_hash);
  const id = randomToken();
  await db.insertAuthSession({
    idHash: hashToken(id),
    accountId: session.account_id,
    authMethod: session.auth_method,
    expiresAt: session.expires_at,
    elevatedUntil: elevated ? new Date(Date.now() + STEP_UP_MS) : session.elevated_until,
  });
  res.cookie(SESSION_COOKIE, id, cookieOptions(new Date(session.expires_at).getTime() - Date.now()));
  return id;
}

export async function endSession(req, res) {
  const current = getCookie(req, SESSION_COOKIE);
  if (current) await db.revokeAuthSession(hashToken(current));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Loads req.session when a valid session cookie is present. */
export async function loadSession(req, _res, next) {
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw) return next();
  try {
    const row = await db.getAuthSession(hashToken(raw));
    if (evaluateSession(row) === "valid") {
      req.session = row;
      await db.touchAuthSession(row.id_hash);
    }
  } catch {
    // Treat lookup failures as signed out.
  }
  next();
}

export function requireSession(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Sign in required" });
  next();
}

/** Sensitive actions (admin-scoped keys, billing, passkey removal). */
export function requireStepUp(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Sign in required" });
  if (!isElevated(req.session)) return res.status(403).json({ error: "Re-authentication required", step_up: true });
  next();
}

/** Challenge ids travel in a short-lived HttpOnly cookie bound to this browser. */
export async function issueChallenge(res, { purpose, challenge, accountId = null }) {
  const id = randomToken();
  await db.insertAuthChallenge({
    idHash: hashToken(id),
    purpose,
    challenge,
    accountId,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  res.cookie(CHALLENGE_COOKIE, id, cookieOptions(5 * 60_000));
}

export async function takeChallenge(req, res, purpose) {
  const id = getCookie(req, CHALLENGE_COOKIE);
  res.clearCookie(CHALLENGE_COOKIE, { path: "/" });
  if (!id) return null;
  return db.consumeAuthChallenge(hashToken(id), purpose);
}
