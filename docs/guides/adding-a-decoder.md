# Adding a New Decoder

> **Audience:** Node.js developers with no prior knowledge of this project.
> **Goal:** By the end of this guide you will be able to write a working decoder
> that converts raw Soroban contract events into human-readable descriptions.

---

## Quick Start

If you learn best by doing, skip straight to the
[complete worked example](#6-complete-worked-example--lottery-draw-decoder)
where we build a Lottery protocol decoder from scratch — config constant,
description function, pipeline wiring, tests, ABI file, and PR — step by step.

**What you'll build:** A decoder that turns raw on-chain events like
`ticket_purchased(GAAAAA…AAAA, 100000000, [7, 14, 21])` into human-readable
descriptions like *"GAAAAA…AAAA bought lottery ticket (numbers: 7, 14, 21) for
 draw #12345 at ledger #98765"*.

---

## Prerequisites

Before you start, make sure you have:

- **Node.js 20+** installed (`node --version`)
- The project cloned and dependencies installed (`npm install` at the repo root,
  then `cd indexer && npm install`)
- A basic understanding of JavaScript ES modules (`import`/`export`)
- Familiarity with Stellar addresses (56-char `G...` strings) and Soroban
  contract events (topics + data payload)

You do **not** need to understand Rust, Soroban SDK internals, or XDR encoding.
All event values are pre-decoded to plain JS values before your decoder runs.

---

## Table of Contents

1. [How `decoder.js` Processes Events](#1-how-decoderjs-processes-events)
2. [How Protocol-Specific Decoders Work](#2-how-protocol-specific-decoders-work)
3. [Writing a Description Function](#3-writing-a-description-function)
4. [Testing Your Decoder](#4-testing-your-decoder)
5. [Submitting the ABI](#5-submitting-the-abi)
6. [Complete Worked Example — Lottery Draw Decoder](#6-complete-worked-example--lottery-draw-decoder)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. How `decoder.js` Processes Events

The indexer receives raw events from the Soroban RPC and routes them through
`indexer/src/decoder.js:decode()`. The decoding pipeline follows a strict
chain-of-responsibility pattern:

```
Raw Soroban RPC event
        │
        ▼
┌─────────────────────────────────────┐
│  1. Classic operation?              │
│     (Horizon payment, path_payment) │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  2. Native XLM SAC?                 │
│     (mint = wrap, burn = unwrap)    │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  3. Protocol-specific decoder?      │
│     StellarSwap DEX, Blend lending  │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  4. Registered ABI lookup           │
│     → buildDescription()            │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  5. RWA decoder?                    │
│     (Real-world asset events)       │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  6. Vault decoder?                  │
│     (lending/strategy vaults)       │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  7. Heuristic fallback              │
│     (generic description + type     │
│      guessing when no ABI matches)  │
└─────────────────────────────────────┘
        │
        ▼
    Decoded event object
```

### Key implementation detail

The core `decode()` function in `indexer/src/decoder.js` follows this flow:

```js
export async function decode(ev, { currentAbi = false } = {}) {
  // 1. Classic Stellar operations (Horizon)
  if (ev.contractId == null && ev.operation) {
    return decodeClassicOperation(ev);
  }

  // 2. Convert raw XDR topics and data to native JS values
  const topics = ev.topic.map((t) => scValToNative(t));
  const data = scValToNative(ev.value);
  const fnName = String(topics[0]); // First topic = function name

  // 3. Protocol-specific decoders (added here)
  if (NATIVE_SAC_IDS.has(contractId)) { /* native XLM wrap/unwrap */ }
  if (STELLARSWAP_CONTRACT_ID && contractId === STELLARSWAP_CONTRACT_ID) { /* DEX */ }
  if (BLEND_CONTRACT_ID && contractId === BLEND_CONTRACT_ID) { /* lending */ }

  // 4. ABI-based decoding
  const meta = await db.getContractMetaByLedger(contractId, ev.ledger);
  const fnAbi = meta?.functions?.find((f) => f.name === fnName);

  // 5. Build the description
  if (fnAbi) {
    description = buildDescription(fnName, topics.slice(1), data, contractLabel);
  } else {
    description = genericDescription(fnName, topics.slice(1), data, contractLabel);
  }

  // 6. Post-processing
  //    - TTL extension detection
  //    - ZK host function detection
  //    - Role assignment extraction
  //    - Slippage computation (DEX swaps)
  //    - Resource cost extraction

  return decoded;
}
```

### Event shape

Every Soroban RPC event has this structure:

```js
{
  contractId: "C…",       // 56-char Soroban contract ID
  topic: [ScVal, …],      // Array of ScVal — topic[0] is the function name (Symbol)
  value: ScVal,           // The event payload (any ScVal type)
  ledger: 123456,         // Ledger sequence number
  txHash: "a1b2c3…",     // Transaction hash
  txResultCode: "…",      // Optional: transaction result code
  txMeta: {…},            // Optional: transaction metadata (gas costs, etc.)
}
```

After `scValToNative()` conversion, topics and data become plain JS values:

```js
{
  contract_id: "C…",
  function: "transfer",     // String from topics[0]
  raw_topics: ["transfer", "GAAAA…AAAA", "GBBBB…BBBB", "USDC"],
  //            ^function   ^from           ^to          ^token
  raw_data: '{"amount": "5000000000"}',   // JSON-stringified data
  ledger: 123456,
  tx_hash: "a1b2c3…",
}
```

---

## 2. How Protocol-Specific Decoders Work

Every protocol-specific decoder in this project follows the same pattern:
a single description function added directly inside `indexer/src/decoder.js`,
then wired into the `decode()` pipeline with a contract-ID check.

### The pattern (used by StellarSwap, Blend, and native XLM SAC)

```js
// 1. Config constant at the top of decoder.js
const MY_CONTRACT_ID = config.MY_CONTRACT_ID || null;

// 2. Description function (anywhere in decoder.js)
export function myProtocolDescription(fnName, args, data, ledger) {
  switch (fnName) {
    case 'my_event':
      const [param1, param2] = args;
      return `${fmt(param1)} did something with ${param2} at ledger #${ledger}`;
    default:
      return null; // Let the pipeline fall through
  }
}

// 3. Contract-ID check in decode() — inserted after the Blend block
if (MY_CONTRACT_ID && contractId === MY_CONTRACT_ID) {
  const description = myProtocolDescription(fnName, topics.slice(1), data, ev.ledger);
  if (description) {
    return {
      contract_id: contractId,
      function: fnName,
      ledger: ev.ledger,
      tx_hash: ev.txHash,
      description,
      raw_topics: topics.map((t) => stripNul(t)),
      raw_data: safeStringify(data),
      ...extractGasCosts(ev),
    };
  }
}
```

There are **no** separate plugin files, directory structures, or `matches()`
functions. The contract-ID `if` block *is* the matcher.

### Pattern summary

| What | Where | Example |
|------|-------|---------|
| Config constant | Top of `decoder.js` | `const BLEND_CONTRACT_ID = config.BLEND_CONTRACT_ID \|\| null;` |
| Description function | Anywhere in `decoder.js` | `export function blendDescription(…)` |
| Pipeline wiring | Inside `decode()` in `decoder.js` | `if (BLEND_CONTRACT_ID && contractId === BLEND_CONTRACT_ID) { … }` |

### Deciding what to match on

| Strategy | When to use | Example |
|----------|-------------|---------|
| **Contract ID** (most common) | Your protocol is deployed at a known address | `contractId === MY_CONTRACT_ID` |
| **Static set of IDs** | Multiple known instances | `NATIVE_SAC_IDS.has(contractId)` |
| **Function name** | The event function name is unique enough | Check `fnName` inside the description function |
| **Contract metadata** | Recognised by registered ABI fields | Check inside `decode()` after fetching `meta` |

> **Important:** The contract-ID check runs on **every** event. Keep it fast.
> Avoid database queries or network calls there.

---

## 3. Writing a Description Function

This is where the actual human-readable event description is built. The function
receives already-decoded JS values — you don't need to handle ScVal XDR directly.

### Function signature

```js
/**
 * @param {string} fnName - Event function name (from topics[0])
 * @param {Array}  args   - Decoded arguments (topics[1..])
 * @param {any}    data   - Decoded event payload (the ScVal value)
 * @param {number} ledger - Ledger sequence number
 * @returns {string|null}  Human-readable description, or null if unhandled
 */
export function myDescription(fnName, args, data, ledger) {
  // …
}
```

### Argument conventions

Soroban event arguments appear in two places:

1. **Topics** (`topics[1..]`) — typically the structured, typed arguments
   defined in the contract's event spec
2. **Data** (`data`) — the event payload, which can be any ScVal type

Worked example from the actual codebase (`vaultDescription`):

```js
function vaultDescription(fn, args, data, contractName) {
  // Destructure positional arguments from the topics array
  const [admin, to, amount, shares] = args;
  // Data is the ScVal value, often used as fallback
  const amt = amount ?? data;
  // Build the description
  return `Supplied ${amt} to ${fmt(to)} on ${contractName}`;
}
```

### Description formatting helpers

These helpers exist in `decoder.js` but are **internal** (not exported):

| Helper | Purpose |
|--------|---------|
| `fmt(addr)` | Truncates a 56-char Stellar address to `"GAAAAA…AAAA"` (6+4 chars) |
| `fmtXlm(amount)` | Converts stroops (1 XLM = 10,000,000 stroops) to display value |
| `safeStringify(value)` | JSON.stringify that handles BigInt and strips NUL bytes |
| `stripNul(str)` | Removes NUL characters that PostgreSQL rejects |

Because these are **internal** to `decoder.js`, functions added inside that
file can use them directly by name. If you extract decoder logic to a separate
module (like `rwaDecoder.js`), re-implement the helpers locally:

```js
/** Truncate a Stellar address to "GAAAAA…AAAA" (6+4 chars). */
function fmt(addr) {
  if (typeof addr !== "string" || addr.length < 10) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Convert stroops to a display-friendly XLM value. */
function fmtXlm(amount) {
  if (amount == null) return "?";
  const n = Number(amount);
  return isNaN(n)
    ? String(amount)
    : (n / 1e7).toLocaleString(undefined, { maximumFractionDigits: 7 });
}
```

### Return value

Return a **plain string** (the human-readable description), or `null` if your
decoder doesn't handle this particular function name:

```js
export function myDescription(fnName, args, data, ledger) {
  switch (fnName) {
    case "deposit":
      return `${fmt(args[0])} deposited ${fmtXlm(args[1])} XLM`;
    case "withdraw":
      return `${fmt(args[0])} withdrew ${fmtXlm(args[1])} XLM`;
    default:
      return null; // Don't handle this — let fallback take over
  }
}
```

### Returning `null` vs. throwing

- **Return `null`** when the function name is not one your decoder recognises.
  This lets the pipeline fall through to the next decoder or the generic handler.
- **Never throw** in a decoder. Wrap risky operations in try/catch and return
  `null` on failure. An uncaught exception will crash the indexer.

---

## 4. Testing Your Decoder

### Test framework

The project uses Node's built-in test runner (`node:test`) with strict assertions
(`node:assert/strict`). Tests are located in:

- `indexer/test/` — protocol-specific decoder tests
- `indexer/tests/` — core decoder tests

### Test structure

Each test file follows this pattern:

```js
// indexer/test/myProtocol.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the function(s) you want to test
const { myDescription } = await import("../src/decoder.js");

describe("myProtocol — deposit", () => {
  it("produces a human-readable description for a deposit event", () => {
    const USER = "G" + "A".repeat(55);
    const desc = myDescription("deposit", [USER, 1000000000n], null, 123456);

    // 1. Check the description is a non-empty string
    assert.equal(typeof desc, "string");
    assert.ok(desc.length > 0);

    // 2. Check key elements are present
    assert.ok(desc.includes("deposited"), `missing verb in "${desc}"`);
    assert.ok(desc.includes("ledger"), `missing ledger in "${desc}"`);
  });

  it("returns null for an unrecognised function name", () => {
    assert.equal(myDescription("unknown_fn", [], null, 0), null);
  });
});
```

### Testing conventions used in this project

From existing tests (`test/decoder.stellarswap.test.js`, `test/decoder.blend.test.js`,
`test/decoder.allowance.test.js`):

| Convention | Example |
|------------|---------|
| **Address fixtures** | `const FROM = "G" + "A".repeat(55)` and its short form `FROM_SHORT` |
| **Amounts as BigInt** | `5000000000n` (stroops, not display units) |
| **Check for key phrases** | `assert.ok(desc.includes("swapped"))` |
| **Check for missing phrases** | `assert.ok(!desc.includes("slippage"))` |
| **Test the null case** | `assert.equal(myDecode("unknown_fn", …), null)` |
| **Test edge cases** | Zero amounts, missing optional fields, boundary values |

### Running tests

```bash
# Run all decoder tests
node --test tests/decoder.test.js

# Run a specific protocol test
node --test test/decoder.stellarswap.test.js

# Run with coverage
npx c8 --reporter=text node --test tests/decoder.test.js
```

---

## 5. Submitting the ABI

### What is an ABI file?

An ABI (Application Binary Interface) file describes the functions a contract
emits and their parameter types. The indexer uses these to build richer
descriptions when it encounters events from known contracts.

ABI files live in `indexer/src/abis/` and use this JSON format:

```json
{
  "contractId": "C…",
  "name": "MyProtocol",
  "description": "A short description of the protocol",
  "links": {
    "homepage": "https://myprotocol.io",
    "docs": "https://docs.myprotocol.io"
  },
  "functions": [
    {
      "name": "my_event",
      "template": "{from} performed {action} with {amount} {token}",
      "params": [
        { "name": "from", "type": "Address" },
        { "name": "action", "type": "Symbol" },
        { "name": "amount", "type": "i128" },
        { "name": "token", "type": "Address" }
      ]
    }
  ]
}
```

### When to submit an ABI

Submit an ABI file when:

- Your decoder handles events from a **known, well-defined contract**
- The contract's function signatures are **stable** (not changing rapidly)
- You want the indexer to produce **rich, contextual descriptions** beyond
  what the generic `buildDescription()` can produce

You do **not** need an ABI file when:

- Your decoder handles events based on **contract ID alone** (like StellarSwap)
- Your decoder has **hard-coded description logic** (like native XLM SAC)
- The contract is **ephemeral or user-deployed** (like arbitrary SAC tokens)

### How ABI files are seeded

On startup, `indexer/src/abiSeeder.js` reads all ABI files from `indexer/src/abis/`
and registers them in the `contracts` table. This happens before the indexer
begins processing events, so decoders can use them immediately.

```js
// abiSeeder.js registration logic
BUILTIN_ABIS = [
  { file: "stellarswap.json", configKey: "STELLARSWAP_CONTRACT_ID" },
  { file: "blend.json", configKey: "BLEND_CONTRACT_ID" },
];
```

A seeding is skipped if the corresponding config key is not set (e.g.
`STELLARSWAP_CONTRACT_ID` is empty). The `contractId` field in the ABI JSON
is a placeholder — the real deployed contract ID comes from the environment.

### How to add a new ABI file

1. Create your ABI JSON in `indexer/src/abis/`:

```bash
touch indexer/src/abis/myprotocol.json
```

2. Add it to `indexer/src/abiSeeder.js`:

```js
const BUILTIN_ABIS = [
  { file: "stellarswap.json", configKey: "STELLARSWAP_CONTRACT_ID" },
  { file: "blend.json", configKey: "BLEND_CONTRACT_ID" },
  { file: "myprotocol.json", configKey: "MYPROTOCOL_CONTRACT_ID" },
];
```

3. Add the config key to your `.env`:

```env
MYPROTOCOL_CONTRACT_ID=C…  # The deployed contract ID
```

### Submitting to the verified-ABIs repository

For community-contributed ABIs that are not bundled with the indexer, submit
them to the [verified-abis](https://github.com/Soroban-Smart-Block-Explorer/verified-abis)
repository. The indexer syncs from there via `githubAbiSync.js` on a cron
schedule.

---

## 6. Complete Worked Example — Lottery Draw Decoder

This section walks through adding a decoder for a fictional **Lottery** contract
that emits three event types:

| Event | Topics | Data | Description |
|-------|--------|------|-------------|
| `ticket_purchased` | `[player, amount, numbers]` | `{draw_id: u64}` | `"GAAAAA…AAAA bought lottery ticket (numbers: 7, 14, 21, 28, 35, 42) for draw #9876"` |
| `draw_executed` | `[]` | `{draw_id, winning_numbers, prize_pool, winner}` | `"Draw #9876 executed — winning numbers: 7, 14, 21, 28, 35, 42 — prize pool: 50000 XLM"` |
| `prize_claimed` | `[winner, draw_id]` | `{amount: i128}` | `"GAAAAA…AAAA claimed 10000 XLM for draw #9876"` |

### Step 1: Add the config constant

In `indexer/src/decoder.js`, add near the other config constants:

```js
const LOTTERY_CONTRACT_ID = config.LOTTERY_CONTRACT_ID || null;
```

### Step 2: Create the description function

In `indexer/src/decoder.js`, add after the Blend block:

```js
// ── Lottery protocol ──────────────────────────────────────────────────────

/**
 * "GAAAAA…AAAA bought lottery ticket (numbers: 7, 14, 21, 28, 35, 42) for draw #9876"
 * "Draw #9876 executed — winning numbers: 7, 14, 21, 28, 35, 42 — prize pool: 50000 XLM"
 * "GAAAAA…AAAA claimed 10000 XLM for draw #9876"
 */
export function lotteryDescription(fnName, args, data, ledger) {
  const ledgerSuffix = ledger != null ? ` at ledger #${ledger}` : "";

  switch (fnName) {
    case "ticket_purchased": {
      // args: [player, amount, numbers]
      // data: { draw_id }
      const [player, , numbers] = args;
      const drawId =
        typeof data === "object" && data !== null ? data.draw_id : "?";
      const numberList = Array.isArray(numbers)
        ? numbers.join(", ")
        : String(numbers ?? "?");
      return `${fmt(player)} bought lottery ticket (numbers: ${numberList}) for draw #${drawId}${ledgerSuffix}`;
    }

    case "draw_executed": {
      // args: [] (no topics beyond function name)
      // data: { draw_id, winning_numbers, prize_pool, winner }
      const drawId = data?.draw_id ?? "?";
      const winningNumbers = Array.isArray(data?.winning_numbers)
        ? data.winning_numbers.join(", ")
        : "?";
      const prizePool =
        data?.prize_pool != null ? fmtXlm(data.prize_pool) : "?";
      return `Draw #${drawId} executed — winning numbers: ${winningNumbers} — prize pool: ${prizePool} XLM`;
    }

    case "prize_claimed": {
      // args: [winner, draw_id]
      // data: { amount }
      const [winner, drawId] = args;
      const amount = data?.amount != null ? fmtXlm(data.amount) : "?";
      return `${fmt(winner)} claimed ${amount} XLM for draw #${drawId}${ledgerSuffix}`;
    }

    default:
      return null;
  }
}
```

### Step 3: Wire it into the decode pipeline

In `indexer/src/decoder.js`, inside the `decode()` function, add after the
Blend check:

```js
// Lottery protocol
if (LOTTERY_CONTRACT_ID && contractId === LOTTERY_CONTRACT_ID) {
  const description = lotteryDescription(fnName, topics.slice(1), data, ev.ledger);
  if (description) {
    return {
      contract_id: contractId,
      function: fnName,
      ledger: ev.ledger,
      tx_hash: ev.txHash,
      description,
      raw_topics: topics.map((t) => stripNul(t)),
      raw_data: safeStringify(data),
      ...extractGasCosts(ev),
    };
  }
}
```

### Step 4: Write the tests

Create `indexer/test/decoder.lottery.test.js`:

```js
/**
 * Unit tests: decoder.js Lottery protocol handler (issue #XXX).
 *
 * Event shapes:
 *   ticket_purchased(player, amount, numbers) → { draw_id }
 *   draw_executed() → { draw_id, winning_numbers, prize_pool, winner }
 *   prize_claimed(winner, draw_id) → { amount }
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { lotteryDescription } = await import("../src/decoder.js");

const PLAYER = "G" + "A".repeat(55);
const PLAYER_SHORT = "GAAAAA…AAAA";
const LEDGER = 98765;

describe("decoder — Lottery ticket_purchased", () => {
  it("formats a ticket purchase with numbers and draw ID", () => {
    const desc = lotteryDescription(
      "ticket_purchased",
      [PLAYER, 100000000n, [7, 14, 21, 28, 35, 42]],
      { draw_id: 12345n },
      LEDGER,
    );

    assert.ok(desc.includes(PLAYER_SHORT), `missing player in "${desc}"`);
    assert.ok(desc.includes("bought lottery ticket"), `missing verb in "${desc}"`);
    assert.ok(desc.includes("7, 14, 21, 28, 35, 42"), `missing numbers in "${desc}"`);
    assert.ok(desc.includes("draw #12345"), `missing draw ID in "${desc}"`);
    assert.ok(desc.includes(`ledger #${LEDGER}`), `missing ledger in "${desc}"`);
  });

  it("handles a single-number ticket", () => {
    const desc = lotteryDescription(
      "ticket_purchased",
      [PLAYER, 100000000n, [42]],
      { draw_id: 1n },
      LEDGER,
    );
    assert.ok(desc.includes("42"), `missing number in "${desc}"`);
  });

  it("gracefully handles missing data", () => {
    const desc = lotteryDescription(
      "ticket_purchased",
      [PLAYER, 100000000n, []],
      null,
      LEDGER,
    );
    assert.ok(desc.includes("?"), `expected fallback in "${desc}"`);
  });
});

describe("decoder — Lottery draw_executed", () => {
  it("formats a draw with winning numbers and prize pool", () => {
    const data = {
      draw_id: 12345n,
      winning_numbers: [7, 14, 21, 28, 35, 42],
      prize_pool: 500000000000n,
      winner: PLAYER,
    };

    const desc = lotteryDescription("draw_executed", [], data, LEDGER);

    assert.ok(desc.includes("Draw #12345 executed"), `missing draw header in "${desc}"`);
    assert.ok(desc.includes("winning numbers: 7, 14, 21, 28, 35, 42"), `missing numbers in "${desc}"`);
    assert.ok(desc.includes("50000 XLM"), `missing prize pool in "${desc}"`);
  });

  it("handles missing prize pool gracefully", () => {
    const data = { draw_id: 1n, winning_numbers: [], prize_pool: null, winner: null };
    const desc = lotteryDescription("draw_executed", [], data, LEDGER);
    assert.ok(desc.includes("?"), `expected fallback in "${desc}"`);
  });
});

describe("decoder — Lottery prize_claimed", () => {
  it("formats a prize claim with amount and draw ID", () => {
    const desc = lotteryDescription(
      "prize_claimed",
      [PLAYER, 12345n],
      { amount: 100000000000n },
      LEDGER,
    );

    assert.ok(desc.includes(PLAYER_SHORT), `missing winner in "${desc}"`);
    assert.ok(desc.includes("claimed"), `missing verb in "${desc}"`);
    assert.ok(desc.includes("10000 XLM"), `missing amount in "${desc}"`);
    assert.ok(desc.includes("draw #12345"), `missing draw ID in "${desc}"`);
  });
});

describe("decoder — Lottery unrecognised functions", () => {
  it("returns null for an unknown function name", () => {
    assert.equal(lotteryDescription("unknown_event", [], null, 0), null);
  });

  it("returns null for set_admin", () => {
    assert.equal(lotteryDescription("set_admin", [PLAYER], null, LEDGER), null);
  });
});
```

### Step 5: Run the tests

```bash
# Run only the lottery decoder tests
node --test test/decoder.lottery.test.js

# Expected output:
# ▶ decoder — Lottery ticket_purchased
#   ✔ formats a ticket purchase with numbers and draw ID
#   ✔ handles a single-number ticket
#   ✔ gracefully handles missing data
# ▶ decoder — Lottery draw_executed
#   ✔ formats a draw with winning numbers and prize pool
#   ✔ handles missing prize pool gracefully
# ▶ decoder — Lottery prize_claimed
#   ✔ formats a prize claim with amount and draw ID
# ▶ decoder — Lottery unrecognised functions
#   ✔ returns null for an unknown function name
#   ✔ returns null for set_admin
# -------------------------------------------------------------------------
# pass 7
# fail 0
```

### Step 6: Create the ABI file

Create `indexer/src/abis/lottery.json`:

```json
{
  "contractId": "CLOTTERYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADUMMY",
  "name": "Lottery",
  "description": "Decentralised lottery protocol on Soroban",
  "links": {
    "homepage": "https://lottery.example.com"
  },
  "functions": [
    {
      "name": "ticket_purchased",
      "template": "{player} bought lottery ticket (numbers: {numbers}) for draw #{draw_id}",
      "params": [
        { "name": "player", "type": "Address" },
        { "name": "amount", "type": "i128" },
        { "name": "numbers", "type": "Vec<i32>" },
        { "name": "draw_id", "type": "u64" }
      ]
    },
    {
      "name": "draw_executed",
      "template": "Draw #{draw_id} executed — winning numbers: {winning_numbers} — prize pool: {prize_pool}",
      "params": [
        { "name": "draw_id", "type": "u64" },
        { "name": "winning_numbers", "type": "Vec<i32>" },
        { "name": "prize_pool", "type": "i128" },
        { "name": "winner", "type": "Address" }
      ]
    },
    {
      "name": "prize_claimed",
      "template": "{winner} claimed {amount} for draw #{draw_id}",
      "params": [
        { "name": "winner", "type": "Address" },
        { "name": "draw_id", "type": "u64" },
        { "name": "amount", "type": "i128" }
      ]
    }
  ]
}
```

### Step 7: Submit a PR

1. Commit your changes:

```bash
git add indexer/src/decoder.js indexer/test/decoder.lottery.test.js indexer/src/abis/lottery.json
git commit -m "feat(decoder): add Lottery protocol decoder
- Add lotteryDescription() for ticket_purchased, draw_executed, prize_claimed events
- Add comprehensive unit tests verifying human-readable output formats
- Add Lottery ABI JSON file for community discovery
- Wire decoder into the decode pipeline via LOTTERY_CONTRACT_ID config

Closes #XXX"
```

2. Push and open a pull request targeting the upstream repo:

```bash
gh pr create --repo Soroban-Smart-Block-Explorer/Soroban-Smart-Block \
  --base main --head DammyAji:docs/592-decoder-contributor-guide \
  --title "docs: decoder architecture explainer and contributor guide (#592)" \
  --body "Closes #592"
```

---

## Summary

| Step | What to do | Where |
|------|------------|-------|
| 1 | Add a config constant | Top of `indexer/src/decoder.js` |
| 2 | Write a `description()` function | `indexer/src/decoder.js` |
| 3 | Wire it into the `decode()` pipeline | `indexer/src/decoder.js` |
| 4 | Add unit tests | `indexer/test/` |
| 5 | (Optional) Create an ABI file | `indexer/src/abis/` |
| 6 | Register the ABI in `abiSeeder.js` | `indexer/src/abiSeeder.js` |
| 7 | Add config key | `.env` and `config.js` |
| 8 | Run tests and submit PR | — |

### Key files reference

| File | Purpose |
|------|---------|
| `indexer/src/decoder.js` | Main decoder — all description functions live here |
| `indexer/src/decoderValidator.js` | Schema validation and sanitisation for decoded events |
| `indexer/src/scval.js` | ScVal XDR → native JS value conversion |
| `indexer/src/heuristicParser.js` | Fallback type guessing when no ABI is available |
| `indexer/src/rwaDecoder.js` | Example of an external standalone decoder module |
| `indexer/src/abis/` | Built-in ABI definitions |
| `indexer/src/abiSeeder.js` | Seeds built-in ABIs into the contracts table on startup |
| `indexer/test/decoder.stellarswap.test.js` | Test example: StellarSwap DEX decoder |
| `indexer/test/decoder.blend.test.js` | Test example: Blend lending decoder |
| `indexer/test/decoder.allowance.test.js` | Test example: SEP-41 allowance + NFT decoders |
| `indexer/tests/decoder.test.js` | Core decoder tests (ScVal types, edge cases) |

---

## 7. Troubleshooting

### Common issues and fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `SyntaxError: Unexpected token` in decoder.js | Missing `//` before a comment line | Prefix all comment text with `//` — bare English in JS is a syntax error |
| `Cannot find module` when importing your test | Import path typo | Check that `../src/decoder.js` is correct relative to `indexer/test/` |
| Test says `missing verb in "..."` | Your description string doesn't contain the expected word | Check your `switch` case returns the right format |
| `undefined` appears in the description | An argument is `undefined` (topics array too short, or data missing) | Use defensive defaults: `const val = args[0] ?? "?"` |
| Description shows raw BigInt like `5000000000n` | You forgot to use `fmtXlm()` on a stroop amount | Wrap stroop values with `fmtXlm(amount)` for display-friendly output |
| Decoder works in tests but not in production | Config key not set in `.env` | Add `MY_CONTRACT_ID=C...` to your `.env` file |
| `null` returned for a function you expected to handle | The `fnName` string doesn't match your `case` labels | Add `console.log(fnName)` temporarily to see what's arriving, or check the event's topic[0] |

### Getting help

- Open a [GitHub Discussion](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/discussions) with the `decoder` tag
- Ask in the **#dev** channel on the project Discord
- Tag `@maintainers` in your PR for a review
