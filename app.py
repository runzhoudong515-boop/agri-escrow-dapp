"""
AgriEscrow - Flask backend
==========================

Responsibilities
----------------
1. Serve the web interface (templates/index.html + static assets).
2. Keep a SQLite cache of the AgriEscrow contract's orders and events, so the
   frontend can list orders and show transaction history quickly - also for
   visitors who have not connected a wallet.
3. Expose a small REST API (/api/...).

How the cache is kept up to date
--------------------------------
* Orders are read directly from the contract (orderCount + getOrder), so the
  order list is always correct and never depends on log scanning.
* When the frontend confirms a transaction it posts the transaction hash to
  /api/tx; the backend decodes that receipt's events immediately.
* A background thread scans the contract's event logs with eth_getLogs. The
  block range per request adapts to the RPC provider's limit (QuickNode's free
  plan only allows 5 blocks), scanning forward for new blocks and backward
  from the newest block towards DEPLOY_BLOCK, so recent history appears first.

Security notes
--------------
* The backend is READ-ONLY. It never holds a private key and never signs a
  transaction. Every state-changing action is signed by the user in MetaMask.
* The blockchain is the single source of truth. SQLite is only a cache and is
  rebuilt automatically if it is deleted (e.g. on a Render redeploy).
* All request parameters are validated; SQL uses bound parameters.

Configuration (environment variables, or a local .env file)
-----------------------------------------------------------
RPC_URL            Sepolia JSON-RPC endpoint (QuickNode / Infura / Alchemy ...)
CONTRACT_ADDRESS   Deployed AgriEscrow address
DEPLOY_BLOCK       Block number of the deployment transaction
DATABASE_PATH      SQLite file (default: escrow.db next to this file)
LOG_CHUNK          Max block range per eth_getLogs request (default: 2000;
                   reduced automatically if the provider rejects it)
SYNC_INTERVAL      Seconds between background syncs once caught up (default: 8)
CALLS_PER_ROUND    Max eth_getLogs calls per sync round (default: 20)
RPC_MAX_RPS        Max RPC requests per second from the backend (default: 4)
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from decimal import Decimal

from flask import Flask, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ABI_PATH = os.path.join(BASE_DIR, "static", "abi", "AgriEscrow.json")

CHAIN_ID = 11155111  # Sepolia
EXPLORER = "https://sepolia.etherscan.io"

STATUS_NAMES = ["None", "Funded", "Shipped", "Completed", "Refunded", "Disputed", "Resolved"]
OPEN_STATUSES = (1, 2, 5)  # Funded, Shipped, Disputed can still change
ORDER_FIELDS = [
    "buyer", "amount", "seller", "status", "upfrontBps", "shipDeadline",
    "createdAt", "shippedAt", "released", "docHash", "product",
]

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
RANGE_ERROR_HINTS = ("413", "too large", "range", "limit", "exceed", "too many", "more than")

log = logging.getLogger("agriescrow")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_dotenv(path: str) -> None:
    """Minimal .env loader for local development (no extra dependency)."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_abi(path: str = ABI_PATH) -> list:
    """Load the ABI exported from Remix (plain array, or an artifact with an 'abi' key)."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict) and "abi" in data:
        data = data["abi"]
    if not isinstance(data, list):
        raise ValueError("ABI file must contain a JSON array")
    return data


def to_plain(value):
    """Convert web3 return values (bytes, AttributeDict, tuples) into JSON-friendly data."""
    if isinstance(value, (bytes, bytearray)):
        return "0x" + bytes(value).hex()
    if isinstance(value, dict):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(v) for v in value]
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2**53:
        return str(value)  # wei amounts exceed JavaScript's safe integer range
    return value


def wei_to_eth(wei) -> str:
    eth = Decimal(int(wei)) / Decimal(10**18)
    text = format(eth.normalize(), "f")
    return text if text != "-0" else "0"


def is_address(value: str | None) -> bool:
    return bool(value) and bool(ADDRESS_RE.match(value))


def is_rate_limited(exc: Exception) -> bool:
    message = str(exc).lower()
    return "429" in message or "too many requests" in message or "rate limit" in message


def is_range_error(exc: Exception) -> bool:
    if is_rate_limited(exc):  # "Too Many Requests" is about speed, not block range
        return False
    message = str(exc).lower()
    return any(hint in message for hint in RANGE_ERROR_HINTS)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------
# Chain access (web3.py) - read only
# ---------------------------------------------------------------------------

class Chain:
    """Thin read-only wrapper around the deployed AgriEscrow contract."""

    def __init__(self, rpc_url: str, address: str, abi: list, max_rps: float = 4.0):
        from web3 import Web3  # imported lazily so the module loads without web3 for tests

        self.Web3 = Web3
        # Client-side rate limit: free RPC plans reject bursts with HTTP 429
        self._min_gap = 1.0 / max_rps if max_rps > 0 else 0.0
        self._rate_lock = threading.Lock()
        self._next_slot = 0.0
        self._immutables = None
        try:
            # No automatic retries: a rejected log range should fail fast so the indexer can adapt
            provider = Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 20},
                                         exception_retry_configuration=None)
        except TypeError:  # older web3 versions
            provider = Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 20})
        self.w3 = Web3(provider)
        self.address = Web3.to_checksum_address(address)
        self.contract = self.w3.eth.contract(address=self.address, abi=abi)

        # topic0 -> event name, computed from the ABI
        self.topics = {}
        for item in abi:
            if item.get("type") == "event":
                signature = "{}({})".format(item["name"], ",".join(i["type"] for i in item["inputs"]))
                self.topics[Web3.to_hex(Web3.keccak(text=signature))] = item["name"]

    def _decode(self, entries) -> list:
        decoded = []
        for entry in entries:
            if str(entry["address"]).lower() != self.address.lower() or not entry["topics"]:
                continue
            name = self.topics.get(self.Web3.to_hex(entry["topics"][0]))
            if not name:
                continue
            event = getattr(self.contract.events, name)().process_log(entry)
            decoded.append({
                "event": name,
                "args": to_plain(dict(event["args"])),
                "block_number": int(entry["blockNumber"]),
                "tx_hash": self.Web3.to_hex(entry["transactionHash"]),
                "log_index": int(entry["logIndex"]),
            })
        return decoded

    def _rpc(self, func, *args, **kwargs):
        """Run one RPC call, spacing calls out to stay under max_rps (shared by all threads)."""
        if self._min_gap:
            with self._rate_lock:
                now = time.monotonic()
                wait = self._next_slot - now
                self._next_slot = max(now, self._next_slot) + self._min_gap
            if wait > 0:
                time.sleep(wait)
        return func(*args, **kwargs)

    def latest_block(self) -> int:
        return int(self._rpc(lambda: self.w3.eth.block_number))

    def block_time(self, number: int) -> int:
        return int(self._rpc(self.w3.eth.get_block, number)["timestamp"])

    def get_logs(self, from_block: int, to_block: int) -> list:
        return self._decode(self._rpc(self.w3.eth.get_logs, {
            "address": self.address,
            "fromBlock": from_block,
            "toBlock": to_block,
        }))

    def receipt_events(self, tx_hash: str) -> list:
        receipt = self._rpc(self.w3.eth.get_transaction_receipt, tx_hash)
        return self._decode(receipt["logs"])

    def order_count(self) -> int:
        return int(self._rpc(self.contract.functions.orderCount().call))

    def get_order(self, order_id: int) -> dict:
        result = self._rpc(self.contract.functions.getOrder(order_id).call)
        return dict(zip(ORDER_FIELDS, to_plain(list(result))))

    def contract_info(self) -> dict:
        fn = self.contract.functions
        if self._immutables is None:  # arbiter and confirmWindow never change
            self._immutables = {
                "arbiter": self._rpc(fn.arbiter().call),
                "confirmWindow": int(self._rpc(fn.confirmWindow().call)),
            }
        return {
            **self._immutables,
            "orderCount": int(self._rpc(fn.orderCount().call)),
            "balanceWei": int(self._rpc(self.w3.eth.get_balance, self.address)),
        }


# ---------------------------------------------------------------------------
# SQLite cache + indexer
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    tx_hash      TEXT    NOT NULL,
    log_index    INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    block_time   INTEGER,
    event        TEXT    NOT NULL,
    order_id     INTEGER,
    account      TEXT,
    args         TEXT    NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_events_order   ON events(order_id);
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account);
CREATE TABLE IF NOT EXISTS orders (
    order_id      INTEGER PRIMARY KEY,
    buyer         TEXT NOT NULL,
    seller        TEXT NOT NULL,
    amount        TEXT NOT NULL,
    upfront_bps   INTEGER NOT NULL,
    ship_deadline INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    shipped_at    INTEGER NOT NULL,
    released      TEXT NOT NULL,
    doc_hash      TEXT NOT NULL,
    product       TEXT NOT NULL,
    status        INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer  ON orders(buyer);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller);
"""


