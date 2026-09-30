/**
 * WebAuthn passkey ceremonies (#933) on top of @simplewebauthn/server.
 * Multiple passkeys per account; stored transports (including "hybrid")
 * let cross-device passkeys be offered on sign-in.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { db } from "../db.js";

const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Soroban Explorer";
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const ORIGINS = (process.env.WEBAUTHN_ORIGINS || "http://localhost:5173").split(",").map((o) => o.trim());

export async function registrationOptions(account) {
  const existing = await db.listPasskeys(account.id);
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: account.email,
    userID: new TextEncoder().encode(account.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
}

export async function verifyRegistration(account, response, expectedChallenge, name) {
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
  });
  if (!verified || !registrationInfo) return false;
  const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
  await db.insertPasskey({
    id: credential.id,
    accountId: account.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: response.response?.transports ?? credential.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    name: name ? String(name).slice(0, 64) : null,
  });
  return true;
}

/** accountId null → discoverable-credential (username-less) sign-in. */
export async function authenticationOptions(accountId = null) {
  const creds = accountId ? await db.listPasskeys(accountId) : [];
  return generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "preferred",
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
  });
}

/** @returns the account id the passkey belongs to, or null. */
export async function verifyAuthentication(response, expectedChallenge, expectedAccountId = null) {
  const stored = await db.getPasskey(response?.id);
  if (!stored) return null;
  if (expectedAccountId && stored.account_id !== expectedAccountId) return null;
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    credential: {
      id: stored.id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
  });
  if (!verified) return null;
  await db.updatePasskeyCounter(stored.id, authenticationInfo.newCounter);
  return stored.account_id;
}
