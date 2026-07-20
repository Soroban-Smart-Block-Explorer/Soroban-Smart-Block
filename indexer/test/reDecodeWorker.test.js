import { runReDecodeBatch } from "../src/reDecodeWorker.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("reDecodeWorker", () => {
  it("re-decodes superseded events and clears their marker", async () => {
    const updated = [];
    const db = {
      getEventsNeedingRedecode: async () => [
        {
          seq: 7,
          contract_id: "C1",
          ledger: 12,
          tx_hash: "tx-7",
          raw_topics: JSON.stringify(["transfer"]),
          raw_data: JSON.stringify("100"),
          abi_version: 1,
        },
      ],
      getContractMeta: async () => ({ abi_version: 2 }),
      updateRedecodedEvent: async (...args) => updated.push(args),
    };
    const decode = async (event, options) => {
      assert.deepEqual({ contractId: event.contractId, ledger: event.ledger, txHash: event.txHash }, { contractId: "C1", ledger: 12, txHash: "tx-7" });
      assert.deepEqual(options, { currentAbi: true });
      return { function: "transfer_v2", description: "decoded with ABI v2", raw_topics: ["transfer"], raw_data: "100" };
    };

    assert.equal(await runReDecodeBatch({ dbModule: db, decodeFn: decode }), 1);
    assert.equal(updated.length, 1);
    assert.equal(updated[0][0], 7);
    assert.equal(updated[0][1].function, "transfer_v2");
    assert.equal(updated[0][1].abi_version, 2);
    assert.equal(updated[0][2], 2);
  });
});
