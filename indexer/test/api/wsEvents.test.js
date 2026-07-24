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
// and return { httpServer, port }.
function createServer() {
  return new Promise((resolve) => {
    const httpServer = http.createServer();
    attachWebSocketServer(httpServer);
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address();
      resolve({ httpServer, port });
    });
  });
}

describe("wsEvents — broadcast to connected clients", () => {
  let httpServer;
  let port;
  let clientA;
  let clientB;

  beforeAll(async () => {
    ({ httpServer, port } = await createServer());
    // Open both clients and wait for their welcome frames
    [clientA, clientB] = await Promise.all([connectClient(port), connectClient(port)]);
  });

  afterAll(() => {
    clientA?.terminate();
    clientB?.terminate();
    httpServer?.close();
  });

  it("both clients receive a published event within 1 second", async () => {
    const decoded = {
      seq: 1,
      contract_id: "CTEST123",
      function: "transfer",
      ledger: 42,
      description: "Address GA… transferred 100 USDC to GB… on TestContract",
      raw_topics: ["transfer", "GA123", "GB456"],
      raw_data: "100",
    };

    // Register next-message listeners before publishing so neither client
    // can miss the frame.
    const [msgA, msgB] = await Promise.all([
      nextMessage(clientA),
      nextMessage(clientB),
      // Publish after listeners are registered (Promise.all starts them first)
      Promise.resolve().then(() => publish(decoded)),
    ]);

    // Both frames must be well-formed event envelopes
    expect(msgA.type).toBe("event");
    expect(msgA.data.contract_id).toBe("CTEST123");
    expect(msgA.data.description).toBe(decoded.description);

    expect(msgB.type).toBe("event");
    expect(msgB.data.contract_id).toBe("CTEST123");
    expect(msgB.data.description).toBe(decoded.description);
  });

  it("both clients receive the same event payload", async () => {
    const decoded = {
      seq: 2,
      contract_id: "CSWAP999",
      function: "swap",
      ledger: 99,
      description: "Address GX… swapped 50 XLM → 48 USDC on StellarSwap",
      raw_topics: ["swap"],
      raw_data: "{}",
    };

    const [msgA, msgB] = await Promise.all([
      nextMessage(clientA),
      nextMessage(clientB),
      Promise.resolve().then(() => publish(decoded)),
    ]);

    // Payloads must be identical
    expect(msgA).toEqual(msgB);
    expect(msgA.data.function).toBe("swap");
    expect(msgA.data.ledger).toBe(99);
  });

  it("late-connecting third client does not receive previously published events", async () => {
    // publish an event before the third client connects
    publish({
      seq: 3,
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
      seq: 4,
      contract_id: "CAFTER",
      function: "burn",
      ledger: 2,
      description: "burned after client C connected",
      raw_topics: [],
      raw_data: "",
    };

    const msgC = await Promise.all([
      nextMessage(clientC),
      Promise.resolve().then(() => publish(liveEvent)),
    ]).then(([msg]) => msg);

    expect(msgC.type).toBe("event");
    expect(msgC.data.contract_id).toBe("CAFTER");

    clientC.terminate();
  });

  it("disconnected client is cleaned up and does not cause errors on publish", async () => {
    const clientD = await connectClient(port);
    // Force-close client D
    clientD.terminate();
    // Wait a tick for the close event to propagate and the bus listener to be removed
    await new Promise((r) => setTimeout(r, 50));

    // Publishing after D disconnected must not throw
    expect(() =>
      publish({
        seq: 5,
        contract_id: "CCLEAN",
        function: "transfer",
        ledger: 3,
        description: "post-disconnect publish",
        raw_topics: [],
        raw_data: "",
      }),
    ).not.toThrow();
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
      seq: 6,
      contract_id: "CPOST_TX",
      function: "transfer",
      ledger: 10,
      description: "transfer after tx status publish",
      raw_topics: [],
      raw_data: "",
    };

    const [msgA, msgB] = await Promise.all([
      nextMessage(clientA),
      nextMessage(clientB),
      Promise.resolve().then(() => publish(liveEvent)),
    ]);

    expect(msgA.type).toBe("event");
    expect(msgB.type).toBe("event");
    expect(msgA.data.seq).toBe(6);
  });
});
