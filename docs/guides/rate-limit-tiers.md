# API Rate-Limit Tiers and Upgrade Path

> **Audience:** External API consumers building on the Soroban Smart Block
> Explorer API.
> **Goal:** Understand each rate-limit tier, what limits apply at each level,
> and how to upgrade your API key from one tier to the next.

---

## Table of Contents

1. [Tier Overview](#1-tier-overview)
2. [Tier Limits at a Glance](#2-tier-limits-at-a-glance)
3. [How Tier Detection Works](#3-how-tier-detection-works)
4. [Upgrading Your Tier](#4-upgrading-your-tier)
5. [Monitoring Your Usage](#5-monitoring-your-usage)
6. [Frequently Asked Questions](#6-frequently-asked-questions)

---

## 1. Tier Overview

The Soroban Smart Block Explorer API uses a four-tier rate-limiting system to
ensure fair access and reliable service for all consumers. Your tier determines
your sustained request rate, burst capacity, concurrent connection limits, and
daily request quota.

| Tier | Description | Who it's for |
|------|-------------|--------------|
| **Unauthenticated** | Default for requests with no API key | Quick experiments, prototyping |
| **Free** | Verified API key with generous limits | hobby projects, personal tools |
| **Pro** | High-throughput tier via paid subscription | Production apps, commercial integrations |
| **Enterprise** | Unlimited or custom-configured limits | High-volume businesses, platform integrations |

---

## 2. Tier Limits at a Glance

### Sustained Requests per Minute (RPM)

Limits vary by endpoint group. The table below shows the default sustained
requests-per-minute for each tier.

| Endpoint Group | Unauthenticated | Free | Pro | Enterprise |
|----------------|:-:|:-:|:-:|:-:|
| **Events** (`/api/events`) | 60 | 1,000 | 10,000 | Custom |
| **Search** (`/api/search`, `/api/wallet`) | 30 | 500 | 5,000 | Custom |
| **Contracts** (`/api/contracts`) | 10 | 100 | 1,000 | Custom |
| **Simulate** (`/api/simulate`) | 5 | 50 | 500 | Custom |
| **WebSocket** (`/ws`) | 3 | 30 | 300 | Custom |
| **Default** (all other endpoints) | 60 | 1,000 | 10,000 | Custom |

### Burst Limits

Burst tokens allow short spikes above the sustained RPM. Each tier gets a
one-time burst allocation that refills at the sustained rate.

| Tier | Burst Tokens |
|------|:------------:|
| Unauthenticated | 10 |
| Free | 50 |
| Pro | 200 |
| Enterprise | 500 |

### Concurrent Connections

Maximum simultaneous in-flight requests (or WebSocket connections).

| Tier | HTTP Requests | WebSocket Connections |
|------|:------------:|:---------------------:|
| Unauthenticated | 5 | 1 |
| Free | 20 | 5 |
| Pro | 100 | 25 |
| Enterprise | 200 | 50 |

### Daily Request Limits

| Tier | Daily Limit |
|------|:-----------:|
| Unauthenticated | 60 |
| Free | 1,000 |
| Pro | 10,000 |
| Enterprise | 100,000 |

### Token Bucket TTL

The token bucket (rate-limit window) resets over different time horizons per
tier:

| Tier | Bucket TTL |
|------|:----------:|
| Unauthenticated | 1 hour |
| Free | 24 hours |
| Pro | 30 days |
| Enterprise | 30 days |

### Usage Data Retention

| Tier | Retention Period |
|------|:----------------:|
| Unauthenticated | 7 days |
| Free | 7 days |
| Pro | 90 days |
| Enterprise | 1,095 days (3 years) |

---

## 3. How Tier Detection Works

When you make a request, the API determines your tier through this chain:

1. **No `X-Api-Key` header** → You are classified as **unauthenticated**.
   Your identity is derived from a hashed version of your IP address.

2. **`X-Api-Key` header present** → The API looks up your key in the database
   by its 8-character prefix, then verifies the full key against a bcrypt hash.
   Your tier is read from the `api_keys.tier` column.

3. **Static admin key** → If your key matches the `API_KEY` environment
   variable (admin-level), you are classified as **enterprise**.

The tier is attached to the request as `req.rateContext.tier` and is used by
all downstream middleware (token bucket, concurrent limiter, GraphQL complexity
budget, abuse detector).

### Response Headers

Every API response includes rate-limit headers so you can track your position:

```
X-RateLimit-Limit: 1000          # Max RPM for your tier + endpoint group
X-RateLimit-Remaining: 847       # Remaining tokens in the current window
X-RateLimit-Reset: 1693000000    # Unix timestamp when the window resets
X-RateLimit-Tier: free           # Your resolved tier name
```

---

## 4. Upgrading Your Tier

### Unauthenticated → Free

**Self-service. No credit card required.**

1. Visit the [API key creation page](/api/auth/keys) (or the equivalent
   endpoint in the dashboard).
2. Enter a name for your key (e.g., `"my-dapp"`) and your email address.
3. You will receive an email with a verification link. **Click the link** to
   verify your key — unverified keys cannot authenticate.
4. Copy the API key from the confirmation screen.
5. Include it in all requests:
   ```bash
   curl -H "X-Api-Key: sb_xxxxxxxxxxxx..." https://api.example.com/api/events
   ```

**What changes:**
- Sustained RPM increases 10–16× across all endpoint groups
- Burst capacity increases from 10 to 50 tokens
- Concurrent HTTP connections increase from 5 to 20
- Daily limit increases from 60 to 1,000 requests
- Usage data is retained for 7 days

### Free → Pro

**Paid subscription via Stripe.**

1. Visit the [Billing page](/dashboard/billing) in your dashboard.
2. Select the **Pro** plan and click **Subscribe**.
3. Complete the Stripe checkout flow (credit card or other payment method).
4. On successful payment, Stripe sends a `customer.subscription.updated`
   webhook to the API.
5. The webhook handler automatically updates your API key's tier from `free`
   to `pro` in the database. **No manual action required** — the upgrade is
   immediate.

**What changes:**
- Sustained RPM increases 10× across all endpoint groups
- Burst capacity increases from 50 to 200 tokens
- Concurrent HTTP connections increase from 20 to 100
- WebSocket connections increase from 5 to 25
- Daily limit increases from 1,000 to 10,000 requests
- Usage data is retained for 90 days

### Pro → Enterprise

**Custom limits. Contact us.**

Enterprise tier is for high-volume integrations that need custom rate limits,
dedicated support, or SLA guarantees.

1. Contact the team at [enterprise@example.com](mailto:enterprise@example.com)
   or open a [GitHub Discussion](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/discussions)
   with the `enterprise` tag.
2. We will configure your API key with custom RPM limits, burst allocation,
   and concurrent connection caps.
3. Enterprise keys are managed via Stripe product metadata — your tier is
   updated automatically when your subscription changes.

**What changes:**
- Sustained RPM is configurable (typically unlimited for your use case)
- Burst capacity increases to 500 tokens
- Concurrent HTTP connections increase to 200
- WebSocket connections increase to 50
- Daily limit increases to 100,000 requests
- Usage data is retained for 3 years

### Downgrading or Cancelling

- **Cancelling a Pro subscription:** Stripe fires a `customer.subscription.deleted`
  webhook. The API automatically downgrades your key to the **free** tier.
  You keep your API key — no action required.
- **Enterprise to Pro:** Contact the team to adjust your configuration.

---

## 5. Monitoring Your Usage

### Check your current tier

```bash
curl -s -H "X-Api-Key: sb_xxxxxxxxxxxx..." \
  https://api.example.com/api/events?limit=1 | jq '.headers'
```

Or inspect the `X-RateLimit-Tier` response header on any request.

### Check your daily usage

Use the dashboard's **Usage** page, or query the admin API:

```bash
curl -s -H "X-Admin-Key: your-admin-key" \
  https://api.example.com/api/admin/usage?days=7
```

### Watch for 429 responses

If you receive a `429 Too Many Requests` response, you have exceeded your
rate limit. The response includes:

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 12
}
```

Wait for the number of seconds specified in `retryAfter` before retrying.
Implement exponential backoff in your client for production use.

### GraphQL Complexity Budget

GraphQL queries also consume a complexity budget based on your tier:

| Tier | Complexity Budget |
|------|:-----------------:|
| Unauthenticated | 50 |
| Free | 200 |
| Pro | 1,000 |
| Enterprise | 10,000 |

Queries that exceed the budget return a `429` with a message indicating the
query's complexity score.

---

## 6. Frequently Asked Questions

### Can I have multiple API keys?

Yes. Each key is independently tiered and tracked. Create separate keys for
different applications or environments (dev, staging, production).

### What happens if my payment fails?

If a Stripe payment fails, the subscription enters a retry period. Your tier
remains active during the grace period. If payment ultimately fails, Stripe
cancels the subscription and your key is downgraded to **free**.

### Is there a free trial for Pro?

Not currently, but the free tier provides generous limits (1,000 RPM on
events endpoints) that should cover most development and testing needs.

### How do I know which tier I'm on?

Check the `X-RateLimit-Tier` response header on any API response. You can
also view your tier in the dashboard under **API Keys**.

### Can I request a temporary limit increase?

For special events or one-time bulk operations, open a
[GitHub Discussion](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/discussions)
and describe your use case. We can temporarily adjust limits for authenticated
keys.

### Does the `RATE_LIMIT_CONFIG` environment variable affect my tier?

No. `RATE_LIMIT_CONFIG` is a server-side configuration option for operators
deploying their own instance of the indexer. As an API consumer, your tier is
determined solely by your API key's `tier` column in the database.

---

## Reference

| Config Source | Location |
|---------------|----------|
| Tier limits (sustained RPM) | `indexer/src/rateLimit/endpointGroups.js` → `GROUP_TIER_LIMITS` |
| Burst defaults | `indexer/src/rateLimit/endpointGroups.js` → `TIER_BURST_DEFAULTS` |
| Concurrent limits | `indexer/src/rateLimit/concurrentLimiter.js` → `HTTP_TIER_LIMITS`, `WS_TIER_LIMITS` |
| Daily limits | `indexer/src/auth/apiKeyAuth.js` → `DAILY_LIMIT_BY_TIER` |
| Token bucket TTLs | `indexer/src/rateLimit/constants.js` → `TTL_UNAUTH`, `TTL_FREE`, `TTL_PRO` |
| GraphQL budgets | `indexer/src/rateLimit/graphqlComplexity.js` → `TIER_COMPLEXITY_BUDGETS` |
| Stripe webhook | `indexer/src/billing/stripeWebhook.js` |
| Usage retention | `indexer/src/usage/usageTracker.js` |
