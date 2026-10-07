# AgriEscrow — Staged Escrow Payments for Agricultural Orders

A financial DApp on the **Ethereum Sepolia testnet** that protects both sides of a
farm-produce trade. The buyer locks payment in a smart contract; the farmer is paid
in two stages (an upfront share on shipment, the balance on confirmed delivery).
Timeouts protect each party, and a neutral arbiter settles disputes.

- **Live app:** `https://<your-service>.onrender.com`  ← replace after deploying
- **Contract:** [`0x1A22A6d9DF7FF094CaACE803A3b57859354659eB`](https://sepolia.etherscan.io/address/0x1A22A6d9DF7FF094CaACE803A3b57859354659eB) (source verified on Etherscan)
- **Deployment block:** 11857854

## Features

| Area | What it does |
|---|---|
| Staged payment | 0–50 % of the order is released on shipment, the rest on confirmation |
| Document anchoring | The seller anchors the keccak-256 hash of a shipping/inspection document; anyone can verify a file against it in the browser |
| Timeouts | Buyer is refunded if the seller misses the shipping deadline; seller can claim the balance if the buyer stays silent after the confirmation window |
| Disputes | Buyer can dispute within the confirmation window; the arbiter splits the remaining funds |
| Pull payments | Payouts are credited to `pendingWithdrawals` and withdrawn by each user |
| History | Every contract event is indexed by the backend and shown per order and per account |

## Architecture

```
Browser (HTML/CSS/JS + ethers.js v6)
   │  signs transactions            │  REST (read-only)
   ▼                                ▼
MetaMask ──► Sepolia ◄── web3.py ── Flask backend ── SQLite (event cache)
             AgriEscrow.sol
```

- **Smart contract** (`contracts/AgriEscrow.sol`) — order state machine, access control,
  custom errors, re-entrancy guard, checks-effects-interactions, packed storage.
- **Frontend** (`templates/index.html`, `static/`) — connects MetaMask, enforces the
  Sepolia network, validates input, simulates each call with `estimateGas` (so contract
  reverts are shown with a readable message before anything is signed), and displays
  pending / confirmed / failed transaction status with Etherscan links.
- **Backend** (`app.py`) — Flask + web3.py. Indexes contract events into SQLite and
  serves orders, statistics and history. It is read-only and holds **no private keys**.
  The chain is the source of truth: if the database is lost it is rebuilt from
  `DEPLOY_BLOCK`.

### REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Contract address, chain, arbiter, confirmation window |
| GET | `/api/stats` | Order counts by status, value locked |
| GET | `/api/orders?address=&role=any\|buyer\|seller&status=` | Orders (filtered) |
| GET | `/api/orders/<id>` | One order and its event timeline |
| GET | `/api/history?address=&limit=` | Recent contract events |
| POST | `/api/sync` | Pull new events from the chain now |
| GET | `/api/health` | Service status |

## Project structure

```
contracts/AgriEscrow.sol      Solidity source (0.8.34, EVM cancun, optimizer 200 runs)
static/abi/AgriEscrow.json    Contract ABI (shared by frontend and backend)
static/css/style.css
static/js/app.js
templates/index.html
app.py                        Flask backend
requirements.txt
render.yaml                   Render deployment blueprint
.env.example                  Configuration template
```

## Run locally

Requirements: Python 3.10+ and the MetaMask browser extension.

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # then put your Sepolia RPC URL in .env
python app.py                      # http://127.0.0.1:5000
```

## Deploy on Render

1. Push this folder to a GitHub repository (`.env` and `*.db` are git-ignored).
2. Render → **New → Web Service** → connect the repository.
3. Build command `pip install -r requirements.txt`;
   start command `gunicorn app:app --workers 1 --threads 4 --timeout 60`.
4. Environment variables: `RPC_URL`, `CONTRACT_ADDRESS`, `DEPLOY_BLOCK`, `PYTHON_VERSION=3.12.7`.

The free instance sleeps when idle, so the first request can take up to a minute.

## Contract deployment notes

- Compiled with Solidity 0.8.34, EVM version `cancun`, optimizer enabled (200 runs).
- Constructor: `_arbiter = 0x10Ea1680bf16C6863021879468Db4fBc660C11AD`, `_confirmWindow = 600` s
  (10 minutes, chosen so the timeout path can be demonstrated; a production value would be days).
- Deployment used **10,936,204 gas** on Sepolia versus 1,561,944 gas in Remix VM: the
  Glamsterdam upgrade (activated on Sepolia on 6 Oct 2026, EIP-8037) re-prices state creation
  (code deposit 200 → 1,530 gas/byte). For this reason the frontend never hard-codes gas
  limits — it uses the wallet estimate plus a 20 % margin.

## Security considerations

- Role checks on every state change (`NotBuyer`, `NotSeller`, `NotArbiter`) and a strict state machine (`WrongStatus`).
- Pull-payment withdrawals with checks-effects-interactions and a re-entrancy guard.
- Input validation in the browser, in the API (address/integer checks, bound SQL parameters) and in the contract.
- No private keys on the server; every transaction is signed by the user in MetaMask.
- Only a document **hash** goes on-chain; the document itself never leaves the user's device.

## Limitations

- A single arbiter is trusted to resolve disputes fairly; a dispute stays open until the arbiter acts.
- Order descriptions are public on-chain.
- Sepolia test ETH only; not audited for mainnet use.
