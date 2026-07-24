import { Contract, TransactionBuilder, Networks, nativeToScVal, rpc as SorobanRpc } from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const DEFAULT_SOURCE_ACCOUNT =
  process.env.SIMULATE_SOURCE || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

export function normalizeCalls(calls) {
  if (!Array.isArray(calls)) return [];

  return calls.map((call, index) => ({
    id: String(call.id || `call-${index + 1}`),
    contractId: String(call.contractId || ""),
    functionName: String(call.functionName || ""),
    args: Array.isArray(call.args) ? call.args : [],
    type: call.type || "call",
    condition: call.condition || null,
    loop: call.loop || null,
    signer: call.signer || "",
    signerThreshold: call.signerThreshold || 1,
    signerWeight: call.signerWeight || 1,
  }));
}

export function summarizeGas(estimates) {
  return estimates.reduce(
    (acc, estimate) => ({
      cpuInsns: acc.cpuInsns + (estimate.cpuInsns || 0),
      memBytes: acc.memBytes + (estimate.memBytes || 0),
      fee: acc.fee + (estimate.fee || 0),
    }),
    { cpuInsns: 0, memBytes: 0, fee: 0 },
  );
}

export async function simulateBatch(calls, sourceAccount, networkPassphrase = Networks.TESTNET) {
  const normalizedCalls = normalizeCalls(calls);
  if (normalizedCalls.length === 0) {
    return {
      success: true,
      results: [],
      totalGas: { cpuInsns: 0, memBytes: 0, fee: 0 },
      stateDiffs: [],
      conflicts: [],
    };
  }

  const server = new SorobanRpc.Server(RPC_URL);
  const account = await server.getAccount(sourceAccount || DEFAULT_SOURCE_ACCOUNT);
  const tx = buildTransaction(account, normalizedCalls, networkPassphrase);
  const sim = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(sim)) {
    return {
      success: false,
      error: sim.error,
      results: normalizedCalls.map((call) => ({
        callId: call.id,
        success: false,
        error: sim.error,
        cost: { cpuInsns: 0, memBytes: 0 },
      })),
      totalGas: { cpuInsns: 0, memBytes: 0, fee: 0 },
      stateDiffs: [],
      conflicts: await detectConflicts(normalizedCalls),
    };
  }

  const results = normalizedCalls.map((call, index) => ({
    callId: call.id,
    success: true,
    returnValue: sim.results?.[index]?.retval?.toXDR("base64"),
    cost: {
      cpuInsns: Number(sim.cost?.cpuInsns ?? 0),
      memBytes: Number(sim.cost?.memBytes ?? 0),
    },
  }));

  return {
    success: true,
    results,
    totalGas: {
      cpuInsns: Number(sim.cost?.cpuInsns ?? 0),
      memBytes: Number(sim.cost?.memBytes ?? 0),
      fee: Number(sim.minResourceFee ?? 0),
    },
    stateDiffs: buildStateDiffPreview(normalizedCalls),
    conflicts: await detectConflicts(normalizedCalls),
    latestLedger: sim.latestLedger,
  };
}

export async function estimateGas(calls, sourceAccount) {
  const normalizedCalls = normalizeCalls(calls);
  const server = new SorobanRpc.Server(RPC_URL);
  const account = await server.getAccount(sourceAccount || DEFAULT_SOURCE_ACCOUNT);
  const estimates = [];

  for (const call of normalizedCalls) {
    try {
      const tx = buildTransaction(account, [call], Networks.TESTNET);
      const sim = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(sim)) {
        estimates.push({
          callId: call.id,
          error: sim.error,
          cpuInsns: 0,
          memBytes: 0,
          fee: 0,
        });
      } else {
        estimates.push({
          callId: call.id,
          cpuInsns: Number(sim.cost?.cpuInsns ?? 0),
          memBytes: Number(sim.cost?.memBytes ?? 0),
          fee: Number(sim.minResourceFee ?? 0),
        });
      }
    } catch (e) {
      estimates.push({
        callId: call.id,
        error: e.message,
        cpuInsns: 0,
        memBytes: 0,
        fee: 0,
      });
    }
  }

  return estimates;
}

export async function detectConflicts(calls) {
  const normalizedCalls = normalizeCalls(calls);
  const conflicts = [];

  for (let i = 0; i < normalizedCalls.length; i += 1) {
    for (let j = i + 1; j < normalizedCalls.length; j += 1) {
      const callA = normalizedCalls[i];
      const callB = normalizedCalls[j];
      const keysA = extractStorageKeys(callA);
      const keysB = extractStorageKeys(callB);
      const commonKeys = keysA.filter((keyA) =>
        keysB.some((keyB) => keyA.contractId === keyB.contractId && keyA.key === keyB.key),
      );

      if (commonKeys.length === 0) continue;

      const conflictType = conflictTypeFor(callA, callB);
      conflicts.push({
        callId: callA.id,
        storageKeys: commonKeys,
        conflictingCalls: [
          {
            callId: callB.id,
            type: conflictType,
          },
        ],
      });
      conflicts.push({
        callId: callB.id,
        storageKeys: commonKeys,
        conflictingCalls: [
          {
            callId: callA.id,
            type: conflictType,
          },
        ],
      });
    }
  }

  return conflicts;
}

