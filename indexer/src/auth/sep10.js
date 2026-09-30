/**
 * Optional "Sign in with Stellar" (SEP-10) linked to the same account (#933).
 * Enabled when SEP10_SIGNING_SECRET is set. A wallet can only sign in after
 * it has been linked from an authenticated, stepped-up session.
 */
import { WebAuth, Keypair, Networks } from "@stellar/stellar-sdk";

const HOME_DOMAIN = process.env.SEP10_HOME_DOMAIN || "localhost";
const WEB_AUTH_DOMAIN = process.env.SEP10_WEB_AUTH_DOMAIN || HOME_DOMAIN;
const PASSPHRASE = process.env.NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

function serverKeypair() {
  const secret = process.env.SEP10_SIGNING_SECRET;
  return secret ? Keypair.fromSecret(secret) : null;
}

export const sep10Enabled = () => Boolean(process.env.SEP10_SIGNING_SECRET);

export function buildChallenge(account) {
  const kp = serverKeypair();
  if (!kp) throw new Error("SEP-10 is not configured");
  return WebAuth.buildChallengeTx(kp, account, HOME_DOMAIN, 300, PASSPHRASE, WEB_AUTH_DOMAIN);
}

/** Verifies the client signed the exact challenge we issued; returns its G-address. */
export function verifyChallenge(signedXdr, issuedXdr) {
  const kp = serverKeypair();
  if (!kp) throw new Error("SEP-10 is not configured");
  const { tx, clientAccountID } = WebAuth.readChallengeTx(signedXdr, kp.publicKey(), PASSPHRASE, HOME_DOMAIN, WEB_AUTH_DOMAIN);
  const issued = WebAuth.readChallengeTx(issuedXdr, kp.publicKey(), PASSPHRASE, HOME_DOMAIN, WEB_AUTH_DOMAIN).tx;
  if (tx.hash().toString("hex") !== issued.hash().toString("hex")) throw new Error("Challenge mismatch");
  WebAuth.verifyChallengeTxSigners(signedXdr, kp.publicKey(), PASSPHRASE, [clientAccountID], HOME_DOMAIN, WEB_AUTH_DOMAIN);
  return clientAccountID;
}
