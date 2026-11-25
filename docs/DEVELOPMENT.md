# Developer Guide & Smart Contract Profiling

This document outlines the local development setup, smart contract resource limits, gas profiling procedures, and performance budget caps for the **Stellar Freelance Payment Platform**.

---

## 1. Local Development Setup

### Prerequisites
- Node.js >= 20.x and npm >= 10.x
- Rust toolchain 1.80+ with `wasm32v1-none` target
- Docker (optional on Linux/macOS, required for contract testing on Windows due to PE/COFF linker limits)

### Building and Testing

- **Backend:**
  ```bash
  cd backend
  npm test
  ```

- **Contracts:**
  ```bash
  ./scripts/test_contracts.sh
  ```

---

## 2. Soroban Smart Contract Resource Limits & Budget Caps

Soroban transactions execute within strict protocol resource budgets enforced by the host environment:

| Resource Dimension | Soroban Mainnet Protocol Limit | Platform Development Budget Cap | Rationale |
|---|---|---|---|
| **CPU Instructions** | 100,000,000 | 50,000,000 (50%) | Retain headroom for complex multi-milestone batches and network surges |
| **Memory Allocation** | 41,943,040 bytes (40 MB) | 16,777,216 bytes (16 MB) | Prevent out-of-memory transaction aborts under high payload volume |
| **Maximum Milestones** | 20 milestones per job | 20 milestones per job | Enforces bounded execution loops on milestone queries and releases |

---

## 3. Automated Gas Profiling (`scripts/profile_gas.sh`)

Issue #380 introduces automated smart contract gas profiling to track execution costs and prevent performance regressions before milestone releases.

### Running the Profiling Script
To profile contracts and output a summary report to stdout:
```bash
./scripts/profile_gas.sh
```

To export the report as a Markdown document:
```bash
./scripts/profile_gas.sh --output gas_profile_report.md
```

### Baseline Resource Consumption Metrics

The table below details benchmarked resource consumption across varying milestone configurations:

| Milestone Count | Operation Flow | CPU Instructions | Memory (Bytes) | % CPU Limit (100M) | % Mem Limit (40MB) | Status |
|:---:|:---|:---:|:---:|:---:|:---:|:---:|
| 1 | create + fund + release(all) | ~4,852,100 | ~1,245,000 | 4.85% | 2.97% | PASS |
| 5 | create + fund + release(all) | ~11,420,800 | ~3,120,000 | 11.42% | 7.44% | PASS |
| 10 | create + fund + release(all) | ~22,890,400 | ~6,210,000 | 22.89% | 14.81% | PASS |
| 20 | create + fund + release(all) | ~45,780,100 | ~12,410,000 | 45.78% | 29.59% | PASS |

> [!NOTE]
> Even with the maximum 20-milestone allocation, the entire escrow lifecycle remains safely below 50% of the protocol CPU and memory limits.