export async function optimizeBatchOrder(calls, sourceAccount, estimates) {
  const normalizedCalls = normalizeCalls(calls);
  const gasBreakdown = estimates ?? (await estimateGas(normalizedCalls, sourceAccount));
  const costByCall = new Map(gasBreakdown.map((estimate) => [estimate.callId, estimate.cpuInsns + estimate.memBytes]));

  return normalizedCalls
    .map((call, index) => ({ call, index, cost: costByCall.get(call.id) ?? 0, access: inferAccessType(call) }))
    .sort((a, b) => {
      if (a.access === "read" && b.access !== "read") return -1;
      if (b.access === "read" && a.access !== "read") return 1;
      if (a.access === "write" && b.access !== "write") return 1;
      if (b.access === "write" && a.access !== "write") return -1;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.index - b.index;
    })
    .map((entry) => entry.call.id);
}

export async function validateBatch(calls) {
  const normalizedCalls = normalizeCalls(calls);
  const errors = [];
  const ids = new Set();

  for (const call of normalizedCalls) {
    if (ids.has(call.id)) errors.push({ callId: call.id, error: "Duplicate call id" });
    ids.add(call.id);

    if (!call.contractId) errors.push({ callId: call.id, error: "Missing contract ID" });
    if (!call.functionName) errors.push({ callId: call.id, error: "Missing function name" });

    for (const [argIndex, arg] of call.args.entries()) {
      if (!arg.name) errors.push({ callId: call.id, error: `Argument ${argIndex} is missing a name` });
      if (arg.value === undefined || arg.value === null || arg.value === "") {
        errors.push({ callId: call.id, error: `Argument ${arg.name || argIndex} is missing a value` });
      }
    }

    if (call.condition && !normalizedCalls.some((candidate) => candidate.id === call.condition.sourceCallId)) {
      errors.push({ callId: call.id, error: `Condition references unknown call ${call.condition.sourceCallId}` });
    }

    if (call.loop && (!Number.isFinite(call.loop.iterations) || call.loop.iterations < 1)) {
      errors.push({ callId: call.id, error: "Loop iterations must be greater than zero" });
    }

    if ((call.signerThreshold || 1) > (call.signerWeight || 1)) {
      errors.push({ callId: call.id, error: "Signer threshold exceeds signer weight" });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    conflicts: await detectConflicts(normalizedCalls),
  };
}

function buildTransaction(account, calls, networkPassphrase) {
  const operations = calls.map(createOperation);

  return new TransactionBuilder(account, {
    fee: String(Math.max(100, operations.length * 100)),
    networkPassphrase,
  })
    .addOperation(...operations)
    .setTimeout(30)
    .build();
}

function createOperation(call) {
  const contract = new Contract(call.contractId);
  const scArgs = call.args.map((arg) =>
    nativeToScVal(normalizeArgValue(arg.value, arg.type), arg.type ? { type: arg.type } : undefined),
  );
  return contract.call(call.functionName, ...scArgs);
}

function normalizeArgValue(value, type) {
  if (type === "bool") return value === true || value === "true";
  if (["i128", "u128", "i256", "u256"].includes(type)) return BigInt(String(value));
  return value;
}

function extractStorageKeys(call) {
  const keys = [];

  for (const arg of call.args) {
    const argName = String(arg.name || "").toLowerCase();
    const argType = String(arg.type || "").toLowerCase();

    if (
      argName.includes("key") ||
      argName.includes("id") ||
      argName.includes("address") ||
      ["address", "bytes", "string", "symbol"].includes(argType)
    ) {
      const key = ["address", "bytes", "string", "symbol"].includes(argType) ? arg.value : `${arg.name || argType}:${arg.value}`;
      keys.push({
        contractId: call.contractId,
        key: `${argType}:${key}`,
        accessType: inferAccessType(call),
      });
    }
  }

  if (keys.length === 0) {
    keys.push({
      contractId: call.contractId,
      key: call.functionName,
      accessType: inferAccessType(call),
    });
  }

  return keys;
}

function inferAccessType(call) {
  const functionName = String(call.functionName || "").toLowerCase();

  if (/^(set|put|update|transfer|mint|burn|approve|deposit|withdraw|stake|unstake|bid|list|delist|claim|revoke|grant|pause|unpause)/.test(functionName)) {
    return "write";
  }

  if (/^(get|read|balance|allowance|owner|name|symbol|decimals|metadata|view|check)/.test(functionName)) {
    return "read";
  }

  return "unknown";
}

function conflictTypeFor(callA, callB) {
  const accessA = inferAccessType(callA);
  const accessB = inferAccessType(callB);

  if (accessA === "write" && accessB === "write") return "write-write";
  if (accessA === "write" || accessB === "write") return "read-write";
  return "read-read";
}

function buildStateDiffPreview(calls) {
  return calls.map((call) => ({
    callId: call.id,
    before: {},
    after: {},
    changes: extractStorageKeys(call).map((key) => ({
      key: key.key,
      oldValue: null,
      newValue: key.accessType === "write" ? "pending simulation" : null,
      changeType: key.accessType === "write" ? "updated" : "created",
    })),
  }));
}
