import { logger } from "./logger.js";
/**
 * RWA Token Activity Decoder
 * Decodes Franklin Templeton Benji and other RWA token actions.
 * Maps enterprise function indicators to clear corporate action labels.
 */

// Known RWA contract patterns and their decoders
const RWA_PATTERNS = {
  // Franklin Templeton Benji token patterns
  benji: {
    contractIds: [
      // Add known Benji contract IDs here
    ],
    functions: {
      distribute_dividend: decodeDividendDistribution,
      dividend_payout: decodeDividendDistribution,
      investor_registry_update: decodeInvestorRegistryUpdate,
      registry_update: decodeInvestorRegistryUpdate,
      corporate_action: decodeCorporateAction,
      mint_shares: decodeMintShares,
      burn_shares: decodeBurnShares,
      transfer_shares: decodeTransferShares,
      dividend_reinvestment: decodeDividendReinvestment,
      redemption: decodeRedemption,
      subscription: decodeSubscription,
    },
  },
};

// RWA-related keywords to detect RWA contracts
const RWA_KEYWORDS = [
  "rwa",
  "real-world asset",
  "benji",
  "franklin templeton",
  "dividend",
  "investor",
  "redemption",
  "subscription",
  "corporate action",
  "share",
  "yield",
  "institutional",
];

/**
 * Detect if a contract is an RWA token based on metadata patterns.
 *
 * @param {object} meta - Contract metadata
 * @param {string} contractId - Contract ID
 * @returns {object|null} - { type: string, decoder: function } or null
 */
export function detectRwaToken(meta, _contractId) {
  if (!meta) return null;

  // Check for RWA-specific metadata fields
  if (meta.rwa_type || meta.is_rwa || meta.asset_class === "rwa") {
    return {
      type: meta.rwa_type || "rwa",
      decoder: getRwaDecoder(meta.rwa_type),
    };
  }

  // Check for Benji-specific patterns
  if (meta.name?.toLowerCase().includes("benji") || meta.description?.toLowerCase().includes("franklin templeton")) {
    return {
      type: "benji",
      decoder: getRwaDecoder("benji"),
    };
  }

  return null;
}

/**
 * Get the appropriate decoder for an RWA type.
 *
 * @param {string} rwaType - Type of RWA token
 * @returns {function} - Decoder function
 */
function getRwaDecoder(rwaType) {
  return RWA_PATTERNS[rwaType?.toLowerCase()] || null;
}

/**
 * Decode dividend distribution events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeDividendDistribution(fnName, args, _data) {
  const [yieldPerShare, investorCount, totalAmount, currency] = args;

  if (yieldPerShare !== undefined && investorCount !== undefined) {
    return `Distributed Dividend Yield of ${formatAmount(yieldPerShare)} ${currency || "USD"} per share to ${investorCount} investors`;
  }

  if (totalAmount !== undefined && investorCount !== undefined) {
    return `Distributed ${formatAmount(totalAmount)} ${currency || "USD"} dividend to ${investorCount} investors`;
  }

  return `Dividend distribution processed`;
}

/**
 * Decode investor registry update events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeInvestorRegistryUpdate(fnName, args, _data) {
  const [investorAddress, action, shares, status] = args;

  const actionLabel =
    {
      add: "added to",
      remove: "removed from",
      update: "updated in",
      activate: "activated in",
      deactivate: "deactivated in",
    }[action?.toLowerCase()] || "updated in";

  if (shares !== undefined) {
    return `Investor ${formatAddress(investorAddress)} ${actionLabel} registry with ${shares} shares (${status || "active"})`;
  }

  return `Investor ${formatAddress(investorAddress)} ${actionLabel} registry`;
}

/**
 * Decode corporate action events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeCorporateAction(fnName, args, _data) {
  const [actionType, , effectiveDate] = args;

  const typeLabel =
    {
      split: "Stock Split",
      dividend: "Dividend Payment",
      merger: "Merger",
      spinoff: "Spin-off",
      rights: "Rights Offering",
    }[actionType?.toLowerCase()] || "Corporate Action";

  return `${typeLabel} executed${effectiveDate ? ` effective ${effectiveDate}` : ""}`;
}

/**
 * Decode mint shares events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeMintShares(fnName, args, _data) {
  const [to, amount, reason] = args;

  const reasonLabel =
    {
      dividend: "dividend reinvestment",
      split: "stock split",
      issuance: "new issuance",
    }[reason?.toLowerCase()] || "issuance";

  return `Minted ${formatAmount(amount)} shares to ${formatAddress(to)} (${reasonLabel})`;
}

/**
 * Decode burn shares events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeBurnShares(fnName, args, _data) {
  const [from, amount, reason] = args;

  const reasonLabel =
    {
      redemption: "redemption",
      split: "stock split",
      cancellation: "cancellation",
    }[reason?.toLowerCase()] || "cancellation";

  return `Burned ${formatAmount(amount)} shares from ${formatAddress(from)} (${reasonLabel})`;
}

/**
 * Decode transfer shares events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeTransferShares(fnName, args, _data) {
  const [from, to, amount] = args;

  return `Transferred ${formatAmount(amount)} shares from ${formatAddress(from)} to ${formatAddress(to)}`;
}

/**
 * Decode dividend reinvestment events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeDividendReinvestment(fnName, args, _data) {
  const [investor, dividendAmount, sharesIssued] = args;

  return `Dividend reinvestment: ${formatAmount(dividendAmount)} USD converted to ${formatAmount(sharesIssued)} shares for ${formatAddress(investor)}`;
}

/**
 * Decode redemption events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeRedemption(fnName, args, _data) {
  const [investor, sharesRedeemed, amountReceived] = args;

  return `Redeemed ${formatAmount(sharesRedeemed)} shares for ${formatAmount(amountReceived)} USD from ${formatAddress(investor)}`;
}

/**
 * Decode subscription events.
 *
 * @param {string} fnName - Function name
 * @param {array} args - Function arguments
 * @param {any} data - Event data
 * @returns {string} - Human-readable description
 */
