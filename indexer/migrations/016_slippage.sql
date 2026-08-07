-- Migration 016: add slippage_bps column for DEX swap events (issue #554)
--
-- Slippage is computed at decode time as |amount_out - min_amount_out| / min_amount_out,
-- expressed in basis points (1% = 100 bps), and stored alongside the event so
-- swap events can be filtered/sorted by slippage without re-parsing raw_data.
-- NULL when the swap's min_amount_out is unavailable (slippage cannot be computed).

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS slippage_bps INT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_events_slippage_bps ON events (slippage_bps) WHERE slippage_bps IS NOT NULL;