class Indexer:
    """Keeps the SQLite cache in sync with the contract."""

    def __init__(self, chain, db_path: str, deploy_block: int, sync_interval: float = 8.0,
                 log_chunk: int = 2000, calls_per_round: int = 40):
        self.chain = chain
        self.deploy_block = deploy_block
        self.sync_interval = sync_interval
        self.calls_per_round = max(1, calls_per_round)
        self.chunk = max(1, log_chunk)          # current eth_getLogs range
        self.chunk_ceiling = self.chunk         # largest range the provider accepts
        self.background = False
        self.last_error = None
        self.head_block = None
        self._lock = threading.RLock()
        self._last_sync = 0.0
        self._info_cache = None
        self._block_times = {}

        # One SQLite connection per thread (web requests vs. background indexer).
        # WAL mode lets readers see committed data while the indexer is writing.
        self.db_path = db_path
        self._local = threading.local()
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    @property
    def db(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    # -- meta ---------------------------------------------------------------
    def _get_meta(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def _set_meta(self, key: str, value) -> None:
        self.db.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )

    def progress(self) -> dict:
        fwd = self._get_meta("fwd")
        back = self._get_meta("back")
        complete = back is not None and int(back) <= self.deploy_block
        percent = None
        if fwd is not None and back is not None:
            total = max(1, int(fwd) - self.deploy_block + 1)
            percent = round(100 * (int(fwd) - int(back) + 1) / total, 1)
        return {
            "deployBlock": self.deploy_block,
            "newestScanned": int(fwd) if fwd is not None else None,
            "oldestScanned": int(back) if back is not None else None,
            "headBlock": self.head_block,
            "historyComplete": complete,
            "historyPercent": min(100.0, percent) if percent is not None else 0.0,
            "logRange": self.chunk,
        }

    # -- syncing ------------------------------------------------------------
    def sync(self, force: bool = True) -> dict:
        """One sync round: refresh orders, then scan a bounded number of log ranges."""
        if self.chain is None:
            raise ApiError("Backend is not connected to the blockchain (RPC_URL / CONTRACT_ADDRESS missing).", 503)

        with self._lock:
            if not force and time.time() - self._last_sync < self.sync_interval:
                return self.progress()
            try:
                touched = set()
                head = self.chain.latest_block()
                self.head_block = head
                if self._get_meta("fwd") is None:  # first run: start scanning at the current head
                    self._set_meta("fwd", head)
                    self._set_meta("back", head + 1)

                calls = 0
                # 1) forward: follow new blocks
                fwd = int(self._get_meta("fwd"))
                while fwd < head and calls < self.calls_per_round:
                    end = min(fwd + self.chunk, head)
                    calls += 1
                    logs = self._fetch(fwd + 1, end)
                    if logs is None:
                        continue
                    touched |= self._store_events(logs)
                    fwd = end
                    self._set_meta("fwd", fwd)
                    self.db.commit()

                # 2) backward: fill older history down to the deployment block
                back = int(self._get_meta("back"))
                while back > self.deploy_block and calls < self.calls_per_round:
                    start = max(self.deploy_block, back - self.chunk)
                    calls += 1
                    logs = self._fetch(start, back - 1)
                    if logs is None:
                        continue
                    touched |= self._store_events(logs)
                    back = start
                    self._set_meta("back", back)
                    self.db.commit()

                # 3) orders straight from the contract (independent of log scanning)
                self._refresh_orders(touched)
                self.db.commit()

                self._last_sync = time.time()
                self.last_error = None
                result = self.progress()
                result["caughtUp"] = fwd >= head and back <= self.deploy_block
                return result
            except ApiError:
                raise
            except Exception as exc:
                self.db.rollback()
                self.last_error = str(exc)
                log.exception("sync failed")
                raise ApiError("Could not read from the blockchain: {}".format(exc), 502)

    def safe_sync(self) -> None:
        try:
            self.sync(force=False)
        except ApiError:
            pass

    def _fetch(self, start: int, end: int):
        """eth_getLogs for [start, end]. Returns None if the provider rejected the range
        (the range is then reduced for the next attempt)."""
        try:
            logs = self.chain.get_logs(start, end)
        except Exception as exc:
            size = end - start + 1
            if size > 1 and is_range_error(exc):
                self.chunk_ceiling = max(1, size - 1)
                self.chunk = max(1, min(size // 2, self.chunk_ceiling))
                log.info("RPC rejected a %s-block log range; using %s blocks", size, self.chunk)
                return None
            raise
        self.chunk = min(self.chunk * 2, self.chunk_ceiling)
        return logs

    def _block_time(self, number: int) -> int:
        if number not in self._block_times:
            if len(self._block_times) > 5000:
                self._block_times.clear()
            self._block_times[number] = self.chain.block_time(number)
        return self._block_times[number]

    def _store_events(self, logs: list) -> set:
        touched = set()
        for item in logs:
            args = item["args"]
            account = args.get("account")  # only Withdrawn has an account field
            self.db.execute(
                "INSERT OR IGNORE INTO events(tx_hash, log_index, block_number, block_time, event, "
                "order_id, account, args) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item["tx_hash"], item["log_index"], item["block_number"],
                    self._block_time(item["block_number"]), item["event"], args.get("orderId"),
                    account.lower() if account else None, json.dumps(args, default=str),
                ),
            )
            if args.get("orderId") is not None:
                touched.add(int(args["orderId"]))
        return touched

    def _refresh_orders(self, touched: set) -> None:
        count = self.chain.order_count()
        known = {r[0]: r[1] for r in self.db.execute("SELECT order_id, status FROM orders")}
        to_refresh = set(touched)
        for order_id in range(1, count + 1):
            if order_id not in known or known[order_id] in OPEN_STATUSES:
                to_refresh.add(order_id)
        for order_id in sorted(i for i in to_refresh if 1 <= i <= count):
            self._upsert_order(order_id, self.chain.get_order(order_id))

    def _upsert_order(self, order_id: int, o: dict) -> None:
        self.db.execute(
            """INSERT INTO orders(order_id, buyer, seller, amount, upfront_bps, ship_deadline, created_at,
                                  shipped_at, released, doc_hash, product, status, updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(order_id) DO UPDATE SET
                 status = excluded.status, shipped_at = excluded.shipped_at,
                 released = excluded.released, doc_hash = excluded.doc_hash,
                 updated_at = excluded.updated_at""",
            (
                order_id, o["buyer"].lower(), o["seller"].lower(), str(o["amount"]), int(o["upfrontBps"]),
                int(o["shipDeadline"]), int(o["createdAt"]), int(o["shippedAt"]), str(o["released"]),
                o["docHash"], o["product"], int(o["status"]), int(time.time()),
            ),
        )

    def ingest_tx(self, tx_hash: str) -> dict:
        """Decode a confirmed transaction's events immediately (called by the frontend)."""
        if self.chain is None:
            raise ApiError("Backend is not connected to the blockchain.", 503)
        with self._lock:
            try:
                logs = self.chain.receipt_events(tx_hash)
                touched = self._store_events(logs)
                for order_id in touched:
                    self._upsert_order(order_id, self.chain.get_order(order_id))
                self.db.commit()
                self._info_cache = None
                return {"events": len(logs), "ordersUpdated": sorted(touched)}
            except Exception as exc:
                self.db.rollback()
                raise ApiError("Could not read transaction {}: {}".format(tx_hash, exc), 502)

    def start_background(self) -> None:
        """Run sync rounds in a daemon thread: fast while catching up, slower once caught up."""
        if self.chain is None or self.background:
            return
        self.background = True

        def loop():
            while True:
                delay = self.sync_interval
                try:
                    if not self.sync(force=True).get("caughtUp"):
                        delay = 1.0
                except Exception as exc:
                    # back off harder when the provider is rate limiting us
                    delay = 30 if is_rate_limited(exc) else max(self.sync_interval, 15)
                time.sleep(delay)

        threading.Thread(target=loop, name="indexer", daemon=True).start()

    # -- contract-level info (cached) ----------------------------------------
    def contract_info(self):
        if self.chain is None:
            return None
        now = time.time()
        if self._info_cache and now - self._info_cache[0] < max(15.0, self.sync_interval):
            return self._info_cache[1]
        try:
            info = self.chain.contract_info()
            self._info_cache = (now, info)
            return info
        except Exception as exc:
            log.warning("contract_info failed: %s", exc)
            return self._info_cache[1] if self._info_cache else None

    # -- queries --------------------------------------------------------------
    def order_to_json(self, row: sqlite3.Row, confirm_window) -> dict:
        shipped_at = row["shipped_at"]
        return {
            "id": row["order_id"],
            "product": row["product"],
            "buyer": row["buyer"],
            "seller": row["seller"],
            "amountWei": row["amount"],
            "amountEth": wei_to_eth(row["amount"]),
            "upfrontBps": row["upfront_bps"],
            "upfrontEth": wei_to_eth(int(row["amount"]) * row["upfront_bps"] // 10_000),
            "releasedWei": row["released"],
            "status": row["status"],
            "statusName": STATUS_NAMES[row["status"]] if 0 <= row["status"] < len(STATUS_NAMES) else "Unknown",
            "createdAt": row["created_at"],
            "shipDeadline": row["ship_deadline"],
            "shippedAt": shipped_at,
            "confirmDeadline": shipped_at + confirm_window if shipped_at and confirm_window else None,
            "docHash": row["doc_hash"] if int(row["doc_hash"], 16) != 0 else None,
        }

    def list_orders(self, address, role: str, status, confirm_window) -> list:
        sql = "SELECT * FROM orders WHERE 1 = 1"
        params = []
        if address:
            addr = address.lower()
            if role == "buyer":
                sql += " AND buyer = ?"
                params.append(addr)
            elif role == "seller":
                sql += " AND seller = ?"
                params.append(addr)
            else:
                sql += " AND (buyer = ? OR seller = ?)"
                params.extend([addr, addr])
        if status is not None:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY order_id DESC"
        return [self.order_to_json(r, confirm_window) for r in self.db.execute(sql, params)]

    def get_order(self, order_id: int, confirm_window):
        row = self.db.execute("SELECT * FROM orders WHERE order_id = ?", (order_id,)).fetchone()
        return self.order_to_json(row, confirm_window) if row else None

    def history(self, address=None, order_id=None, limit: int = 50) -> list:
        sql = ("SELECT e.*, o.buyer, o.seller, o.product FROM events e "
               "LEFT JOIN orders o ON o.order_id = e.order_id WHERE 1 = 1")
        params = []
        if order_id is not None:
            sql += " AND e.order_id = ?"
            params.append(order_id)
        if address:
            addr = address.lower()
            sql += " AND (o.buyer = ? OR o.seller = ? OR e.account = ?)"
            params.extend([addr, addr, addr])
        sql += " ORDER BY e.block_number DESC, e.log_index DESC LIMIT ?"
        params.append(limit)

        return [{
            "event": r["event"],
            "orderId": r["order_id"],
            "product": r["product"],
            "args": json.loads(r["args"]),
            "blockNumber": r["block_number"],
            "timestamp": r["block_time"],
            "txHash": r["tx_hash"],
            "txUrl": "{}/tx/{}".format(EXPLORER, r["tx_hash"]),
        } for r in self.db.execute(sql, params)]

    def stats(self) -> dict:
        rows = self.db.execute("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").fetchall()
        by_status = {STATUS_NAMES[r["status"]]: r["n"] for r in rows}
        total_wei = sum(int(r["amount"]) for r in self.db.execute("SELECT amount FROM orders"))
        return {
            "totalOrders": sum(by_status.values()),
            "byStatus": by_status,
            "totalVolumeWei": str(total_wei),
            "totalVolumeEth": wei_to_eth(total_wei),
            "eventsIndexed": self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            "indexing": self.progress(),
        }


# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------

def create_app(chain=None, db_path=None, contract_address=None, deploy_block=None,
               start_background=True) -> Flask:
    load_dotenv(os.path.join(BASE_DIR, ".env"))

    contract_address = contract_address or os.environ.get("CONTRACT_ADDRESS", "")
    deploy_block = deploy_block if deploy_block is not None else int(os.environ.get("DEPLOY_BLOCK", "0") or 0)
    db_path = db_path or os.environ.get("DATABASE_PATH", os.path.join(BASE_DIR, "escrow.db"))

    if chain is None:
        rpc_url = os.environ.get("RPC_URL", "")
        if rpc_url and is_address(contract_address):
            try:
                chain = Chain(rpc_url, contract_address, load_abi(),
                              max_rps=float(os.environ.get("RPC_MAX_RPS", "4")))
            except Exception:
                log.exception("Could not initialise web3 connection")
        else:
            log.warning("RPC_URL or CONTRACT_ADDRESS not set - running without blockchain access")

    indexer = Indexer(
        chain, db_path, deploy_block,
        sync_interval=float(os.environ.get("SYNC_INTERVAL", "8")),
        log_chunk=int(os.environ.get("LOG_CHUNK", "2000")),
        calls_per_round=int(os.environ.get("CALLS_PER_ROUND", "20")),
    )
    if start_background:
        indexer.start_background()

    app = Flask(__name__)
    app.config["INDEXER"] = indexer

    public_config = {
        "contractAddress": contract_address,
        "chainId": CHAIN_ID,
        "chainIdHex": hex(CHAIN_ID),
        "chainName": "Sepolia",
        "explorer": EXPLORER,
        "deployBlock": deploy_block,
        "abiUrl": "/static/abi/AgriEscrow.json",
    }

    def maybe_sync():
        if not indexer.background:  # without the background thread, sync on demand
            indexer.safe_sync()

    def confirm_window():
        info = indexer.contract_info()
        return info["confirmWindow"] if info else None

    def parse_address_param(name: str = "address"):
        value = request.args.get(name, "").strip()
        if not value:
            return None
        if not is_address(value):
            raise ApiError("Invalid Ethereum address: '{}'".format(value))
        return value

    def parse_int_param(name: str, default=None, minimum=None, maximum=None):
        raw = request.args.get(name, "").strip()
        if raw == "":
            return default
        if not raw.isdigit():
            raise ApiError("'{}' must be a non-negative integer".format(name))
        value = int(raw)
        if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
            raise ApiError("'{}' must be between {} and {}".format(name, minimum, maximum))
        return value

    # -- error handling -------------------------------------------------------
    @app.errorhandler(ApiError)
    def handle_api_error(err: ApiError):
        return jsonify({"error": err.message}), err.status

    @app.errorhandler(404)
    def not_found(_err):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Not found"}), 404
        return render_template("index.html", config=public_config), 404

    @app.errorhandler(500)
    def server_error(_err):
        return jsonify({"error": "Internal server error"}), 500

    # -- pages ----------------------------------------------------------------
    @app.get("/")
    def index():
        return render_template("index.html", config=public_config)

    # -- API ------------------------------------------------------------------
    @app.get("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "chainConnected": indexer.chain is not None,
            "indexing": indexer.progress(),
            "lastError": indexer.last_error,
        })

    @app.get("/api/config")
    def config():
        info = indexer.contract_info() or {}
        return jsonify({
            **public_config,
            "arbiter": info.get("arbiter"),
            "confirmWindow": info.get("confirmWindow"),
            "chainConnected": indexer.chain is not None,
        })

    @app.get("/api/stats")
    def stats():
        maybe_sync()
        data = indexer.stats()
        info = indexer.contract_info()
        if info:
            data["lockedWei"] = str(info["balanceWei"])
            data["lockedEth"] = wei_to_eth(info["balanceWei"])
            data["onChainOrderCount"] = info["orderCount"]
        return jsonify(data)

    @app.get("/api/orders")
    def orders():
        address = parse_address_param()
        role = request.args.get("role", "any")
        if role not in ("any", "buyer", "seller"):
            raise ApiError("'role' must be one of: any, buyer, seller")
        status_name = request.args.get("status", "").strip()
        status = None
        if status_name:
            if status_name not in STATUS_NAMES[1:]:
                raise ApiError("'status' must be one of: {}".format(", ".join(STATUS_NAMES[1:])))
            status = STATUS_NAMES.index(status_name)
        maybe_sync()
        return jsonify({
            "orders": indexer.list_orders(address, role, status, confirm_window()),
            "indexing": indexer.progress(),
            "syncError": indexer.last_error,
        })

    @app.get("/api/orders/<int:order_id>")
    def order_detail(order_id: int):
        maybe_sync()
        order = indexer.get_order(order_id, confirm_window())
        if order is None:
            raise ApiError("Order #{} not found".format(order_id), 404)
        return jsonify({"order": order, "history": indexer.history(order_id=order_id, limit=100)})

    @app.get("/api/history")
    def history():
        address = parse_address_param()
        limit = parse_int_param("limit", default=50, minimum=1, maximum=200)
        maybe_sync()
        return jsonify({"history": indexer.history(address=address, limit=limit),
                        "indexing": indexer.progress(),
                        "syncError": indexer.last_error})

    @app.post("/api/tx")
    def ingest_tx():
        payload = request.get_json(silent=True) or {}
        tx_hash = str(payload.get("hash", "")).strip()
        if not TX_HASH_RE.match(tx_hash):
            raise ApiError("'hash' must be a 0x-prefixed 32-byte transaction hash")
        return jsonify(indexer.ingest_tx(tx_hash))

    @app.post("/api/sync")
    def force_sync():
        return jsonify(indexer.sync(force=True))

    return app


app = create_app()

if __name__ == "__main__":
    # use_reloader=False so the background indexer thread is started only once
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=True, use_reloader=False)
