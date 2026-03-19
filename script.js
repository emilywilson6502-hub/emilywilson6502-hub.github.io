(() => {
  "use strict";

  // PWA: register service worker (required for install + offline).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }

  const STORAGE_KEYS = {
    balanceCents: "cashapp.balanceCents",
    transactions: "cashapp.transactions",
    theme: "cashapp.theme",
    lastReceiptId: "cashapp.lastReceiptId",
    schemaVersion: "cashapp.schemaVersion",
  };

  const SCHEMA_VERSION = 1;

  /** @typedef {"debit"|"credit"} TxType */
  /** @typedef {"completed"|"pending"|"failed"} TxStatus */
  /**
   * @typedef Transaction
   * @property {string} id
   * @property {string} name
   * @property {number} amount
   * @property {number} amountCents
   * @property {TxType} type
   * @property {string} dateISO
   * @property {TxStatus} status
   */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function clampInt(n, min, max) {
    const v = Number.isFinite(n) ? Math.trunc(n) : min;
    return Math.min(max, Math.max(min, v));
  }

  function formatMoneyFromCents(cents) {
    const dollars = (cents / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `$${dollars}`;
  }

  function formatShortDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatFullDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function txId() {
    const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
    return `CA-${Date.now().toString(36).toUpperCase()}-${rand}`;
  }

  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  function loadState() {
    const storedSchema = Number(localStorage.getItem(STORAGE_KEYS.schemaVersion) || "0");
    if (storedSchema !== SCHEMA_VERSION) {
      localStorage.setItem(STORAGE_KEYS.schemaVersion, String(SCHEMA_VERSION));
    }

    const rawBalance = localStorage.getItem(STORAGE_KEYS.balanceCents);
    let balanceCents = Number(rawBalance);
    if (rawBalance === null || !Number.isFinite(balanceCents)) balanceCents = 124567; // seed $1,245.67
    balanceCents = clampInt(balanceCents, -999999999, 999999999);

    /** @type {Transaction[]} */
    const rawTransactions = localStorage.getItem(STORAGE_KEYS.transactions);
    let transactions = safeJsonParse(rawTransactions || "[]", []);
    if (!Array.isArray(transactions)) transactions = [];

    // Seed ONLY on first-ever run (no localStorage key yet).
    // If user deletes everything, keep it empty on reload.
    if (rawTransactions === null) {
      const now = Date.now();
      transactions = [
        {
          id: `CA-SEED-${now}-A`,
          name: "Starbucks",
          amount: 6.5,
          amountCents: 650,
          type: "debit",
          dateISO: new Date(now - 86400000).toISOString(),
          status: "completed",
        },
        {
          id: `CA-SEED-${now}-B`,
          name: "Mom",
          amount: 120,
          amountCents: 12000,
          type: "credit",
          dateISO: new Date(now - 2 * 86400000).toISOString(),
          status: "completed",
        },
        {
          id: `CA-SEED-${now}-C`,
          name: "Netflix",
          amount: 15.99,
          amountCents: 1599,
          type: "debit",
          dateISO: new Date(now - 3 * 86400000).toISOString(),
          status: "completed",
        },
      ];
      saveState({ balanceCents, transactions });
    }

    const theme = localStorage.getItem(STORAGE_KEYS.theme) || "dark";

    return { balanceCents, transactions, theme };
  }

  function saveState(partial) {
    if (typeof partial.balanceCents === "number") {
      localStorage.setItem(STORAGE_KEYS.balanceCents, String(Math.trunc(partial.balanceCents)));
    }
    if (Array.isArray(partial.transactions)) {
      localStorage.setItem(STORAGE_KEYS.transactions, JSON.stringify(partial.transactions));
    }
  }

  const state = {
    balanceCents: 0,
    /** @type {Transaction[]} */
    transactions: [],
    activeScreen: "home",
    theme: "dark",
    // keypad input uses a string buffer like "12.34"
    amountStr: "0",
    // for deleting/viewing a transaction detail
    currentTxId: null,
  };

  function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    document.body.classList.toggle("light", state.theme === "light");
    localStorage.setItem(STORAGE_KEYS.theme, state.theme);
  }

  function setActiveScreen(name) {
    state.activeScreen = name;
    $$(".screen").forEach((el) => el.classList.toggle("is-active", el.dataset.screen === name));
    $$(".nav-tab").forEach((el) => el.classList.toggle("is-active", el.dataset.nav === name));

    if (name === "history") renderHistory();
    if (name === "home") renderHome();
    if (name === "send") {
      // focus receiver for quick entry
      const input = $("#receiver-input");
      if (input) setTimeout(() => input.focus(), 50);
    }
  }

  function showToast(text) {
    const toast = $("#toast");
    const label = $("#toast-text");
    if (!toast || !label) return;
    label.textContent = text;
    toast.classList.remove("is-hidden");
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => toast.classList.add("is-hidden"), 2400);
  }
  showToast._t = 0;

  function setLoading(isLoading) {
    const el = $("#loading");
    if (!el) return;
    el.classList.toggle("is-hidden", !isLoading);
  }

  function amountStrToCents(str) {
    const s = String(str || "0").trim();
    if (s === "" || s === ".") return 0;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n * 100);
  }

  function setAmountStr(next) {
    // Normalize: keep only one dot, max 2 decimals, max digits.
    let s = String(next);
    s = s.replace(/[^\d.]/g, "");
    const firstDot = s.indexOf(".");
    if (firstDot !== -1) {
      s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
    }
    if (s.startsWith(".")) s = "0" + s;
    if (s === "") s = "0";
    if (s.includes(".")) {
      const [a, b] = s.split(".");
      s = `${a.slice(0, 7)}.${(b || "").slice(0, 2)}`;
    } else {
      s = s.slice(0, 7);
    }
    // trim leading zeros (keep "0" and "0.x")
    if (!s.includes(".")) s = String(Number(s));
    state.amountStr = s;
    const amountEl = $("#amount-display");
    if (amountEl) amountEl.textContent = Number(state.amountStr).toFixed(2);
    updateContinueEnabled();
  }

  function updateContinueEnabled() {
    const btn = $("#continue-send");
    const receiver = ($("#receiver-input")?.value || "").trim();
    const cents = amountStrToCents(state.amountStr);
    const ok = receiver.length > 0 && cents > 0;
    if (btn) btn.disabled = !ok;
  }

  function openConfirm() {
    const overlay = $("#confirm-overlay");
    if (!overlay) return;
    const receiver = ($("#receiver-input")?.value || "").trim() || "—";
    const cents = amountStrToCents(state.amountStr);
    $("#confirm-name").textContent = receiver;
    $("#confirm-amount").textContent = formatMoneyFromCents(cents);
    overlay.classList.remove("is-hidden");
  }

  function closeConfirm() {
    $("#confirm-overlay")?.classList.add("is-hidden");
  }

  function addTransaction(tx) {
    state.transactions.unshift(tx);
    saveState({ transactions: state.transactions, balanceCents: state.balanceCents });
  }

  function renderHome() {
    $("#balance-display").textContent = formatMoneyFromCents(state.balanceCents);
    renderRecent();
  }

  function renderRecent() {
    const list = $("#recent-list");
    if (!list) return;
    list.innerHTML = "";
    const recent = state.transactions.slice(0, 3);
    if (recent.length === 0) {
      list.innerHTML = `<li class="tx-item"><div><div class="tx-name">No activity yet</div><div class="tx-meta">Send money to see it here.</div></div><div class="tx-amount credit">$0.00</div></li>`;
      return;
    }
    for (const tx of recent) list.appendChild(renderTxItem(tx));
  }

  function renderHistory(filter = $("#history-filter")?.value || "all") {
    const list = $("#full-history");
    if (!list) return;
    list.innerHTML = "";
    let items = state.transactions;
    if (filter === "debit" || filter === "credit") items = items.filter((t) => t.type === filter);
    if (items.length === 0) {
      list.innerHTML = `<li class="tx-item"><div><div class="tx-name">No transactions</div><div class="tx-meta">Try changing the filter.</div></div><div class="tx-amount credit">$0.00</div></li>`;
      return;
    }
    for (const tx of items) list.appendChild(renderTxItem(tx, true));
  }

  function renderTxItem(tx, showStatus = false) {
    const li = document.createElement("li");
    li.className = "tx-item";
    const sign = tx.type === "debit" ? "−" : "+";
    const amount = formatMoneyFromCents(tx.amountCents);
    const statusText =
      tx.status === "completed" ? "Completed" : tx.status === "pending" ? "Pending" : "Failed";
    li.innerHTML = `
      <div>
        <div class="tx-name"></div>
        <div class="tx-meta"></div>
        ${showStatus ? `<div class="tx-status">${statusText}</div>` : ""}
      </div>
      <div>
        <div class="tx-amount ${tx.type}">${sign}${amount}</div>
        <div class="tx-meta mono">${tx.id}</div>
      </div>
    `;
    li.querySelector(".tx-name").textContent = tx.name;
    li.querySelector(".tx-meta").textContent = formatShortDate(tx.dateISO);
    li.style.cursor = "pointer";
    li.addEventListener("click", () => showTxDetail(tx.id));
    return li;
  }

  function showReceipt(id) {
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    localStorage.setItem(STORAGE_KEYS.lastReceiptId, tx.id);
    $("#receipt-id").textContent = tx.id;
    $("#receipt-to").textContent = tx.name;
    const sign = tx.type === "debit" ? "−" : "+";
    $("#receipt-amount").textContent = `${sign}${formatMoneyFromCents(tx.amountCents)}`;
    $("#receipt-date").textContent = formatFullDateTime(tx.dateISO);
    $("#receipt-status").textContent =
      tx.status === "completed" ? "Completed" : tx.status === "pending" ? "Pending" : "Failed";
    setActiveScreen("receipt");
  }

  function showTxDetail(id) {
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    state.currentTxId = tx.id;

    const isDebit = tx.type === "debit";
    const title = isDebit ? "Money sent" : "Money received";
    const toLabel = isDebit ? "To" : "From";

    const amount = formatMoneyFromCents(tx.amountCents);
    const amountLine = `${isDebit ? "" : ""}${amount}`;
    const rate = "1 USD = 1.0000 USDC";
    const feesCents = 0;
    const usdcAmount = (tx.amountCents / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const totalLabel = isDebit ? "Total sent" : "Total received";
    const foot = isDebit
      ? "US dollars from your Cash balance were sent as USDC."
      : "US dollars were received to your Cash balance.";

    $("#txdetail-title").textContent = title;
    $("#txdetail-sub").textContent = formatFullDateTime(tx.dateISO);
    $("#txdetail-amount").textContent = amountLine;

    $("#txdetail-transfer").textContent = amount;
    $("#txdetail-rate").textContent = rate;
    $("#txdetail-fees").textContent = formatMoneyFromCents(feesCents);
    $("#txdetail-total-label").textContent = totalLabel;
    $("#txdetail-total").textContent = `${usdcAmount} USDC`;
    $("#txdetail-foot").textContent = foot;

    $("#txdetail-id").textContent = tx.id;
    $("#txdetail-status").textContent =
      tx.status === "completed" ? "Completed" : tx.status === "pending" ? "Pending" : "Failed";
    $("#txdetail-to-label").textContent = toLabel;
    $("#txdetail-to").textContent = tx.name;

    setActiveScreen("txdetail");
  }

  function deleteCurrentActivity() {
    const id = state.currentTxId;
    if (!id) return;

    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;

    const ok = window.confirm(`Delete this activity?\n\n${tx.name} • ${formatMoneyFromCents(tx.amountCents)}`);
    if (!ok) return;

    state.transactions = state.transactions.filter((t) => t.id !== id);
    state.currentTxId = null;
    saveState({ transactions: state.transactions, balanceCents: state.balanceCents });

    const lastId = localStorage.getItem(STORAGE_KEYS.lastReceiptId);
    if (lastId === id) localStorage.removeItem(STORAGE_KEYS.lastReceiptId);

    renderHome();
    renderHistory();
    setActiveScreen("history");
    showToast("Activity deleted");
  }

  function sendMoney() {
    const receiver = ($("#receiver-input")?.value || "").trim();
    const cents = amountStrToCents(state.amountStr);
    if (!receiver || cents <= 0) {
      showToast("Enter a name and amount");
      return;
    }
    if (cents > state.balanceCents) {
      showToast("Insufficient balance");
      return;
    }

    closeConfirm();
    setLoading(true);

    const id = txId();
    const nowISO = new Date().toISOString();
    /** @type {Transaction} */
    const pendingTx = {
      id,
      name: receiver,
      amount: cents / 100,
      amountCents: cents,
      type: "debit",
      dateISO: nowISO,
      status: "pending",
    };
    addTransaction(pendingTx);
    renderHome();

    // Simulate network / security checks
    window.setTimeout(() => {
      setLoading(false);
      // finalize
      state.balanceCents = clampInt(state.balanceCents - cents, -999999999, 999999999);
      const idx = state.transactions.findIndex((t) => t.id === id);
      if (idx !== -1) state.transactions[idx] = { ...state.transactions[idx], status: "completed" };
      saveState({ transactions: state.transactions, balanceCents: state.balanceCents });

      showToast(`Sent ${formatMoneyFromCents(cents)} to ${receiver}`);
      renderHome();
      renderHistory();
      showReceipt(id);
    }, 1200);
  }

  function requestDemo() {
    const amountCents = 18000;
    const id = txId();
    const nowISO = new Date().toISOString();
    state.balanceCents = clampInt(state.balanceCents + amountCents, -999999999, 999999999);
    /** @type {Transaction} */
    const tx = {
      id,
      name: "Jordan Lee",
      amount: amountCents / 100,
      amountCents: amountCents,
      type: "credit",
      dateISO: nowISO,
      status: "completed",
    };
    addTransaction(tx);
    saveState({ transactions: state.transactions, balanceCents: state.balanceCents });
    renderHome();
    showToast(`Received ${formatMoneyFromCents(amountCents)} from Jordan`);
  }

  function bindEvents() {
    // primary nav
    document.addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement|null} */ (e.target instanceof Element ? e.target.closest("[data-nav]") : null);
      if (!btn) return;
      const nav = btn.getAttribute("data-nav");
      if (!nav) return;
      if (nav === "send") {
        // reset send screen defaults
        setAmountStr("0");
        $("#receiver-input").value = "";
        updateContinueEnabled();
      }
      setActiveScreen(nav);
    });

    // Home primary CTAs:
    // - "Send" button should SEND money (debit)
    // - "Request" button should RECEIVE money (credit demo)
    $("#home-send")?.addEventListener("click", () => {
      setAmountStr("0");
      $("#receiver-input").value = "";
      updateContinueEnabled();
      setActiveScreen("send");
    });

    $("#home-request")?.addEventListener("click", requestDemo);
    $("#nav-request")?.addEventListener("click", requestDemo);
    $("#nav-settings")?.addEventListener("click", () => showToast("Settings coming soon"));

    // theme
    $("#dark-toggle")?.addEventListener("click", () => {
      setTheme(state.theme === "dark" ? "light" : "dark");
      showToast(state.theme === "dark" ? "Dark mode" : "Light mode");
    });

    // send input
    $("#receiver-input")?.addEventListener("input", updateContinueEnabled);

    // keypad
    $(".keypad")?.addEventListener("click", (e) => {
      const key = /** @type {HTMLElement|null} */ (e.target instanceof Element ? e.target.closest("[data-key]") : null);
      if (!key) return;
      const v = key.getAttribute("data-key");
      if (!v) return;
      if (v === "back") {
        if (state.amountStr.length <= 1) setAmountStr("0");
        else setAmountStr(state.amountStr.slice(0, -1));
        return;
      }
      if (v === ".") {
        if (state.amountStr.includes(".")) return;
        setAmountStr(state.amountStr + ".");
        return;
      }
      // digit
      if (/^\d$/.test(v)) {
        if (state.amountStr === "0") setAmountStr(v);
        else setAmountStr(state.amountStr + v);
      }
    });

    $("#continue-send")?.addEventListener("click", openConfirm);
    $("#confirm-no")?.addEventListener("click", closeConfirm);
    $("#confirm-overlay")?.addEventListener("click", (e) => {
      if (e.target === $("#confirm-overlay")) closeConfirm();
    });
    $("#confirm-yes")?.addEventListener("click", sendMoney);

    $("#history-filter")?.addEventListener("change", () => renderHistory());

    $("#download-pdf")?.addEventListener("click", () => {
      // Print dialog => "Save as PDF" in browser
      window.print();
    });

    $("#txdetail-delete")?.addEventListener("click", deleteCurrentActivity);

    // Esc closes confirm
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeConfirm();
    });
  }

  function init() {
    const loaded = loadState();
    state.balanceCents = loaded.balanceCents;
    state.transactions = loaded.transactions;
    setTheme(loaded.theme);

    bindEvents();
    setAmountStr("0");
    renderHome();
    renderHistory();

    // Always start on Home after reload.
    setActiveScreen("home");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

