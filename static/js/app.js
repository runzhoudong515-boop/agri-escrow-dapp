/* AgriEscrow frontend
 *
 * - Reads orders, statistics and history from the Flask backend (/api/...),
 *   so visitors can browse without a wallet.
 * - Sends every state-changing transaction through MetaMask (ethers.js v6).
 *   The backend never sees a private key.
 * - Before asking the wallet to sign, each call is simulated with
 *   estimateGas(): if the contract would revert, the custom error is decoded
 *   and shown to the user without spending gas.
 */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const STATUS = ["None", "Funded", "Shipped", "Completed", "Refunded", "Disputed", "Resolved"];
  const REFRESH_MS = 30000;

  // Human-readable messages for the contract's custom errors
  const ERROR_TEXT = {
    InvalidSeller: "The seller address is invalid or is your own address.",
    ArbiterCannotTrade: "The arbiter account cannot act as buyer or seller.",
    InvalidAmount: "The amount must be greater than 0.",
    InvalidProduct: "The product description must be 1–64 bytes long.",
    UpfrontTooHigh: "The upfront share cannot exceed 50%.",
    InvalidShipWindow: "The shipping window must be between 1 minute and 90 days.",
    OrderNotFound: "This order does not exist.",
    NotBuyer: "Only the buyer of this order can do this.",
    NotSeller: "Only the seller of this order can do this.",
    NotArbiter: "Only the arbiter can resolve disputes.",
    WrongStatus: "This action is not allowed in the order's current status.",
    ShipDeadlinePassed: "The shipping deadline has already passed.",
    ShipDeadlineNotReached: "The shipping deadline has not passed yet — a refund is not available.",
    ConfirmWindowClosed: "The confirmation window has closed — a dispute can no longer be raised.",
    ConfirmWindowOpen: "The buyer's confirmation window is still open.",
    EmptyDocHash: "A document hash is required.",
    InvalidReason: "The dispute reason must be 1–200 bytes long.",
    InvalidSplit: "The buyer share must be between 0% and 100%.",
    NothingToWithdraw: "You have nothing to withdraw.",
    TransferFailed: "The ETH transfer failed.",
    Reentrancy: "Re-entrant call blocked.",
    InvalidArbiter: "Invalid arbiter address.",
    InvalidConfirmWindow: "Invalid confirmation window.",
  };

  const state = {
    abi: null,
    provider: null,
    signer: null,
    contract: null,
    account: null,
    chainOk: false,
    arbiter: null,
    confirmWindow: null,
    orders: [],
    filter: "all",
    actionOrder: null,
  };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ utils
  const lower = (a) => (a ? String(a).toLowerCase() : "");
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");
  const utf8Len = (s) => new TextEncoder().encode(s).length;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const isMe = (a) => !!state.account && lower(a) === lower(state.account);
  const isArbiter = () => !!state.account && !!state.arbiter && lower(state.account) === lower(state.arbiter);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtEth(wei, digits = 6) {
    try {
      const text = ethers.formatEther(BigInt(String(wei)));
      const [whole, frac = ""] = text.split(".");
      const trimmed = frac.slice(0, digits).replace(/0+$/, "");
      return trimmed ? `${whole}.${trimmed}` : whole;
    } catch {
      return String(wei);
    }
  }

  function fmtTime(ts) {
    if (!ts) return "–";
    return new Date(ts * 1000).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function countdownHtml(ts) {
    const left = ts - nowSec();
    return `<span class="cd" data-ts="${ts}" data-live="${left > 0 ? 1 : 0}">${left > 0 ? `in ${fmtDuration(left)}` : "passed"}</span>`;
  }

  function txLink(hash) {
    return `<a href="${CFG.explorer}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`;
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ------------------------------------------------------------------ UI feedback
  function banner(kind, html) {
    const el = $("banner");
    if (!html) { el.classList.add("hidden"); return; }
    el.className = `banner ${kind}`;
    el.innerHTML = html;
  }

  function toast(kind, title, body, timeout = 6000) {
    const el = document.createElement("div");
    $("toasts").appendChild(el);
    updateToast(el, kind, title, body, timeout);
    return el;
  }

  function updateToast(el, kind, title, body, timeout = 0) {
    el.className = `toast ${kind}`;
    el.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${body}</div>`;
    clearTimeout(el._timer);
    if (timeout) el._timer = setTimeout(() => el.remove(), timeout);
  }

  function setLoading(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle("loading", on);
  }

  // ------------------------------------------------------------------ errors
  function findRevertData(err) {
    const candidates = [err?.data, err?.error?.data, err?.info?.error?.data, err?.info?.error?.data?.data];
    return candidates.find((d) => typeof d === "string" && d.startsWith("0x") && d.length >= 10) || null;
  }

  function explainError(err) {
    if (!err) return "Unknown error";
    if (err.code === "ACTION_REJECTED" || err?.info?.error?.code === 4001 || err.code === 4001) {
      return "You rejected the request in MetaMask.";
    }
    if (err.code === "INSUFFICIENT_FUNDS") {
      return "Not enough Sepolia ETH to cover the amount plus gas.";
    }

    let name = err.revert?.name;
    let args = err.revert?.args;
    if (!name && state.contract) {
      const data = findRevertData(err);
      if (data) {
        try {
          const parsed = state.contract.interface.parseError(data);
          if (parsed) { name = parsed.name; args = parsed.args; }
        } catch { /* not one of our errors */ }
      }
    }
    if (name) {
      let text = ERROR_TEXT[name] || name;
      if (name === "WrongStatus" && args && args.length) text += ` (current status: ${STATUS[Number(args[0])]})`;
      return `${escapeHtml(text)} <span class="mono muted">[${escapeHtml(name)}]</span>`;
    }
    return escapeHtml(err.shortMessage || err.reason || err.message || String(err));
  }

  // ------------------------------------------------------------------ wallet
  function updateNetworkPill() {
    const pill = $("networkPill");
    if (!state.provider) {
      pill.className = "pill pill-muted";
      pill.textContent = "Not connected";
      pill.onclick = null;
    } else if (state.chainOk) {
      pill.className = "pill pill-ok";
      pill.textContent = "Sepolia";
      pill.onclick = null;
    } else {
      pill.className = "pill pill-bad";
      pill.textContent = "Wrong network – switch";
      pill.onclick = switchNetwork;
    }
  }

  function updateAccountChip() {
    const connected = !!state.account;
    $("accountChip").classList.toggle("hidden", !connected);
    $("connectBtn").classList.toggle("hidden", connected);
    if (!connected) return;
    $("accountAddr").textContent = short(state.account);
    $("accountAddr").title = state.account;
    const tag = $("roleTag");
    tag.textContent = isArbiter() ? "Arbiter" : "Trader";
    tag.classList.toggle("arbiter", isArbiter());

    // The arbiter cannot trade: disable the order form for that account
    const form = $("createForm");
    [...form.elements].forEach((el) => { el.disabled = isArbiter(); });
    $("createError").textContent = isArbiter() ? "The arbiter account cannot create orders. Switch to a buyer account in MetaMask." : "";
  }

  async function switchNetwork() {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.chainIdHex }] });
    } catch (err) {
      if (err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: CFG.chainIdHex,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.sepolia.org"],
            blockExplorerUrls: [CFG.explorer],
          }],
        });
      } else {
        toast("error", "Network switch failed", explainError(err));
      }
    }
  }

  async function connect(requestAccess = true) {
    if (!window.ethereum) {
      toast("error", "MetaMask not found", "Install the MetaMask browser extension to send transactions.");
      return;
    }
    const btn = $("connectBtn");
    setLoading(btn, true);
    try {
      if (requestAccess) await window.ethereum.request({ method: "eth_requestAccounts" });
      state.provider = new ethers.BrowserProvider(window.ethereum);
      const network = await state.provider.getNetwork();
      state.chainOk = Number(network.chainId) === Number(CFG.chainId);
      updateNetworkPill();

      state.signer = await state.provider.getSigner();
      state.account = await state.signer.getAddress();
      state.contract = new ethers.Contract(CFG.contractAddress, state.abi, state.signer);

      if (!state.chainOk) {
        banner("warn", "MetaMask is on the wrong network. Click the red <strong>Wrong network</strong> pill to switch to Sepolia.");
      } else {
        banner(null);
        if (!state.arbiter) state.arbiter = await state.contract.arbiter();
        if (!state.confirmWindow) state.confirmWindow = Number(await state.contract.confirmWindow());
      }
      updateAccountChip();
      await refreshWallet();
      renderOrders();
      loadHistory();
    } catch (err) {
      toast("error", "Wallet connection failed", explainError(err));
    } finally {
      setLoading(btn, false);
    }
  }

  function disconnect() {
    Object.assign(state, { provider: null, signer: null, contract: null, account: null, chainOk: false });
    updateNetworkPill();
    updateAccountChip();
    $("pendingAmount").textContent = "–";
    $("withdrawBtn").disabled = true;
    renderOrders();
  }

  function walletReady() {
    if (!state.account) { toast("error", "Wallet not connected", "Connect MetaMask first."); return false; }
    if (!state.chainOk) { toast("error", "Wrong network", "Switch MetaMask to the Sepolia testnet."); return false; }
    return true;
  }

  async function refreshWallet() {
    if (!state.account || !state.chainOk) return;
    try {
      const [balance, pending] = await Promise.all([
        state.provider.getBalance(state.account),
        state.contract.pendingWithdrawals(state.account),
      ]);
      $("accountBal").textContent = `${fmtEth(balance, 4)} ETH`;
      $("pendingAmount").textContent = `${fmtEth(pending)} ETH`;
      $("withdrawBtn").disabled = pending === 0n;
    } catch (err) {
      console.warn("refreshWallet", err);
    }
  }

  // ------------------------------------------------------------------ transactions
  /**
   * Simulate (estimateGas) -> sign in MetaMask -> wait for 1 confirmation -> resync.
   * The gas limit is the wallet estimate + 20%, never a hard-coded value, because
   * gas costs change across network upgrades (e.g. Glamsterdam on Sepolia).
   */
  async function sendTx(label, method, args, overrides = {}, btn = null) {
    if (!walletReady()) return null;
    const note = toast("pending", label, "Checking the transaction…", 0);
    setLoading(btn, true);
    try {
      const fn = state.contract.getFunction(method);
      const estimate = await fn.estimateGas(...args, overrides);
      updateToast(note, "pending", label, "Please confirm in MetaMask…");
      const tx = await fn(...args, { ...overrides, gasLimit: (estimate * 120n) / 100n });
      updateToast(note, "pending", label, `Submitted ${txLink(tx.hash)} — waiting for confirmation…`);
      const receipt = await tx.wait();
      updateToast(note, "success", `${label} ✓`,
        `Confirmed in block ${receipt.blockNumber} · ${txLink(tx.hash)}`, 10000);
      try {
        // Let the backend decode this receipt right away (no need to wait for log scanning)
        await api("/api/tx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash: tx.hash }),
        });
      } catch (e) { console.warn("ingest tx", e); }
      await refreshAll();
      return receipt;
    } catch (err) {
      updateToast(note, "error", `${label} failed`, explainError(err), 12000);
      return null;
    } finally {
      setLoading(btn, false);
    }
  }

  // ------------------------------------------------------------------ create order
  function updateProductBytes() {
    $("productBytes").textContent = utf8Len($("fProduct").value);
  }

  async function onCreateOrder(event) {
    event.preventDefault();
    const errorEl = $("createError");
    errorEl.textContent = "";
    if (!walletReady()) return;

    const seller = $("fSeller").value.trim();
    const product = $("fProduct").value.trim();
    const amountText = $("fAmount").value.trim();
    const upfrontPct = Number($("fUpfront").value);
    const shipWindow = Number($("fWindow").value);

    // Client-side validation (the contract re-checks everything)
    let value;
    if (!ethers.isAddress(seller)) return (errorEl.textContent = "Enter a valid seller address (0x + 40 hex characters).");
    if (isMe(seller)) return (errorEl.textContent = "You cannot create an order with yourself as the seller.");
    if (state.arbiter && lower(seller) === lower(state.arbiter)) return (errorEl.textContent = "The arbiter cannot be the seller.");
    const bytes = utf8Len(product);
    if (bytes < 1 || bytes > 64) return (errorEl.textContent = "Product description must be 1–64 bytes.");
    try { value = ethers.parseEther(amountText || "0"); } catch { return (errorEl.textContent = "Enter a valid ETH amount."); }
    if (value <= 0n) return (errorEl.textContent = "Amount must be greater than 0.");
    if (!(upfrontPct >= 0 && upfrontPct <= 50)) return (errorEl.textContent = "Upfront share must be 0–50%.");
    const balance = await state.provider.getBalance(state.account);
    if (value >= balance) return (errorEl.textContent = `Insufficient balance: you have ${fmtEth(balance, 4)} ETH (gas is also needed).`);

    const receipt = await sendTx(
      `Create order (${fmtEth(value)} ETH)`,
      "createOrder",
      [ethers.getAddress(seller), product, upfrontPct * 100, shipWindow],
      { value },
      $("createBtn"),
    );
    if (receipt) {
      $("createForm").reset();
      updateProductBytes();
    }
  }

  // ------------------------------------------------------------------ data loading
  async function loadStats() {
    try {
      const s = await api("/api/stats");
      $("statOrders").textContent = s.totalOrders ?? 0;
      $("statLocked").textContent = s.lockedWei !== undefined ? `${fmtEth(s.lockedWei, 4)} ETH` : "–";
      $("statCompleted").textContent = (s.byStatus?.Completed || 0) + (s.byStatus?.Resolved || 0);
      $("statDisputes").textContent = s.byStatus?.Disputed || 0;
    } catch (err) {
      console.warn("stats", err);
    }
  }

  async function loadOrders() {
    try {
      const data = await api("/api/orders");
      state.orders = data.orders || [];
      showIndexing(data.indexing);
      if (data.syncError) banner("warn", `Showing cached data — the backend could not reach the blockchain: ${escapeHtml(data.syncError)}`);
      else if ($("banner").textContent.startsWith("Showing cached data")) banner(null);
      renderOrders();
      fillVerifySelect();
    } catch (err) {
      $("ordersList").innerHTML = `<p class="empty">Could not load orders: ${escapeHtml(err.message)}</p>`;
    }
  }

  function showIndexing(ix) {
    if (!ix || ix.newestScanned == null) { $("syncInfo").textContent = ""; return; }
    $("syncInfo").textContent = ix.historyComplete
      ? `History indexed to block ${ix.newestScanned}`
      : `Indexing history… ${ix.historyPercent}% (blocks ${ix.oldestScanned}–${ix.newestScanned})`;
  }

  async function loadHistory() {
    const mine = $("historyMine").checked && state.account;
    const query = mine ? `?address=${state.account}` : "";
    try {
      const data = await api(`/api/history${query}`);
      renderHistory(data.history || []);
    } catch (err) {
      $("historyBody").innerHTML = `<tr><td colspan="5" class="empty">Could not load history: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function refreshAll() {
    await Promise.all([loadStats(), loadOrders(), loadHistory(), refreshWallet()]);
  }

  // ------------------------------------------------------------------ rendering: orders
  function progressHtml(status) {
    const map = {
      1: ["done", "", ""],
      2: ["done", "done", ""],
      3: ["done", "done", "done"],
      4: ["done", "bad", "bad"],
      5: ["done", "done", "warn"],
      6: ["done", "done", "done"],
    };
    const steps = map[status] || ["", "", ""];
    return `<div class="progress" title="Funded → Shipped → Settled">${steps.map((c) => `<span class="${c}"></span>`).join("")}</div>`;
  }

  function actionsFor(o) {
    if (!state.account || !state.chainOk) return { buttons: [], note: "" };
    const t = nowSec();
    const buttons = [];
    let note = "";
    const buyer = isMe(o.buyer), seller = isMe(o.seller);

    if (o.status === 1) { // Funded
      if (seller) {
        if (t <= o.shipDeadline) buttons.push(["ship", "Mark shipped", "btn-primary"]);
        buttons.push(["reject", "Reject order", ""]);
        if (t > o.shipDeadline) note = "The shipping deadline has passed — the buyer can reclaim the funds.";
      }
      if (buyer) {
        if (t > o.shipDeadline) buttons.push(["refund", "Claim refund", "btn-primary"]);
        else note = "Waiting for the seller to ship.";
      }
    } else if (o.status === 2) { // Shipped
      const windowOpen = o.confirmDeadline && t <= o.confirmDeadline;
      if (buyer) {
        buttons.push(["confirm", "Confirm receipt", "btn-primary"]);
        if (windowOpen) buttons.push(["dispute", "Raise dispute", "btn-danger"]);
        else note = "The confirmation window has closed — the seller may now claim the balance.";
      }
      if (seller) {
        if (!windowOpen) buttons.push(["timeout", "Claim balance (timeout)", "btn-primary"]);
        else note = "Waiting for the buyer to confirm receipt.";
      }
    } else if (o.status === 5) { // Disputed
      if (isArbiter()) buttons.push(["resolve", "Resolve dispute", "btn-primary"]);
      else if (buyer || seller) note = "Waiting for the arbiter's decision.";
    } else if ((o.status === 3 || o.status === 4 || o.status === 6) && (buyer || seller)) {
      note = "Settled. Any amount owed to you is in your escrow balance — use Withdraw.";
    }
    return { buttons, note };
  }

  function orderCard(o) {
    const { buttons, note } = actionsFor(o);
    const you = (a) => (isMe(a) ? '<span class="you">you</span>' : "");
    const meta = [
      ["Buyer", `<span class="mono" title="${o.buyer}">${short(o.buyer)}</span>${you(o.buyer)}`],
      ["Seller", `<span class="mono" title="${o.seller}">${short(o.seller)}</span>${you(o.seller)}`],
      ["Upfront on shipment", `${o.upfrontBps / 100}% · ${o.upfrontEth} ETH`],
      ["Created", fmtTime(o.createdAt)],
    ];
    if (o.status === 1) meta.push(["Ship deadline", `${fmtTime(o.shipDeadline)} · ${countdownHtml(o.shipDeadline)}`]);
    if (o.shippedAt) meta.push(["Shipped", fmtTime(o.shippedAt)]);
    if (o.status === 2 && o.confirmDeadline) meta.push(["Confirm by", `${fmtTime(o.confirmDeadline)} · ${countdownHtml(o.confirmDeadline)}`]);
    if (o.docHash) meta.push(["Document hash", `<span class="mono" title="${o.docHash}">${short(o.docHash)}</span>`]);

    return `
      <article class="order" data-id="${o.id}">
        <div class="order-top">
          <div>
            <p class="order-title"><span class="order-id">#${o.id}</span>${escapeHtml(o.product)}</p>
            <span class="badge badge-${o.statusName}">${o.statusName}</span>
          </div>
          <span class="order-amount">${o.amountEth} ETH</span>
        </div>
        ${progressHtml(o.status)}
        <dl class="order-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
        ${note ? `<p class="order-note">${note}</p>` : ""}
        <div class="order-actions">
          ${buttons.map(([act, text, cls]) => `<button class="btn btn-sm ${cls}" data-action="${act}" data-id="${o.id}">${text}</button>`).join("")}
          <button class="btn btn-sm btn-ghost" data-action="history" data-id="${o.id}">History</button>
        </div>
        <div class="order-timeline" id="tl-${o.id}"></div>
      </article>`;
  }

  function renderOrders() {
    const list = $("ordersList");
    let orders = state.orders;
    const f = state.filter;
    if ((f === "buyer" || f === "seller") && !state.account) {
      list.innerHTML = '<p class="empty">Connect your wallet to see your orders.</p>';
      return;
    }
    if (f === "buyer") orders = orders.filter((o) => isMe(o.buyer));
    if (f === "seller") orders = orders.filter((o) => isMe(o.seller));
    if (f === "disputes") orders = orders.filter((o) => o.status === 5 || o.status === 6);

    list.innerHTML = orders.length
      ? orders.map(orderCard).join("")
      : '<p class="empty">No orders here yet.</p>';
  }

  async function toggleTimeline(id) {
    const box = $(`tl-${id}`);
    if (box.innerHTML) { box.innerHTML = ""; return; }
    box.innerHTML = '<p class="order-note">Loading…</p>';
    try {
      const data = await api(`/api/orders/${id}`);
      const items = [...data.history].reverse();
      box.innerHTML = `<ul class="timeline">${items.map((h) =>
        `<li><strong>${eventLabel(h.event)}</strong> · ${fmtTime(h.timestamp)} · ${txLink(h.txHash)}<br><span class="muted">${describeEvent(h)}</span></li>`
      ).join("")}</ul>`;
    } catch (err) {
      box.innerHTML = `<p class="order-note">${escapeHtml(err.message)}</p>`;
    }
  }

  // ------------------------------------------------------------------ rendering: history
  function eventLabel(name) {
    return {
      OrderCreated: "Order created",
      OrderShipped: "Shipped",
      OrderCompleted: "Completed",
      OrderRefunded: "Refunded",
      DisputeRaised: "Dispute raised",
      DisputeResolved: "Dispute resolved",
      Withdrawn: "Withdrawal",
    }[name] || name;
  }

  function describeEvent(h) {
    const a = h.args || {};
    switch (h.event) {
      case "OrderCreated":
        return `${fmtEth(a.amount)} ETH locked by ${short(a.buyer)} · ${a.upfrontBps / 100}% upfront`;
      case "OrderShipped":
        return `Document ${short(a.docHash)} anchored · ${fmtEth(a.upfrontReleased)} ETH released to seller`;
      case "OrderCompleted":
        return `${fmtEth(a.sellerAmount)} ETH released to seller${a.byTimeout ? " (buyer timeout)" : ""}`;
      case "OrderRefunded":
        return `${fmtEth(a.buyerAmount)} ETH refunded · ${a.rejectedBySeller ? "rejected by seller" : "shipping deadline missed"}`;
      case "DisputeRaised":
        return `“${escapeHtml(a.reason)}”`;
      case "DisputeResolved":
        return `Buyer ${fmtEth(a.buyerAmount)} ETH · Seller ${fmtEth(a.sellerAmount)} ETH`;
      case "Withdrawn":
        return `${short(a.account)} withdrew ${fmtEth(a.amount)} ETH`;
      default:
        return "";
    }
  }

  function renderHistory(items) {
    const body = $("historyBody");
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No transactions yet.</td></tr>';
      return;
    }
    body.innerHTML = items.map((h) => `
      <tr>
        <td>${fmtTime(h.timestamp)}</td>
        <td class="ev">${eventLabel(h.event)}</td>
        <td>${h.orderId ? `#${h.orderId} ${escapeHtml(h.product || "")}` : "–"}</td>
        <td>${describeEvent(h)}</td>
        <td>${txLink(h.txHash)}</td>
      </tr>`).join("");
  }

  // ------------------------------------------------------------------ order actions
  const findOrder = (id) => state.orders.find((o) => o.id === Number(id));

  function onOrderAction(event) {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const order = findOrder(id);
    switch (btn.dataset.action) {
      case "history": return toggleTimeline(id);
      case "ship": return openShip(order);
      case "reject":
        if (confirm(`Reject order #${id}? The buyer will be refunded in full.`)) sendTx(`Reject order #${id}`, "rejectOrder", [id], {}, btn);
        return;
      case "refund": return sendTx(`Claim refund #${id}`, "claimRefund", [id], {}, btn);
      case "confirm":
        if (confirm(`Confirm that order #${id} arrived as agreed? The remaining funds will be released to the seller.`)) {
          sendTx(`Confirm receipt #${id}`, "confirmReceipt", [id], {}, btn);
        }
        return;
      case "dispute": return openDispute(order);
      case "timeout": return sendTx(`Claim balance #${id}`, "claimAfterTimeout", [id], {}, btn);
      case "resolve": return openResolve(order);
      default: return undefined;
    }
  }

  // Ship dialog: hash a file (keccak-256 of its bytes) or a reference number
  let shipHash = null;

  function openShip(order) {
    state.actionOrder = order;
    shipHash = null;
    $("shipOrderId").textContent = `#${order.id}`;
    $("shipFile").value = "";
    $("shipText").value = "";
    $("shipHash").textContent = "";
    $("shipError").textContent = "";
    $("shipDialog").showModal();
  }

  async function updateShipHash() {
    const file = $("shipFile").files[0];
    const text = $("shipText").value.trim();
    if (file) shipHash = ethers.keccak256(new Uint8Array(await file.arrayBuffer()));
    else if (text) shipHash = ethers.id(text);
    else shipHash = null;
    $("shipHash").textContent = shipHash ? `keccak-256: ${shipHash}` : "";
  }

  async function onShipConfirm(event) {
    event.preventDefault();
    await updateShipHash();
    if (!shipHash) { $("shipError").textContent = "Attach a document or enter a reference number."; return; }
    $("shipDialog").close();
    const o = state.actionOrder;
    sendTx(`Mark shipped #${o.id}`, "markShipped", [o.id, shipHash]);
  }

  function openDispute(order) {
    state.actionOrder = order;
    $("disputeOrderId").textContent = `#${order.id}`;
    $("disputeReason").value = "";
    $("reasonBytes").textContent = "0";
    $("disputeError").textContent = "";
    $("disputeDialog").showModal();
  }

  function onDisputeConfirm(event) {
    event.preventDefault();
    const reason = $("disputeReason").value.trim();
    const bytes = utf8Len(reason);
    if (bytes < 1 || bytes > 200) { $("disputeError").textContent = "The reason must be 1–200 bytes."; return; }
    $("disputeDialog").close();
    const o = state.actionOrder;
    sendTx(`Raise dispute #${o.id}`, "raiseDispute", [o.id, reason]);
  }

  function updateResolveSplit() {
    const o = state.actionOrder;
    const pct = Number($("resolveRange").value);
    $("resolvePct").textContent = pct;
    const remaining = BigInt(o.amountWei) - BigInt(o.releasedWei);
    const buyerShare = (remaining * BigInt(pct * 100)) / 10000n;
    $("resolveSplit").textContent =
      `Buyer receives ${fmtEth(buyerShare)} ETH · Seller receives ${fmtEth(remaining - buyerShare)} ETH`;
  }

  function openResolve(order) {
    state.actionOrder = order;
    $("resolveOrderId").textContent = `#${order.id}`;
    const remaining = BigInt(order.amountWei) - BigInt(order.releasedWei);
    $("resolveIntro").textContent =
      `${fmtEth(remaining)} ETH is still in escrow (${fmtEth(order.releasedWei)} ETH was already released to the seller on shipment).`;
    $("resolveRange").value = 50;
    updateResolveSplit();
    $("resolveDialog").showModal();
  }

  function onResolveConfirm(event) {
    event.preventDefault();
    const pct = Number($("resolveRange").value);
    $("resolveDialog").close();
    const o = state.actionOrder;
    sendTx(`Resolve dispute #${o.id} (${pct}% to buyer)`, "resolveDispute", [o.id, pct * 100]);
  }

  // ------------------------------------------------------------------ document verification
  function fillVerifySelect() {
    const sel = $("vOrder");
    const current = sel.value;
    const withDocs = state.orders.filter((o) => o.docHash);
    sel.innerHTML = '<option value="">Select an order…</option>' +
      withDocs.map((o) => `<option value="${o.id}">#${o.id} ${escapeHtml(o.product)}</option>`).join("");
    if (withDocs.some((o) => String(o.id) === current)) sel.value = current;
  }

  async function onVerify() {
    const out = $("verifyResult");
    const order = findOrder($("vOrder").value);
    const file = $("vFile").files[0];
    out.className = "verify-result";
    if (!order || !file) { out.textContent = order ? "Choose a file to check." : "Choose an order with a shipping document."; return; }
    const hash = ethers.keccak256(new Uint8Array(await file.arrayBuffer()));
    const match = lower(hash) === lower(order.docHash);
    out.classList.add(match ? "ok" : "bad");
    out.textContent = match
      ? `✓ Match — this is the exact document anchored for order #${order.id}.`
      : `✗ No match — this file differs from the document anchored for order #${order.id}.`;
  }

  // ------------------------------------------------------------------ timers
  function tickCountdowns() {
    let crossed = false;
    document.querySelectorAll(".cd").forEach((el) => {
      const left = Number(el.dataset.ts) - nowSec();
      if (left > 0) el.textContent = `in ${fmtDuration(left)}`;
      else {
        el.textContent = "passed";
        if (el.dataset.live === "1") { el.dataset.live = "0"; crossed = true; }
      }
    });
    if (crossed) renderOrders(); // deadlines change which actions are available
  }

  // ------------------------------------------------------------------ init
  async function init() {
    const link = $("contractLink");
    link.href = `${CFG.explorer}/address/${CFG.contractAddress}`;
    link.textContent = short(CFG.contractAddress);

    try {
      const abi = await api(CFG.abiUrl);
      state.abi = Array.isArray(abi) ? abi : abi.abi;
    } catch (err) {
      banner("error", `Could not load the contract ABI: ${escapeHtml(err.message)}`);
      return;
    }

    try {
      const cfg = await api("/api/config");
      state.arbiter = cfg.arbiter;
      state.confirmWindow = cfg.confirmWindow;
      if (!cfg.chainConnected) {
        banner("warn", "The backend is not connected to Sepolia (RPC_URL / CONTRACT_ADDRESS not configured). Order lists will be empty.");
      }
    } catch (err) {
      banner("error", `Backend unavailable: ${escapeHtml(err.message)}`);
    }

    // Event wiring
    $("connectBtn").addEventListener("click", () => connect(true));
    $("createForm").addEventListener("submit", onCreateOrder);
    $("fProduct").addEventListener("input", updateProductBytes);
    $("withdrawBtn").addEventListener("click", (e) => sendTx("Withdraw", "withdraw", [], {}, e.currentTarget));
    $("ordersList").addEventListener("click", onOrderAction);
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      state.filter = tab.dataset.filter;
      renderOrders();
    }));
    $("historyMine").addEventListener("change", loadHistory);
    $("vOrder").addEventListener("change", onVerify);
    $("vFile").addEventListener("change", onVerify);
    $("shipFile").addEventListener("change", updateShipHash);
    $("shipText").addEventListener("input", updateShipHash);
    $("shipConfirm").addEventListener("click", onShipConfirm);
    $("disputeReason").addEventListener("input", () => { $("reasonBytes").textContent = utf8Len($("disputeReason").value); });
    $("disputeConfirm").addEventListener("click", onDisputeConfirm);
    $("resolveRange").addEventListener("input", updateResolveSplit);
    $("resolveConfirm").addEventListener("click", onResolveConfirm);

    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", (accounts) => (accounts.length ? connect(false) : disconnect()));
      window.ethereum.on?.("chainChanged", () => window.location.reload());
      try {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (accounts.length) await connect(false);
      } catch { /* ignore */ }
    } else {
      banner("info", "MetaMask was not detected. You can browse orders and history; install MetaMask to create or manage orders.");
    }

    await refreshAll();
    setInterval(tickCountdowns, 1000);
    setInterval(refreshAll, REFRESH_MS);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
