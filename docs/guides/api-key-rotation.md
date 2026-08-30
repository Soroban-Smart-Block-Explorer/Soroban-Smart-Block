# API Key Rotation and Grace Period Workflow

## Overview

The admin API supports **key rotation** — the ability to generate a new API key to replace an existing one while maintaining a **grace period** during which both the old and new keys remain valid. This allows integrations using the old key to migrate without immediately losing access.

This guide walks through the rotation workflow, explains the grace period, and shows how to verify a rotation completed safely.

## The Rotation Workflow

### Step 1: Initiate Rotation

Call the admin key rotation endpoint with the key ID to rotate:

```bash
curl -X POST https://explorer.example.com/api/admin/api-keys/{KEY_ID}/rotate \
  -H "x-api-key: {ADMIN_KEY}" \
  -H "Content-Type: application/json"
```

**Request:**
- **Method:** `POST`
- **Endpoint:** `/api/admin/api-keys/{KEY_ID}/rotate`
- **Auth:** Must be authenticated as an admin (via a high-privilege API key or static `API_KEY`)
- **Body:** Empty (no request parameters)

**Response (success):**

```json
{
  "key": "new_raw_key_string_here",
  "record": {
    "id": "key-id-uuid",
    "name": "My Integration Key",
    "key_prefix": "abc12345",
    "tier": "pro",
    "rate_limit": 1000,
    "daily_limit": 100000,
    "created_at": "2026-08-30T10:00:00Z",
    "updated_at": "2026-08-30T11:30:00Z"
  }
}
```

- **`key`** — The new raw API key string. **Save this immediately** — it is only returned once and cannot be retrieved later if lost.
- **`record`** — The new key's metadata (same tier, limits, and IP/endpoint restrictions as the old key)

**Important:** The key is returned in plaintext only in this response. You must store it securely immediately. If you lose it, the new key cannot be recovered from the API.

### Step 2: Understand the Grace Period

When the old key is rotated, it is marked as **revoked** but remains usable for a configurable grace period. This allows existing integrations to continue working until they can update to the new key.

**Default grace period: 60 minutes** (configurable via `KEY_ROTATION_GRACE_MINUTES` environment variable)

During the grace period:
- Requests using the **old key** are **still accepted** (HTTP 200 OK)
- Requests using the **new key** work immediately
- Once the grace period expires, the old key is **rejected** (HTTP 401 "API key revoked")

### Step 3: Update Your Integration

Within the grace period, update all code and configurations using the old key to use the new key:

```javascript
// Before
const API_KEY = "old_key_abc123...";

// After
const API_KEY = "new_key_xyz789...";
```

Test the new key to ensure it works:

```bash
curl https://explorer.example.com/api/events \
  -H "x-api-key: new_key_xyz789..." \
  -s | jq .
```

### Step 4: Monitor Rotation Completion

After the grace period expires, the old key stops working. To verify the rotation is complete:

1. **Check that the old key is rejected:**
   ```bash
   curl https://explorer.example.com/api/events \
     -H "x-api-key: old_key_abc123..." \
     -i
   # Should return: 401 Unauthorized
   # {"error": "API key revoked"}
   ```

2. **Confirm the new key works:**
   ```bash
   curl https://explorer.example.com/api/events \
     -H "x-api-key: new_key_xyz789..." \
     -i
   # Should return: 200 OK with event data
   ```

## Grace Period Configuration

The grace period is set via the `KEY_ROTATION_GRACE_MINUTES` environment variable:

```bash
# In your .env or deployment config
KEY_ROTATION_GRACE_MINUTES=60  # Default: 60 minutes

# Set to a different value (example: 4 hours = 240 minutes)
KEY_ROTATION_GRACE_MINUTES=240
```

- **If unset:** defaults to 60 minutes
- **If set to 0:** old key becomes invalid immediately upon rotation (no grace period)
- **If set to a large value:** old key remains valid for longer, giving integrations more time to migrate

### Recommendations

- **For production:** 60–240 minutes (1–4 hours) gives teams time to deploy updates
- **For internal development:** 15–30 minutes is usually sufficient
- **For critical security rotations:** Consider a shorter grace period (15 minutes) or none (0 minutes)

## What Happens During Grace Period

### Authentication behavior

When you make a request with an old, revoked key during the grace period:

```javascript
// In indexer/src/auth/apiKeyAuth.js (lines 234-240)
if (keyRecord.revoked) {
  const grace = keyRecord.rotation_grace_until ? new Date(keyRecord.rotation_grace_until) : null;
  if (!grace || grace <= new Date()) {
    return res.status(401).json({ error: "API key revoked" });
  }
  // else: within grace period — allow authentication to proceed
}
```

**Result:**
- Request proceeds normally (200 OK)
- The key is counted against rate limits
- Audit log records the request under the old key's ID
- Usage statistics are updated as usual

After the grace period:
- Request returns 401 "API key revoked"
- No rate limit check or audit logging occurs

## Audit Log Implications

Each request using a rotated key (old or new) during the grace period is logged separately:

```sql
-- Query old key requests during grace period
SELECT timestamp, key_name, status_code, endpoint, response_time_ms
FROM api_audit_log
WHERE api_key_id = 'old-key-id'
  AND timestamp >= NOW() - INTERVAL '2 hours'
ORDER BY timestamp DESC;
```

This allows you to verify:
1. When the last request using the old key came in
2. Whether all traffic has migrated to the new key
3. Which endpoints depended on the old key

## Error Handling

### Old key after grace period expires

```bash
curl https://explorer.example.com/api/events \
  -H "x-api-key: old_expired_key" \
  -i
```

**Response:**
```
HTTP/1.1 401 Unauthorized
{"error": "API key revoked"}
```

**Action:** Update your code to use the new key.

### New key before confirmation

If you use the new key immediately after rotation (before updating your integration), you may see:

```bash
curl https://explorer.example.com/api/events \
  -H "x-api-key: new_key" \
  -i
```

**Response:**
```
HTTP/1.1 200 OK
[...event data...]
```

There is no waiting period for the new key — it is usable immediately.

## Rotation Checklist

Use this checklist to safely rotate an API key:

- [ ] **Initiate rotation** — Call `POST /api/admin/api-keys/{KEY_ID}/rotate`
- [ ] **Save new key** — Store the returned raw key in your integration's secret store
- [ ] **Test new key** — Make a test API call using the new key
- [ ] **Update production** — Deploy code/config changes to all systems using the old key
- [ ] **Monitor logs** — Check audit logs to see when the last request using the old key occurred
- [ ] **Verify old key rejection** — After grace period, confirm `curl` with the old key returns 401
- [ ] **Cleanup** — Remove the old key from documentation, dashboards, or development environments

## See Also

- **Admin API Reference** — `GET /api/admin/api-keys`, `PATCH /api/admin/api-keys/:id` for viewing/updating key metadata
- **Audit Log Query** — `docs/guides/health-and-alerting.md` for querying requests by key
- **Rate Limiting** — Each key's rate limits apply during and after rotation
