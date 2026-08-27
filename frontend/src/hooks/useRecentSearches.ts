import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "recent_searches";
const MAX_ENTRIES = 10;

export interface RecentSearch {
  query: string;
  kind: string; // SearchKind | "all"
  timestamp: number;
}

function load(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(entries: RecentSearch[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — ignore
  }
}

/** Recent search history, capped at 10 entries with LRU eviction. */
export function useRecentSearches() {
  const [recent, setRecent] = useState<RecentSearch[]>(() => load());

  useEffect(() => {
    persist(recent);
  }, [recent]);

  const add = useCallback((query: string, kind: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecent((prev) => {
      const deduped = prev.filter((e) => !(e.query === trimmed && e.kind === kind));
      return [{ query: trimmed, kind, timestamp: Date.now() }, ...deduped].slice(0, MAX_ENTRIES);
    });
  }, []);

  const remove = useCallback((query: string, kind: string) => {
    setRecent((prev) => prev.filter((e) => !(e.query === query && e.kind === kind)));
  }, []);

  const clearAll = useCallback(() => setRecent([]), []);

  return { recent, add, remove, clearAll };
}
