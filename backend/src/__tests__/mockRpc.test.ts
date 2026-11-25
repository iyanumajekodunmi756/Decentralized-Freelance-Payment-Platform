// Copyright (c) 2026 Stellar Freelance Payment Platform Contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { MockSorobanRpcServer, createMockContractEvent } from "../test/mockRpc";

describe("MockSorobanRpcServer (issue #375)", () => {
  it("instantiates offline with default and custom configurations", async () => {
    const server = new MockSorobanRpcServer("https://custom-rpc.example", 5000);
    expect(server.serverUrl).toBe("https://custom-rpc.example");
    expect(server.latestLedgerSequence).toBe(5000);

    const latest = await server.getLatestLedger();
    expect(latest.sequence).toBe(5000);
    expect(latest.id).toBe("mock-ledger-5000");
    expect(latest.protocolVersion).toBe(20);
    expect(server.getLatestLedgerCalls).toBe(1);
  });

  it("handles getEvents filtering by startLedger, contractIds, and event type", async () => {
    const server = new MockSorobanRpcServer();
    const c1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const c2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM";

    server.enqueueEvents([
      createMockContractEvent({ id: "e1", contractId: c1, ledger: 10 }),
      createMockContractEvent({ id: "e2", contractId: c2, ledger: 15 }),
      createMockContractEvent({ id: "e3", contractId: c1, ledger: 20 }),
      createMockContractEvent({ id: "e4", contractId: c1, ledger: 25, type: "diagnostic" }),
    ]);

    // Query ledger >= 12 filtered by c1
    const res1 = await server.getEvents({
      startLedger: 12,
      filters: [{ contractIds: [c1], type: "contract" }],
    });

    expect(res1.events.map((e) => e.id)).toEqual(["e3"]);
    expect(res1.latestLedger).toBe(1000);

    // Query ledger >= 10 all contracts
    const res2 = await server.getEvents({
      startLedger: 10,
    });
    expect(res2.events.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("handles pagination limit in getEvents", async () => {
    const server = new MockSorobanRpcServer();
    const c = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    const events = Array.from({ length: 10 }, (_, i) =>
      createMockContractEvent({ id: `e-${i}`, contractId: c, ledger: 100 + i }),
    );
    server.setEvents(events);

    const res = await server.getEvents({
      startLedger: 100,
      limit: 3,
    });
    expect(res.events).toHaveLength(3);
    expect(res.events.map((e) => e.id)).toEqual(["e-0", "e-1", "e-2"]);
  });

  it("returns configured transactions or NOT_FOUND", async () => {
    const server = new MockSorobanRpcServer();
    server.setTransaction("tx-123", {
      status: "SUCCESS",
      latestLedger: 1000,
      latestLedgerCloseTime: 1700000000,
      oldestLedger: 1,
      oldestLedgerCloseTime: 1699990000,
      resultXdr: "AAAAAA==",
    });

    const txSuccess = await server.getTransaction("tx-123");
    expect(txSuccess.status).toBe("SUCCESS");
    expect(txSuccess.resultXdr).toBe("AAAAAA==");

    const txMissing = await server.getTransaction("tx-unknown");
    expect(txMissing.status).toBe("NOT_FOUND");
    expect(server.getTransactionCalls).toEqual(["tx-123", "tx-unknown"]);
  });

  it("returns accounts and custom simulations", async () => {
    const server = new MockSorobanRpcServer();
    const address = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

    const account = await server.getAccount(address);
    expect(account.accountId()).toBe(address);
    expect(account.sequenceNumber()).toBe("1");

    // Default simulation returns void
    const sim1 = await server.simulateTransaction({ fake: true });
    expect(sim1.minResourceFee).toBe("100");

    // Custom simulation handler
    server.setSimulationHandler(() => ({
      result: { retval: xdr.ScVal.scvU32(42) },
      minResourceFee: "250",
    }));

    const sim2 = await server.simulateTransaction({ fake: 2 });
    expect(sim2.minResourceFee).toBe("250");
    expect(sim2.result?.retval?.u32()).toBe(42);
  });

  it("resets state and tracked calls", async () => {
    const server = new MockSorobanRpcServer();
    server.enqueueEvents([createMockContractEvent({ contractId: "C1" })]);
    await server.getEvents({ startLedger: 1 });
    await server.getLatestLedger();

    expect(server.getEventsCalls).toHaveLength(1);
    expect(server.getLatestLedgerCalls).toBe(1);

    server.reset();
    expect(server.getEventsCalls).toHaveLength(0);
    expect(server.getLatestLedgerCalls).toBe(0);

    const res = await server.getEvents({ startLedger: 1 });
    expect(res.events).toHaveLength(0);
  });
});
