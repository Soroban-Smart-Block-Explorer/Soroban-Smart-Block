/**
 * useEventStream
 * Connects to the backend WebSocket and calls onEvent for each incoming event.
 */
import { useEffect } from "react";
import type { DecodedEvent } from "../api";

export function useEventStream(onEvent: (ev: DecodedEvent) => void) {
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}`);

    ws.onmessage = (msg) => {
      try {
        const payload = JSON.parse(msg.data);
        if (payload.type === "event") {
          // Legacy: single event (for backwards compatibility)
          onEvent(payload.data as DecodedEvent);
        } else if (payload.type === "events_batch") {
          // Batched events: array of events, unpack and dispatch each
          const events = payload.data as DecodedEvent[];
          if (Array.isArray(events)) {
            for (const event of events) {
              onEvent(event);
            }
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onerror = (err) => console.error("[ws] error", err);

    return () => ws.close();
  }, []);
}
