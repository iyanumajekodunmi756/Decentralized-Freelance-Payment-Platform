// Copyright (c) 2026 Stellar Freelance Payment Platform Contributors
// SPDX-License-Identifier: MIT

/**
 * mockRpc.ts
 *
 * In-memory MockSorobanRpcServer implementing SorobanRpc.Server interfaces
 * for fast, reliable, offline backend integration and unit testing (issue #375).
 */

import { Account, xdr } from "@stellar/stellar-sdk";

export interface MockEventFilter {
  type?: "contract" | "diagnostic" | "system";
  contractIds?: string[];
  topics?: (string | string[])[];
}

export interface MockGetEventsRequest {
  startLedger: number;
  filters?: MockEventFilter[];
  pagination?: { cursor?: string; limit?: number };
  limit?: number;
}

export interface MockContractEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: (string | xdr.ScVal)[];
  value: unknown;
  inSuccessfulContractCall?: boolean;
  txHash?: string;
  pagingToken?: string;
}

export interface MockTransactionResponse {
  status: "SUCCESS" | "NOT_FOUND" | "FAILED";
  latestLedger: number;
  latestLedgerCloseTime: number;
  oldestLedger: number;
  oldestLedgerCloseTime: number;
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
}

export interface MockSimulateResponse {
  result?: {
    retval?: xdr.ScVal;
    auth?: unknown[];
  };
  minResourceFee?: string;
  cost?: {
    cpuInsns: string;
    memBytes: string;
  };
  error?: string;
  events?: unknown[];
  transactionData?: unknown;
}

export class MockSorobanRpcServer {
  public serverUrl: string;
  public latestLedgerSequence: number;
  public latestLedgerId: string;

  private events: MockContractEvent[] = [];
  private transactions: Map<string, MockTransactionResponse> = new Map();
  private accounts: Map<string, Account> = new Map();
  private simulationHandler?: (tx: unknown) => MockSimulateResponse | Promise<MockSimulateResponse>;

  // Call tracking for assertions
  public getEventsCalls: MockGetEventsRequest[] = [];
  public getTransactionCalls: string[] = [];
  public getLatestLedgerCalls = 0;
  public getAccountCalls: string[] = [];
  public simulateTransactionCalls: unknown[] = [];

  constructor(serverUrl: string = "https://mock-soroban-rpc.local", latestLedger: number = 1000) {
    this.serverUrl = serverUrl;
    this.latestLedgerSequence = latestLedger;
    this.latestLedgerId = `mock-ledger-${latestLedger}`;
  }

  public setLatestLedger(sequence: number, id?: string): void {
    this.latestLedgerSequence = sequence;
    this.latestLedgerId = id ?? `mock-ledger-${sequence}`;
  }

  public async getLatestLedger(): Promise<{ id: string; sequence: number; protocolVersion: number }> {
    this.getLatestLedgerCalls++;
    return {
      id: this.latestLedgerId,
      sequence: this.latestLedgerSequence,
      protocolVersion: 20,
    };
  }

  public enqueueEvents(events: MockContractEvent[]): void {
    this.events.push(...events);
  }

  public setEvents(events: MockContractEvent[]): void {
    this.events = [...events];
  }

  public async getEvents(request: MockGetEventsRequest): Promise<{ events: MockContractEvent[]; latestLedger: number }> {
    this.getEventsCalls.push(request);

    let filtered = this.events.filter((evt) => evt.ledger >= request.startLedger);

    if (request.filters && request.filters.length > 0) {
      filtered = filtered.filter((evt) => {
        return request.filters!.some((filter) => {
          if (filter.contractIds && filter.contractIds.length > 0) {
            if (!filter.contractIds.includes(evt.contractId)) {
              return false;
            }
          }
          if (filter.type && evt.type !== filter.type) {
            return false;
          }
          return true;
        });
      });
    }

    const limit = request.limit ?? request.pagination?.limit ?? 100;
    const sliced = filtered.slice(0, limit);

    return {
      events: sliced,
      latestLedger: this.latestLedgerSequence,
    };
  }

  public setTransaction(hash: string, response: MockTransactionResponse): void {
    this.transactions.set(hash, response);
  }

  public async getTransaction(hash: string): Promise<MockTransactionResponse> {
    this.getTransactionCalls.push(hash);
    const tx = this.transactions.get(hash);
    if (!tx) {
      return {
        status: "NOT_FOUND",
        latestLedger: this.latestLedgerSequence,
        latestLedgerCloseTime: Math.floor(Date.now() / 1000),
        oldestLedger: Math.max(1, this.latestLedgerSequence - 1000),
        oldestLedgerCloseTime: Math.floor(Date.now() / 1000) - 5000,
      };
    }
    return tx;
  }

  public setAccount(address: string, account: Account): void {
    this.accounts.set(address, account);
  }

  public async getAccount(address: string): Promise<Account> {
    this.getAccountCalls.push(address);
    if (this.accounts.has(address)) {
      return this.accounts.get(address)!;
    }
    return new Account(address, "1");
  }

  public setSimulationHandler(handler: (tx: unknown) => MockSimulateResponse | Promise<MockSimulateResponse>): void {
    this.simulationHandler = handler;
  }

  public async simulateTransaction(tx: unknown): Promise<MockSimulateResponse> {
    this.simulateTransactionCalls.push(tx);
    if (this.simulationHandler) {
      return await this.simulationHandler(tx);
    }
    return {
      result: {
        retval: xdr.ScVal.scvVoid(),
      },
      minResourceFee: "100",
      cost: {
        cpuInsns: "100000",
        memBytes: "50000",
      },
    };
  }

  public reset(): void {
    this.events = [];
    this.transactions.clear();
    this.accounts.clear();
    this.simulationHandler = undefined;
    this.getEventsCalls = [];
    this.getTransactionCalls = [];
    this.getLatestLedgerCalls = 0;
    this.getAccountCalls = [];
    this.simulateTransactionCalls = [];
  }
}

/**
 * Helper to create a mock contract event.
 */
export function createMockContractEvent(options: {
  id?: string;
  contractId: string;
  type?: string;
  ledger?: number;
  topic?: (string | xdr.ScVal)[];
  value?: unknown;
  txHash?: string;
}): MockContractEvent {
  const ledger = options.ledger ?? 100;
  return {
    id: options.id ?? `evt-${ledger}-${Math.random().toString(36).slice(2, 7)}`,
    type: options.type ?? "contract",
    ledger,
    ledgerClosedAt: new Date(1700000000000 + ledger * 5000).toISOString(),
    contractId: options.contractId,
    topic: options.topic ?? [],
    value: options.value ?? null,
    inSuccessfulContractCall: true,
    txHash: options.txHash ?? `tx-${ledger}`,
    pagingToken: `${ledger}-0`,
  };
}