function decodeSubscription(fnName, args, _data) {
  const [investor, amountInvested, sharesIssued] = args;

  return `New subscription: ${formatAmount(amountInvested)} USD invested by ${formatAddress(investor)}, ${formatAmount(sharesIssued)} shares issued`;
}

/**
 * Format an amount for display.
 *
 * @param {any} amount - Amount to format
 * @returns {string} - Formatted amount
 */
function formatAmount(amount) {
  if (amount == null) return "?";
  const num = Number(amount);
  if (isNaN(num)) return String(amount);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Format an address for display.
 *
 * @param {string} addr - Address to format
 * @returns {string} - Formatted address
 */
function formatAddress(addr) {
  if (typeof addr !== "string" || addr.length < 10) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Detect if a contract is likely an RWA token based on function names and metadata.
 *
 * @param {object} meta - Contract metadata
 * @returns {object|null} - { is_rwa: boolean, rwa_type: string|null }
 */
export function detectRwaFromMetadata(meta) {
  if (!meta) return { is_rwa: false, rwa_type: null };

  // Check explicit RWA metadata
  if (meta.is_rwa || meta.rwa_type) {
    return {
      is_rwa: true,
      rwa_type: meta.rwa_type || "rwa",
    };
  }

  // Check name and description for RWA keywords
  const text = `${meta.name || ""} ${meta.description || ""}`.toLowerCase();
  const hasRwaKeyword = RWA_KEYWORDS.some((keyword) => text.includes(keyword));

  if (!hasRwaKeyword) {
    return { is_rwa: false, rwa_type: null };
  }

  // Determine RWA type from keywords
  let rwaType = "rwa";
  if (text.includes("benji") || text.includes("franklin templeton")) {
    rwaType = "benji";
  }

  // Check function names for RWA-specific patterns
  const fnNames = (meta.functions || []).map((f) => f.name.toLowerCase());
  const hasRwaFunctions = fnNames.some(
    (fn) =>
      fn.includes("dividend") ||
      fn.includes("redemption") ||
      fn.includes("subscription") ||
      fn.includes("investor") ||
      fn.includes("corporate_action"),
  );

  return {
    is_rwa: hasRwaKeyword || hasRwaFunctions,
    rwa_type: rwaType,
  };
}

/**
 * Decode an RWA event using registered patterns.
 *
 * @param {object} event - Decoded event
 * @param {object} meta - Contract metadata
 * @returns {string|null} - Enhanced description or null if not RWA
 */
export function decodeRwaEvent(event, meta) {
  const rwaInfo = detectRwaToken(meta, event.contract_id);
  if (!rwaInfo) return null;

  const patterns = RWA_PATTERNS[rwaInfo.type];
  if (!patterns) return null;

  const decoder = patterns.functions[event.function.toLowerCase()];
  if (!decoder) return null;

  try {
    const args = event.raw_topics?.slice(1) || [];
    let _data = event.raw_data;
    try {
      _data = JSON.parse(event.raw_data);
    } catch {
      /* keep as string */
    }

    return decoder(event.function, args, _data);
  } catch (err) {
    logger.error("[RWA Decoder] Error decoding event:", err);
    return null;
  }
}
