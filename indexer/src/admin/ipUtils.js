/**
 * Shared IP helpers used by both the API-key authenticator
 * (auth/apiKeyAuth.js) and the admin bearer-token authenticator
 * (admin/adminAuth.js), so CIDR matching and proxy-header handling can't
 * drift between the two auth paths.
 */

// ── CIDR helpers ──────────────────────────────────────────────────────────────

/**
 * Convert an IPv4 address string to a 32-bit integer.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

/**
 * Check whether an IPv4 address matches a CIDR block.
 * @param {string} ip     e.g. "192.168.1.5"
 * @param {string} cidr   e.g. "192.168.1.0/24"
 * @returns {boolean}
 */
function ipMatchesCidr(ip, cidr) {
  // Handle plain IP (no prefix length) as /32.
  const [range, prefixStr] = cidr.includes('/') ? cidr.split('/') : [cidr, '32'];
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0;
  try {
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
  } catch {
    return false;
  }
}

/**
 * Return true if `ip` matches any entry in the CIDR list.
 * @param {string}   ip
 * @param {string[]} cidrList
 * @returns {boolean}
 */
function ipInCidrList(ip, cidrList) {
  if (!Array.isArray(cidrList) || cidrList.length === 0) return true;
  return cidrList.some((cidr) => ipMatchesCidr(ip, cidr));
}

// ── Client IP extraction ──────────────────────────────────────────────────────

/**
 * Extract the real client IP from the request, respecting common proxy headers.
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list; take the first (client) IP.
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? '0.0.0.0';
}

export { ipv4ToInt, ipMatchesCidr, ipInCidrList, getClientIp };
