import { useEffect, useState } from "react";
import { fiatLabel } from "../utils/exchangeRate";

interface Props {
  /** Raw amount in the token's smallest unit (stroops for XLM/classic assets,
   *  i128 units for Soroban tokens — both use 7 decimal places by default). */
  amount: number | bigint;
  symbol: string;
  /** Decimal places for this asset. Defaults to 7 (stroop / SEP-41 standard). */
  decimals?: number;
}

/** Convert a raw stroop/i128 amount to a human-readable decimal number. */
function toDecimal(raw: number | bigint, decimals: number): number {
  const divisor = Math.pow(10, decimals);
  return Number(raw) / divisor;
}

/**
 * Renders an adaptive subtitle showing the approximate USD value of a token
 * amount, e.g. "~$50.02 USD". Accepts both Soroban i128 amounts and classic
 * Stellar stroop amounts (1 XLM = 10,000,000 stroops). Renders nothing while
 * loading or if the rate is unavailable.
 */
export default function FiatValue({ amount, symbol, decimals = 7 }: Props) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Convert raw stroop / i128 units to a decimal before fiat conversion.
    const humanAmount = toDecimal(amount, decimals);
    fiatLabel(humanAmount, symbol).then((l) => {
      if (!cancelled) setLabel(l);
    });
    return () => {
      cancelled = true;
    };
  }, [amount, symbol, decimals]);

  if (!label) return null;

  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--muted)",
        display: "block",
        marginTop: 2,
      }}
    >
      {label}
    </span>
  );
}
