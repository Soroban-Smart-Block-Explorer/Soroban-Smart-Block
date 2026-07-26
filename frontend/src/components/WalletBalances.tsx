import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { resolveAssetLogo } from "../utils/assetLogo";
import { truncateAddress } from "../utils/strkey";

interface Props {
  address: string;
}

function formatAmount(balance: string): string {
  const n = Number(balance);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 7 }) : balance;
}

function AssetLogo({ code, issuer }: { code: string; issuer: string | null }) {
  const [logo, setLogo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveAssetLogo(code, issuer).then((url) => {
      if (!cancelled) setLogo(url);
    });
    return () => {
      cancelled = true;
    };
  }, [code, issuer]);

  if (logo) {
    return <img src={logo} alt="" width={20} height={20} style={{ borderRadius: "50%", flexShrink: 0 }} />;
  }
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        width: 20,
        height: 20,
        flexShrink: 0,
        borderRadius: "50%",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 9,
        color: "var(--muted)",
      }}
    >
      {code.slice(0, 1)}
    </span>
  );
}

/**
 * XLM balance + classic/SEP-41 asset table for a wallet, sourced from Horizon
 * (issue #530). Fetch failures render a non-fatal inline message so the
 * caller's event history can still load (issue #529).
 */
export default function WalletBalances({ address }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["walletBalances", address],
    queryFn: () => api.walletBalances(address),
    enabled: !!address,
    retry: false,
  });

  if (isLoading) return <p style={{ color: "var(--muted)" }}>Loading balances…</p>;

  if (error) {
    return (
      <p role="alert" style={{ color: "#f85149" }}>
        Unable to load balances from Horizon right now. Event history below is unaffected.
      </p>
    );
  }

  const balances = data?.balances ?? [];
  const xlm = balances.find((b) => b.is_native);
  const assets = balances.filter((b) => !b.is_native);

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--muted)" }}>XLM Balance</div>
      <div style={{ fontSize: 30, fontWeight: 700, marginTop: 2 }}>
        {xlm ? formatAmount(xlm.balance) : "0"} <span style={{ fontSize: 15, color: "var(--muted)" }}>XLM</span>
      </div>

      {assets.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 16 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--muted)" }}>
                <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500 }}>Asset</th>
                <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 500 }}>Issuer</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 500 }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((b) => (
                <tr key={`${b.asset_code}:${b.asset_issuer}`} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <AssetLogo code={b.asset_code} issuer={b.asset_issuer} />
                      {b.asset_code}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: 12, color: "var(--muted)" }} title={b.asset_issuer ?? undefined}>
                    {b.asset_issuer ? truncateAddress(b.asset_issuer) : "—"}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{formatAmount(b.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
