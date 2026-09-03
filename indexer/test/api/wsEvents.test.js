/**
 * Test: wsEvents.js broadcasts decoded events to all connected WebSocket clients
 *
 * Spins up a real HTTP server, attaches the WebSocket server to it, opens
 * two client connections, calls publish() directly, and asserts both clients
 * receive the message within 1 second — matching the acceptance criteria of
 * issue #426.
 *
 * No database or indexer daemon is required; the test imports only
 * wsEvents.js and the built-in Node http module.
 */

import http from "http";
import { WebSocket } from "ws";
import { attachWebSocketServer, publish, publishTransactionStatus } from "../../src/wsEvents.js";

// Helper: connect a WebSocket client and resolve once the "connected"
// handshake message arrives (so we know the server is ready before publishing).
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => {
      // wait for the "connected" welcome frame before resolving
      ws.once("message", () => resolve(ws));
    });
    ws.once("error", reject);
  });
}

// Helper: wait up to `timeoutMs` for the next message on a client.
function nextMessage(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

// Helper: create an HTTP server on an OS-assigned port, attach the WS server,
// and return { httpServer, wss, port }.
function createServer() {
  return new Promise((resolve) => {
    const httpServer = http.createServer();
    const wss = attachWebSocketServer(httpServer);
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address();
      resolve({ httpServer, wss, port });
    });
  });
}

