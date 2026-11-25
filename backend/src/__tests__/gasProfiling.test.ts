// Copyright (c) 2026 Stellar Freelance Payment Platform Contributors
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Soroban Smart Contract Gas Profiling & Budget Caps (issue #380)", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const profileScriptPath = path.join(repoRoot, "scripts/profile_gas.sh");
  const developmentDocPath = path.join(repoRoot, "docs/DEVELOPMENT.md");
  const escrowTestPath = path.join(repoRoot, "contracts/escrow/src/test.rs");

  it("scripts/profile_gas.sh exists and contains milestone profiling logic", () => {
    expect(existsSync(profileScriptPath)).toBe(true);
    const script = readFileSync(profileScriptPath, "utf8");
    expect(script).toContain("profile_escrow_milestones");
    expect(script).toContain("MAX_CPU=100000000");
    expect(script).toContain("MAX_MEM=41943040");
    expect(script).toContain("generate_table");
  });

  it("docs/DEVELOPMENT.md documents budget caps, resource limits, and gas profiling", () => {
    expect(existsSync(developmentDocPath)).toBe(true);
    const doc = readFileSync(developmentDocPath, "utf8");
    expect(doc).toContain("100,000,000");
    expect(doc).toContain("41,943,040");
    expect(doc).toContain("scripts/profile_gas.sh");
    expect(doc).toContain("create + fund + release(all)");
  });

  it("contracts/escrow/src/test.rs defines gas profiling benchmarks for 1, 5, 10, and 20 milestones", () => {
    expect(existsSync(escrowTestPath)).toBe(true);
    const testContent = readFileSync(escrowTestPath, "utf8");
    expect(testContent).toContain("profile_escrow_milestones_1");
    expect(testContent).toContain("profile_escrow_milestones_5");
    expect(testContent).toContain("profile_escrow_milestones_10");
    expect(testContent).toContain("profile_escrow_milestones_20");
    expect(testContent).toContain("cpu_instruction_cost");
    expect(testContent).toMatch(/memory_bytes?_cost/);
  });
});
