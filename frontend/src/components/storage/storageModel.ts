// Issue #922: derive a contract's storage snapshot from the state-history API.
import type { StateDiff } from "../../api";

export type Durability = "persistent" | "instance" | "temporary";
export const DURABILITIES: Durability[] = ["persistent", "instance", "temporary"];

export interface StorageEntry {
  key: string;
  durability: Durability;
  value: string | null;
  sizeBytes: number;
  liveUntilLedger: number | null;
  lastLedger: number;
  history: StateDiff[];
  // Set for logical keys expanded out of the instance-storage map.
  parentKey?: string;
}

export function durabilityOf(tier: string | undefined): Durability {
  const t = (tier || "").toLowerCase();
  if (t.startsWith("inst")) return "instance";
  if (t.startsWith("temp")) return "temporary";
  return "persistent";
}

function byteLength(v: string | null): number {
  return v == null ? 0 : new TextEncoder().encode(v).length;
}

// Replays diffs up to `asOfLedger` (inclusive) and returns the live entries at that point.
export function buildSnapshot(diffs: StateDiff[], asOfLedger?: number): StorageEntry[] {
  const map = new Map<string, StorageEntry>();
  const sorted = [...diffs].sort((a, b) => a.ledger - b.ledger);
  for (const d of sorted) {
    if (asOfLedger != null && d.ledger > asOfLedger) break;
    const id = `${durabilityOf(d.tier)}:${d.key}`;
    const prev = map.get(id);
    const history = [...(prev?.history ?? []), d];
    if (d.change_type === "removed") {
      map.delete(id);
      continue;
    }
    map.set(id, {
      key: d.key,
      durability: durabilityOf(d.tier),
      value: d.new_value,
      sizeBytes: d.size_bytes ?? byteLength(d.new_value),
      liveUntilLedger: d.live_until_ledger ?? prev?.liveUntilLedger ?? null,
      lastLedger: d.ledger,
      history,
    });
  }
  return [...map.values()].flatMap(expandInstance);
}

// Instance storage is a single entry holding a map; expand it into logical keys.
export function expandInstance(entry: StorageEntry): StorageEntry[] {
  if (entry.durability !== "instance" || entry.value == null) return [entry];
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    return [entry];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [entry];
  return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
    const value = JSON.stringify(v);
    return { ...entry, key: k, value, sizeBytes: byteLength(value), parentKey: entry.key };
  });
}

export function isArchived(entry: StorageEntry, currentLedger: number | null): boolean {
  return (
    entry.durability !== "temporary" &&
    entry.liveUntilLedger != null &&
    currentLedger != null &&
    entry.liveUntilLedger < currentLedger
  );
}

// Rough restore cost: base fee plus per-KB write/rent share (stroops). Shown as an estimate only.
export function estimateRestoreCostStroops(sizeBytes: number): number {
  return 100_000 + Math.ceil(sizeBytes / 1024) * 50_000;
}

export function filterEntries(entries: StorageEntry[], query: string, prefix: string): StorageEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => (!prefix || e.key.startsWith(prefix)) && (!q || e.key.toLowerCase().includes(q)));
}
