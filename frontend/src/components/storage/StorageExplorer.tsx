/**
 * Issue #922: contract storage explorer — entries grouped by durability with
 * decoded keys/values, size, live TTL, per-entry history and "as of ledger N".
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { Bar } from "../TTLProgressBar";
import StructuredValue from "../StructuredValue";
import {
  DURABILITIES,
  buildSnapshot,
  estimateRestoreCostStroops,
  filterEntries,
  isArchived,
  type Durability,
  type StorageEntry,
} from "./storageModel";

const ROW_HEIGHT = 56;
const VIEWPORT_ROWS = 10;
const TRUNCATE_AT = 120;

function decode(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // Unknown key/value types fall back to the raw ScVal string.
    return value;
  }
}

function ValueCell({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false);
  if (value == null) return <span style={{ color: "var(--muted)" }}>—</span>;
  if (value.length <= TRUNCATE_AT || open) {
    const decoded = decode(value);
    return typeof decoded === "string" ? (
      <code style={{ wordBreak: "break-all" }}>{decoded}</code>
    ) : (
      <StructuredValue value={decoded} />
    );
  }
  return (
    <span>
      <code>{value.slice(0, TRUNCATE_AT)}…</code>{" "}
      <button onClick={() => setOpen(true)} style={{ minHeight: 44 }}>
        Expand
      </button>
    </span>
  );
}

function EntryDetail({ entry, currentLedger }: { entry: StorageEntry; currentLedger: number | null }) {
  const archived = isArchived(entry, currentLedger);
  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }} data-testid="storage-entry-detail">
      <h4 style={{ marginTop: 0, wordBreak: "break-all" }}>{entry.key}</h4>
      <ValueCell value={entry.value} />
      {currentLedger != null && (
        <Bar label="TTL" liveUntilLedger={entry.liveUntilLedger} currentLedger={currentLedger} />
      )}
      {archived && (
        <p role="note" data-testid="restore-guidance">
          This entry is archived. Restore it with a <code>RestoreFootprintOp</code> covering this key (e.g.{" "}
          <code>stellar contract restore --key …</code>). Estimated restore cost: ~
          {estimateRestoreCostStroops(entry.sizeBytes).toLocaleString()} stroops.
        </p>
      )}
      <h5>History</h5>
      <ol style={{ paddingLeft: 18 }}>
        {entry.history.map((h) => (
          <li key={`${h.ledger}-${h.tx_hash}`}>
            Ledger {h.ledger.toLocaleString()} — {h.change_type}
          </li>
        ))}
      </ol>
    </div>
  );
}

// Fixed-height windowed list: only visible rows are mounted.
function VirtualList({ entries, onSelect }: { entries: StorageEntry[]; onSelect: (e: StorageEntry) => void }) {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2);
  const visible = entries.slice(start, start + VIEWPORT_ROWS + 4);
  return (
    <div
      style={{ maxHeight: ROW_HEIGHT * VIEWPORT_ROWS, overflowY: "auto", position: "relative" }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="list"
    >
      <div style={{ height: entries.length * ROW_HEIGHT, position: "relative" }}>
        {visible.map((e, i) => (
          <button
            key={`${e.parentKey ?? ""}:${e.key}`}
            role="listitem"
            onClick={() => onSelect(e)}
            style={{
              position: "absolute",
              top: (start + i) * ROW_HEIGHT,
              height: ROW_HEIGHT,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              textAlign: "left",
              overflow: "hidden",
            }}
          >
            <code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.key}</code>
            <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>{e.sizeBytes} B</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function StorageExplorer({ contractId }: { contractId: string }) {
  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState("");
  const [durability, setDurability] = useState<Durability | "all">("all");
  const [asOf, setAsOf] = useState("");
  const [selected, setSelected] = useState<StorageEntry | null>(null);

  const diffs = useQuery({ queryKey: ["state-diffs", contractId], queryFn: () => api.stateDiffs(contractId) });
  const ttl = useQuery({ queryKey: ["contract-ttl", contractId], queryFn: () => api.contractTTL(contractId) });
  const currentLedger = ttl.data?.current_ledger ?? null;
  const asOfLedger = asOf === "" ? undefined : Number(asOf);

  const entries = useMemo(() => buildSnapshot(diffs.data ?? [], asOfLedger), [diffs.data, asOfLedger]);
  const filtered = useMemo(() => filterEntries(entries, query, prefix), [entries, query, prefix]);

  if (diffs.isLoading) return <p style={{ color: "var(--muted)" }}>Loading storage…</p>;
  if (diffs.isError) return <p role="alert">Failed to load storage.</p>;

  return (
    <section aria-label="Contract storage" data-testid="storage-explorer">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <input
          aria-label="Search key"
          placeholder="Search key"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          aria-label="Key prefix"
          placeholder="Key prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <select
          aria-label="Durability"
          value={durability}
          onChange={(e) => setDurability(e.target.value as Durability | "all")}
        >
          <option value="all">All durabilities</option>
          {DURABILITIES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          aria-label="View as of ledger"
          placeholder="As of ledger N"
          inputMode="numeric"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value.replace(/\D/g, ""))}
        />
      </div>
      {DURABILITIES.filter((d) => durability === "all" || durability === d).map((d) => {
        const group = filtered.filter((e) => e.durability === d);
        return (
          <div key={d} data-testid={`storage-group-${d}`} style={{ marginBottom: 16 }}>
            <h3 style={{ textTransform: "capitalize" }}>
              {d} <span style={{ color: "var(--muted)", fontSize: 13 }}>({group.length})</span>
            </h3>
            {group.length ? (
              <VirtualList entries={group} onSelect={setSelected} />
            ) : (
              <p style={{ color: "var(--muted)" }}>No entries.</p>
            )}
          </div>
        );
      })}
      {selected && <EntryDetail entry={selected} currentLedger={currentLedger} />}
    </section>
  );
}