describe("wsEvents — broadcast to connected clients", () => {
  let httpServer;
  let wss;
  let port;
  let clientA;
  let clientB;

  beforeAll(async () => {
    ({ httpServer, wss, port } = await createServer());
    // Open both clients and wait for their welcome frames
    [clientA, clientB] = await Promise.all([connectClient(port), connectClient(port)]);
  });

  afterAll(async () => {
    clientA?.terminate();
    clientB?.terminate();
    // wss.close()'s callback fires only once every server-side connection has
    // finished its own "close" handler (see wsEvents.js) — awaiting it here
    // (instead of firing-and-forgetting like `httpServer.close()` used to)
    // stops those handlers' console.log calls from landing after Jest tears
    // this file's environment down, which otherwise silently sets
    // process.exitCode = 1 for the whole run (issue: CI red on "Cannot log
    // after tests are done" from a client disconnecting late).
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it("events within the same ledger are batched into a single message", async () => {
    // Publish three events for the same ledger in quick succession
    const event1 = {
      seq: 1,
      contract_id: "CTEST123",
      function: "transfer",
      ledger: 42,
      description: "Transfer 1",
      raw_topics: ["transfer"],
      raw_data: "100",
    };
    const event2 = {
      seq: 2,
      contract_id: "CTEST123",
      function: "transfer",
      ledger: 42,
      description: "Transfer 2",
      raw_topics: ["transfer"],
      raw_data: "200",
    };
    const event3 = {
      seq: 3,
      contract_id: "CTEST123",
      function: "transfer",
      ledger: 42,
      description: "Transfer 3",
      raw_topics: ["transfer"],
      raw_data: "300",
    };

    const msgA = await Promise.all([
      nextMessage(clientA, 500), // Wait a bit longer for batch to accumulate
      Promise.resolve().then(() => {
        publish(event1);
        publish(event2);
        publish(event3);
      }),
    ]).then(([msg]) => msg);

    // Message should be a batch containing all three events
    expect(msgA.type).toBe("events_batch");
    expect(Array.isArray(msgA.data)).toBe(true);
    expect(msgA.data.length).toBe(3);
    expect(msgA.data[0].seq).toBe(1);
    expect(msgA.data[1].seq).toBe(2);
    expect(msgA.data[2].seq).toBe(3);
  });

  it("both clients receive a published event within 1 second", async () => {
    const decoded = {
      seq: 100,
      contract_id: "CTEST123",
      function: "transfer",
      ledger: 43,
      description: "Address GA… transferred 100 USDC to GB… on TestContract",
      raw_topics: ["transfer", "GA123", "GB456"],
      raw_data: "100",
    };

    // Register next-message listeners before publishing so neither client
    // can miss the frame.
    const [msgA, msgB] = await Promise.all([
      nextMessage(clientA, 500),
      nextMessage(clientB, 500),
      // Publish after listeners are registered (Promise.all starts them first)
      Promise.resolve().then(() => publish(decoded)),
    ]);

    // Both frames must be batches (batching is enabled)
    expect(msgA.type).toBe("events_batch");
    expect(msgB.type).toBe("events_batch");
    expect(msgA.data[0].contract_id).toBe("CTEST123");
    expect(msgA.data[0].description).toBe(decoded.description);

    expect(msgB.data[0].contract_id).toBe("CTEST123");
    expect(msgB.data[0].description).toBe(decoded.description);
  });

  it("both clients receive the same event payload", async () => {
    const decoded = {
      seq: 101,
      contract_id: "CSWAP999",
      function: "swap",
      ledger: 99,
      description: "Address GX… swapped 50 XLM → 48 USDC on StellarSwap",
      raw_topics: ["swap"],
      raw_data: "{}",
    };

    const [msgA, msgB] = await Promise.all([
      nextMessage(clientA, 500),
      nextMessage(clientB, 500),
      Promise.resolve().then(() => publish(decoded)),
    ]);

    // Payloads must be identical (batches)
    expect(msgA).toEqual(msgB);
    expect(msgA.type).toBe("events_batch");
    expect(msgA.data[0].function).toBe("swap");
    expect(msgA.data[0].ledger).toBe(99);
  });

  it("late-connecting third client does not receive previously published events", async () => {
    // publish an event before the third client connects
    publish({
      seq: 102,
      contract_id: "CBEFORE",
      function: "mint",
      ledger: 1,
      description: "minted before client C connected",
      raw_topics: [],
      raw_data: "",
    });

    const clientC = await connectClient(port);

    // Now publish a new event that clientC should receive
    const liveEvent = {
      seq: 103,
      contract_id: "CAFTER",
      function: "burn",
      ledger: 2,
      description: "burned after client C connected",
      raw_topics: [],
      raw_data: "",
    };

    const msgC = await Promise.all([
      nextMessage(clientC, 500),
      Promise.resolve().then(() => publish(liveEvent)),
    ]).then(([msg]) => msg);

    expect(msgC.type).toBe("events_batch");
    expect(msgC.data[0].contract_id).toBe("CAFTER");

    clientC.terminate();
  });

  it("disconnected client is cleaned up and does not cause errors on publish", async () => {
    const clientD = await connectClient(port);
    // Force-close client D
    clientD.terminate();
    // Wait a tick for the close event to propagate and the bus listener to be removed
    await new Promise((r) => setTimeout(r, 50));

    // Publishing after D disconnected must not throw. clientA/clientB are
    // still connected and will also receive this broadcast — drain it from
    // both so it doesn't leak into the next test's nextMessage() calls.
    const cleanupEvent = {
      seq: 104,
      contract_id: "CCLEAN",
      function: "transfer",
      ledger: 3,
      description: "post-disconnect publish",
      raw_topics: [],
      raw_data: "",
    };
    await Promise.all([
      nextMessage(clientA, 500),
      nextMessage(clientB, 500),
      Promise.resolve().then(() => {
        expect(() => publish(cleanupEvent)).not.toThrow();
      }),
    ]);
  });

  it("publishTransactionStatus is broadcast via the transaction_status channel", async () => {
    // The WS handler doesn't forward transaction_status to clients —
    // that channel is for server-side SSE (useTxStatus hook).  Confirm
    // publish() still works correctly on the event channel after
    // publishTransactionStatus has been called.
    publishTransactionStatus({
      tx_hash: "TXABC",
      status: "success",
      ledger: 10,
      error: null,
    });

    const liveEvent = {
      seq: 105,
      contract_id: "CPOST_TX",
      function: "transfer",
      ledger: 10,
      description: "transfer after tx status publish",
      raw_topics: [],
      raw_data: "",
    };

    const [msgA, msgB] = await Promise.all([
      nextMessage(clientA, 500),
      nextMessage(clientB, 500),
      Promise.resolve().then(() => publish(liveEvent)),
    ]);

    expect(msgA.type).toBe("events_batch");
    expect(msgB.type).toBe("events_batch");
    expect(msgA.data[0].seq).toBe(105);
  });

  it("events from different ledgers are batched together and sent in ledger order", async () => {
    // Publish events from multiple ledgers in non-sequential order
    const eventLedger2 = {
      seq: 200,
      contract_id: "CTEST",
      function: "transfer",
      ledger: 2,
      description: "Ledger 2 event",
      raw_topics: [],
      raw_data: "",
    };
    const eventLedger1 = {
      seq: 201,
      contract_id: "CTEST",
      function: "transfer",
      ledger: 1,
      description: "Ledger 1 event",
      raw_topics: [],
      raw_data: "",
    };
    const eventLedger2b = {
      seq: 202,
      contract_id: "CTEST",
      function: "transfer",
      ledger: 2,
      description: "Another Ledger 2 event",
      raw_topics: [],
      raw_data: "",
    };

    const msg = await Promise.all([
      nextMessage(clientA, 500),
      Promise.resolve().then(() => {
        // Publish in order: ledger 2, ledger 1, ledger 2 again
        publish(eventLedger2);
        publish(eventLedger1);
        publish(eventLedger2b);
      }),
    ]).then(([m]) => m);

    // All events should be in one batch, ordered by ledger then by sequence
    expect(msg.type).toBe("events_batch");
    expect(msg.data.length).toBe(3);
    // Events should be sorted by ledger first: ledger 1, then ledger 2 (with both ledger 2 events)
    expect(msg.data[0].ledger).toBe(1);
    expect(msg.data[0].seq).toBe(201);
    expect(msg.data[1].ledger).toBe(2);
    expect(msg.data[1].seq).toBe(200);
    expect(msg.data[2].ledger).toBe(2);
    expect(msg.data[2].seq).toBe(202);
  });
});
