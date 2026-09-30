import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { recover, registerPasskey, signInWithPasskey, startEmail, verifySignup, claimKeys } from "../services/accountApi";

// Developer sign-in (#933): passkeys first; email links create an account,
// claim existing API keys once, or (with a recovery code) recover access.

type Mode = "signin" | "signup" | "recovery" | "claim";

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const linkToken = params.get("token");
  const linkPurpose = params.get("purpose") as Mode | null;
  const [mode, setMode] = useState<Mode>(linkPurpose === "recovery" ? "recovery" : "signin");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  // Email link landing: signup and claim complete automatically.
  useEffect(() => {
    if (!linkToken) return;
    if (linkPurpose === "signup") {
      void run(async () => {
        const result = await verifySignup(linkToken);
        setRecoveryCodes(result.recovery_codes ?? null);
        setMessage(
          `Email verified${result.claimed_api_keys ? `; ${result.claimed_api_keys} API key(s) linked` : ""}. Add a passkey to finish.`,
        );
        setMode("signup");
      });
    } else if (linkPurpose === "claim") {
      void run(async () => {
        const result = await claimKeys(linkToken);
        setMessage(`${result.claimed_api_keys} API key(s) linked to your account.`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkToken, linkPurpose]);

  const sendLink = (purpose: "signup" | "recovery") =>
    run(async () => {
      await startEmail(email, purpose);
      setMessage("Check your email for a link (valid 15 minutes).");
    });

  return (
    <div className="card" style={{ maxWidth: 460, margin: "48px auto", padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>Developer sign-in</h2>
      {error && <p role="alert" style={{ color: "var(--danger, #b91c1c)" }}>{error}</p>}
      {message && <p role="status">{message}</p>}

      {recoveryCodes && (
        <div aria-label="Recovery codes" style={{ border: "1px solid var(--border)", padding: 12, marginBottom: 12 }}>
          <strong>Save these recovery codes.</strong> Each works once and, together with your email, is the only way
          back in if you lose every passkey. They will not be shown again.
          <pre data-testid="recovery-codes">{recoveryCodes.join("\n")}</pre>
        </div>
      )}

      {mode === "signin" && (
        <>
          <button type="button" disabled={busy} onClick={() => run(async () => { await signInWithPasskey(); navigate("/dashboard"); })}>
            Sign in with a passkey
          </button>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Works with passkeys on this device or on your phone (scan the QR code).
          </p>
          <p style={{ fontSize: 13 }}>
            New here or have existing API keys?{" "}
            <button type="button" onClick={() => setMode("signup")}>Create an account</button>{" "}
            · Lost your passkeys? <button type="button" onClick={() => setMode("recovery")}>Recover</button>
          </p>
        </>
      )}

      {mode === "signup" && (
        linkPurpose === "signup" && linkToken ? (
          <button type="button" disabled={busy} onClick={() => run(async () => { await registerPasskey(); navigate("/dashboard"); })}>
            Add a passkey
          </button>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void sendLink("signup"); }} style={{ display: "flex", gap: 8 }}>
            <input type="email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required style={{ flex: 1 }} />
            <button type="submit" disabled={busy}>Email me a link</button>
          </form>
        )
      )}

      {mode === "recovery" && (
        linkPurpose === "recovery" && linkToken ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await recover(linkToken, code);
                setMessage("Recovered. Register a new passkey now.");
                await registerPasskey();
                navigate("/dashboard");
              });
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input aria-label="Recovery code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" required style={{ flex: 1 }} />
            <button type="submit" disabled={busy}>Recover account</button>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void sendLink("recovery"); }} style={{ display: "flex", gap: 8 }}>
            <input type="email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required style={{ flex: 1 }} />
            <button type="submit" disabled={busy}>Email me a recovery link</button>
          </form>
        )
      )}
    </div>
  );
}
