# Rate-limit tuning methodology

The per-tier rate limits (`unauthenticated` / `free` / `pro` / `enterprise`),
defined in `indexer/src/rateLimit/endpointGroups.js`, were set from initial
design-phase estimates rather than observed production traffic. This
document defines the methodology for validating and adjusting them once
production traffic data is available; it does not itself change the
constants, since that requires real traffic data this repository does not
have access to.

## Data to collect

- Per-tier request rate distribution (p50/p95/p99 requests-per-minute per
  client), sourced from the `CL.THROTTLE` Redis counters or, when the
  in-process fallback is active, the fallback bucket stats logged by
  `indexer/src/rateLimit/tokenBucket.js`.
- 429 (rate-limited) response counts per tier and endpoint group, to
  identify limits that are too tight for legitimate usage.
- Traffic from known abusive/malicious sources (e.g. clients hitting the
  limit repeatedly in short bursts), to confirm limits still block that
  pattern after any increase.

## Review cadence

Review the above metrics monthly for the first quarter after a tier's
limits change, then quarterly, using at least two weeks of trailing data
each time so weekday/weekend traffic patterns are represented.

## Adjustment criteria

- Raise a tier's `rpm`/`burst` only when its legitimate p99 traffic sits
  above ~80% of the current burst, and 429 responses to non-abusive
  clients are observed.
- Lower a tier's limits only when observed legitimate traffic sits well
  below the current sustained rate, and no legitimate use case would be
  throttled by the reduction.
- Any change to `indexer/src/rateLimit/endpointGroups.js` must be
  accompanied by the traffic analysis (metrics above, with source and date
  range) that justified it, recorded in the PR description.

## Status

No production traffic analysis has been performed yet. The current
constants remain initial estimates until the first review cycle above is
completed against real traffic.
