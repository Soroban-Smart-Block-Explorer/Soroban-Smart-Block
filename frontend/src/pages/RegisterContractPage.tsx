/**
 * RegisterContractPage — Issue #513
 *
 * /contracts/register — form for submitting ABI metadata to the registry.
 * Fields: Contract ID, Name, Description, Functions (via AbiFunctionTable).
 * Client-side validation before any API call.
 * Successful registration navigates to /contract/:id.
 */
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api";
import AbiFunctionTable, {
  emptyFunctionList,
  type FunctionRow,
} from "../components/AbiFunctionTable";

// Stellar Strkey for contracts starts with 'C' (ed25519 pubkey)
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

interface FieldError {
  contractId?: string;
  name?: string;
  description?: string;
  general?: string;
}

function validate(
  contractId: string,
  name: string,
  description: string,
): FieldError {
  const errors: FieldError = {};
  if (!contractId) {
    errors.contractId = "Contract ID is required.";
  } else if (!CONTRACT_ID_RE.test(contractId)) {
    errors.contractId =
      "Contract ID must be a 56-character Stellar strkey beginning with 'C'.";
  }
  if (!name.trim()) {
    errors.name = "Name is required.";
  } else if (name.length > 64) {
    errors.name = "Name must be 64 characters or fewer.";
  }
  if (description.length > 512) {
    errors.description = "Description must be 512 characters or fewer.";
  }
  return errors;
}

export default function RegisterContractPage() {
  const navigate = useNavigate();

  const [contractId, setContractId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [registeredBy, setRegisteredBy] = useState("");
  const [functions, setFunctions] = useState<FunctionRow[]>(emptyFunctionList);

  const [errors, setErrors] = useState<FieldError>({});
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function showToast(kind: "success" | "error", message: string) {
    setToast({ kind, message });
    if (kind === "success") {
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setToast(null);

    // Client-side validation — no API call on failure
    const fieldErrors = validate(contractId, name, description);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }
    setErrors({});

    // Normalise functions: strip empty param names that weren't filled in
    const payload = {
      id: contractId,
      name: name.trim(),
      description: description.trim(),
      registered_by: registeredBy.trim() || contractId,
      functions: functions.map((fn) => ({
        name: fn.name.trim(),
        description: fn.description.trim(),
        params: fn.params
          .filter((p) => p.name.trim())
          .map((p) => ({ name: p.name.trim(), kind: p.kind })),
      })),
    };

    setSubmitting(true);
    try {
      await api.registerContract(payload);
      showToast("success", `Contract ${contractId} registered successfully!`);
      // Navigate to the success page with contract ID and name in URL
      setTimeout(
        () =>
          navigate(
            `/contracts/register/success?id=${encodeURIComponent(contractId)}&name=${encodeURIComponent(name.trim())}`,
          ),
        800,
      );
    } catch (err: unknown) {
      const apiErr = err as { status?: number; data?: { error?: string }; message?: string };
      if (apiErr.status === 409) {
        setErrors({ contractId: "This contract is already registered." });
        showToast("error", "Contract is already registered.");
      } else if (apiErr.status === 400) {
        const detail = apiErr.data?.error ?? "Invalid request.";
        setErrors({ general: detail });
        showToast("error", detail);
      } else {
        const msg = apiErr.message ?? "An unexpected error occurred.";
        setErrors({ general: msg });
        showToast("error", msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = { width: "100%" };
  const errorStyle: React.CSSProperties = { color: "#f85149", fontSize: 12, marginTop: 4 };

  return (
    <div style={{ maxWidth: 780, display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Page header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <Link to="/contracts" style={{ fontSize: 13, color: "var(--muted)" }}>
            ← Contract Registry
          </Link>
        </div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Register Contract ABI</h1>
        <p style={{ color: "var(--muted)" }}>
          Add your Soroban contract's ABI so that events can be decoded into human-readable form.
          New to this?{" "}
          <a
            href="https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/blob/main/docs/guides/register-abi.md"
            target="_blank"
            rel="noreferrer"
          >
            Read the ABI registration guide
          </a>
          .
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "10px 16px",
            borderRadius: 6,
            background: toast.kind === "success" ? "#1a7f37" : "#a40e26",
            color: "#fff",
            fontSize: 14,
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Form */}
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label="Register contract form"
        style={{ display: "flex", flexDirection: "column", gap: 20 }}
      >
        {/* Contract ID */}
        <div>
          <label htmlFor="reg-contract-id" style={{ display: "block", marginBottom: 4 }}>
            Contract ID *
          </label>
          <input
            id="reg-contract-id"
            aria-label="Contract ID"
            aria-describedby={errors.contractId ? "reg-contract-id-err" : undefined}
            aria-invalid={!!errors.contractId}
            value={contractId}
            onChange={(e) => setContractId(e.target.value.trim())}
            placeholder="CABC…XYZ (56 chars, starts with C)"
            maxLength={56}
            style={{ ...inputStyle, fontFamily: "monospace" }}
            disabled={submitting}
          />
          {errors.contractId && (
            <p id="reg-contract-id-err" role="alert" style={errorStyle}>
              {errors.contractId}
            </p>
          )}
        </div>

        {/* Name */}
        <div>
          <label htmlFor="reg-name" style={{ display: "block", marginBottom: 4 }}>
            Contract name *
          </label>
          <input
            id="reg-name"
            aria-label="Contract name"
            aria-describedby={errors.name ? "reg-name-err" : undefined}
            aria-invalid={!!errors.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. StellarSwap DEX"
            maxLength={64}
            style={inputStyle}
            disabled={submitting}
          />
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            {name.length}/64
          </p>
          {errors.name && (
            <p id="reg-name-err" role="alert" style={errorStyle}>
              {errors.name}
            </p>
          )}
        </div>

        {/* Description */}
        <div>
          <label htmlFor="reg-description" style={{ display: "block", marginBottom: 4 }}>
            Description
          </label>
          <textarea
            id="reg-description"
            aria-label="Contract description"
            aria-describedby={errors.description ? "reg-description-err" : undefined}
            aria-invalid={!!errors.description}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what this contract does…"
            maxLength={512}
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
            disabled={submitting}
          />
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            {description.length}/512
          </p>
          {errors.description && (
            <p id="reg-description-err" role="alert" style={errorStyle}>
              {errors.description}
            </p>
          )}
        </div>

        {/* Registered by */}
        <div>
          <label htmlFor="reg-registered-by" style={{ display: "block", marginBottom: 4 }}>
            Registered by (Stellar address)
          </label>
          <input
            id="reg-registered-by"
            aria-label="Registrant Stellar address"
            value={registeredBy}
            onChange={(e) => setRegisteredBy(e.target.value.trim())}
            placeholder="GABC…  (optional — defaults to Contract ID)"
            style={{ ...inputStyle, fontFamily: "monospace" }}
            disabled={submitting}
          />
        </div>

        {/* Functions */}
        <div>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Function signatures</h2>
          <AbiFunctionTable value={functions} onChange={setFunctions} />
        </div>

        {/* General error */}
        {errors.general && (
          <p role="alert" style={errorStyle}>
            {errors.general}
          </p>
        )}

        {/* Submit */}
        <div>
          <button
            type="submit"
            disabled={submitting}
            aria-busy={submitting}
            style={{ padding: "8px 24px", fontWeight: 600 }}
          >
            {submitting ? "Registering…" : "Register contract"}
          </button>
        </div>
      </form>
    </div>
  );
}
