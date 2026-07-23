/* =========================================================
   TRADEBOOK - Core JavaScript Application Logic
   (Forex-only Trading Hub + Journal Risk Guard terintegrasi)
========================================================= */

const state = {
    investment: { assets: {}, currentAsset: null },
    forex: { balance: 0, deposited: 0, pnlTotal: 0, history: [] },
    journal: {
        exchangeRate: 15800,
        maxLoss: 50,
        peakBalance: 0,
        currentBalance: 0,
        peakDate: null,
        lockdownActive: false,
        trades: []
    }
};

const app = {
    isBalanceHidden: false,
    currentTheme: "dark",

    // ============================================
    // PERSISTENCE
    // ============================================
    saveState() {
        try {
            localStorage.setItem("tradebook_state", JSON.stringify(state));
        } catch (e) {
            console.error("Gagal menyimpan data:", e);
        }
    },

    loadState() {
        try {
            const raw = localStorage.getItem("tradebook_state");
            if (!raw) return;
            const saved = JSON.parse(raw);

            if (saved.investment && saved.investment.assets) {
                state.investment.assets = saved.investment.assets;
                Object.values(state.investment.assets).forEach(asset => {
                    if (!asset.type) asset.type = "invest";
                    if (asset.type === "invest") {
                        if (!asset.cycleStart)
                            asset.cycleStart = this.todayISO();
                        if (asset.cycleAmount === undefined)
                            asset.cycleAmount = 0;
                        if (asset.cycleTarget === undefined)
                            asset.cycleTarget = 150000;
                        if (asset.minDeposit === undefined)
                            asset.minDeposit = 5000;
                        if (asset.exchangeTotal === undefined)
                            asset.exchangeTotal = asset.balance || 0;
                        if (asset.pendingAmount === undefined)
                            asset.pendingAmount = 0;
                        if (!asset.topupLog) asset.topupLog = [];
                    } else {
                        if (asset.minDeposit === undefined)
                            asset.minDeposit = 3000;
                    }
                });
            }

            // Forex: pakai data baru kalau ada, atau migrasi dari struktur lama (categories.Forex)
            if (saved.forex) {
                state.forex = Object.assign(
                    { balance: 0, deposited: 0, pnlTotal: 0, history: [] },
                    saved.forex
                );
            } else if (saved.categories && saved.categories.Forex) {
                state.forex = Object.assign(
                    { balance: 0, deposited: 0, pnlTotal: 0, history: [] },
                    saved.categories.Forex
                );
            }

            if (saved.journal) {
                state.journal = Object.assign(
                    {
                        exchangeRate: 15800,
                        maxLoss: 50,
                        peakBalance: 0,
                        currentBalance: 0,
                        peakDate: null,
                        lockdownActive: false,
                        trades: []
                    },
                    saved.journal
                );
            }
        } catch (e) {
            console.error("Gagal memuat data tersimpan:", e);
        }
    },

    init() {
        this.loadState();
        this.setDate();
        this.renderHome();
        this.renderTradingHub();
        this.renderStats();
        this.renderInvestmentView();
        this.renderJournal();
        this.attachRipples();
        history.replaceState({ view: "home" }, "", "#home");
        window.addEventListener("popstate", e => {
            const sheet = document.getElementById("bottom-sheet");
            if (sheet.classList.contains("open")) {
                this.closeSheet();
                history.pushState({ view: "current" }, "", location.hash);
                return;
            }
            const view = (e.state && e.state.view) || "home";
            this.navigate(view, true);
        });
        console.log("TradeBook App Initialized! 🚀");
    },

    attachRipples() {
        document.querySelectorAll(".clickable-card").forEach(card => {
            card.addEventListener("pointerdown", e => {
                const rect = card.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height);
                const ripple = document.createElement("span");
                ripple.className = "ripple";
                ripple.style.width = ripple.style.height = size + "px";
                ripple.style.left = e.clientX - rect.left - size / 2 + "px";
                ripple.style.top = e.clientY - rect.top - size / 2 + "px";
                card.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
            });
        });
    },

    setDate() {
        const dateElement = document.getElementById("current-date");
        const options = {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric"
        };
        dateElement.textContent = new Date().toLocaleDateString(
            "en-US",
            options
        );
    },

    formatCurrency(value) {
        return new Intl.NumberFormat("id-ID", {
            style: "currency",
            currency: "IDR",
            minimumFractionDigits: 0
        }).format(value);
    },

    todayKey() {
        const d = new Date();
        return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
    },

    todayISO() {
        return new Date().toISOString().split("T")[0];
    },

    getDaysSince(dateStr) {
        const start = new Date(dateStr);
        start.setHours(0, 0, 0, 0);
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        return Math.floor((now - start) / 86400000);
    },

    checkCycleReset(asset) {
        if (!asset.cycleStart) {
            asset.cycleStart = this.todayISO();
            return;
        }
        let daysSince = this.getDaysSince(asset.cycleStart);
        while (daysSince >= 30) {
            const newStart = new Date(asset.cycleStart);
            newStart.setDate(newStart.getDate() + 30);
            asset.cycleStart = newStart.toISOString().split("T")[0];
            asset.cycleAmount = 0;
            daysSince = this.getDaysSince(asset.cycleStart);
        }
    },

    getMonday(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setHours(0, 0, 0, 0);
        d.setDate(diff);
        return d;
    },

    weeklyTradePnl() {
        const monday = this.getMonday(new Date()).getTime();
        let total = 0;
        state.forex.history.forEach(t => {
            if (t.kind === "trade" && t.timestamp >= monday)
                total += t.pnlValue;
        });
        return total;
    },

    formatAllBalances() {
        const elements = document.querySelectorAll(".balance-amount");
        elements.forEach(el => {
            const val = el.getAttribute("data-value");
            if (val !== null) {
                el.textContent = this.isBalanceHidden
                    ? "Rp ••••••••"
                    : this.formatCurrency(val);
            }
        });
    },

    setBalance(el, value) {
        const oldValue = parseFloat(el.getAttribute("data-value")) || 0;
        const newValue = Number(value);
        el.setAttribute("data-value", newValue);

        if (this.isBalanceHidden) {
            el.textContent = "Rp ••••••••";
            return;
        }
        if (oldValue === newValue) {
            el.textContent = this.formatCurrency(newValue);
            return;
        }
        this.animateValue(el, oldValue, newValue, 500);
    },

    animateValue(el, start, end, duration) {
        const startTime = performance.now();
        const step = now => {
            const progress = Math.min((now - startTime) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = start + (end - start) * eased;
            el.textContent = this.formatCurrency(Math.round(current));
            if (progress < 1) requestAnimationFrame(step);
            else el.textContent = this.formatCurrency(end);
        };
        requestAnimationFrame(step);
    },

    toggleBalance() {
        this.isBalanceHidden = !this.isBalanceHidden;
        const eyeIcon = document.querySelector(".toggle-eye i");
        if (this.isBalanceHidden) {
            eyeIcon.classList.remove("fa-eye");
            eyeIcon.classList.add("fa-eye-slash");
        } else {
            eyeIcon.classList.remove("fa-eye-slash");
            eyeIcon.classList.add("fa-eye");
        }
        this.formatAllBalances();
        this.renderInvestmentList();
        const settingToggle = document.getElementById("setting-hide-balance");
        if (settingToggle) settingToggle.checked = this.isBalanceHidden;
    },

    toggleMenu() {
        const sidebar = document.getElementById("sidebar");
        const overlay = document.getElementById("overlay");
        sidebar.classList.toggle("open");
        overlay.classList.toggle("active");
        overlay.onclick = () => {
            sidebar.classList.remove("open");
            overlay.classList.remove("active");
        };
    },

    navigate(viewId, skipPush) {
        document
            .querySelectorAll(".view")
            .forEach(view => view.classList.remove("active"));
        document.getElementById(`view-${viewId}`).classList.add("active");
        document.getElementById("sidebar").classList.remove("open");
        document.getElementById("overlay").classList.remove("active");
        window.scrollTo(0, 0);
        if (!skipPush) {
            history.pushState({ view: viewId }, "", "#" + viewId);
        }
    },

    // ============================================
    // DERIVED TOTALS (Forex-only)
    // ============================================
    tradingTotal() {
        return state.forex.balance;
    },

    totalBalance() {
        return this.investmentBalance() + this.tradingTotal();
    },

    investmentBalance() {
        return Object.values(state.investment.assets).reduce(
            (sum, a) => sum + a.balance,
            0
        );
    },

    overallTrendPercent() {
        const deposited = state.forex.deposited;
        const pnl = state.forex.pnlTotal;
        return deposited > 0 ? (pnl / deposited) * 100 : 0;
    },

    // ============================================
    // RENDER — HOME
    // ============================================
    renderHome() {
        this.setBalance(
            document.getElementById("home-total"),
            this.totalBalance()
        );
        this.setBalance(
            document.getElementById("home-investment"),
            this.investmentBalance()
        );
        this.setBalance(
            document.getElementById("home-trading"),
            this.tradingTotal()
        );

        const trend = this.overallTrendPercent();
        const badge = document.getElementById("home-total-badge");
        badge.className = "badge " + (trend >= 0 ? "profit" : "loss");
        badge.innerHTML = `<i class="fa-solid fa-arrow-trend-${trend >= 0 ? "up" : "down"}"></i> ${trend >= 0 ? "+" : ""}${trend.toFixed(1)}% This Month`;

        const today = this.todayKey();
        let todayPnl = 0;
        let todayTrades = 0;
        state.forex.history.forEach(t => {
            if (t.kind === "trade" && t.date === today) {
                todayPnl += t.pnlValue;
                todayTrades += 1;
            }
        });

        const profitEl = document.getElementById("home-today-profit");
        profitEl.textContent =
            (todayPnl >= 0 ? "+ " : "- ") +
            this.formatCurrency(Math.abs(todayPnl));
        profitEl.className = todayPnl >= 0 ? "text-profit" : "text-loss";
        document.getElementById("home-today-trades").textContent = todayTrades;

        const growthEl = document.getElementById("home-monthly-growth");
        growthEl.textContent = `${trend >= 0 ? "+ " : "- "}${Math.abs(trend).toFixed(1)}%`;
        growthEl.className = trend >= 0 ? "text-profit" : "text-loss";
    },

    // ============================================
    // RENDER — TRADING HUB (Forex + Risk Guard + Journal)
    // ============================================
    renderTradingHub() {
        this.setBalance(
            document.getElementById("trading-total"),
            this.tradingTotal()
        );

        const today = this.todayKey();
        let todayPnl = 0;
        state.forex.history.forEach(t => {
            if (t.kind === "trade" && t.date === today) todayPnl += t.pnlValue;
        });
        const todayEl = document.getElementById("trading-today-pnl");
        todayEl.textContent =
            (todayPnl >= 0 ? "+ " : "- ") +
            this.formatCurrency(Math.abs(todayPnl));
        todayEl.className = todayPnl >= 0 ? "text-profit" : "text-loss";

        const weekPnl = this.weeklyTradePnl();
        const weekEl = document.getElementById("trading-week-pnl");
        weekEl.textContent =
            (weekPnl >= 0 ? "+ " : "- ") +
            this.formatCurrency(Math.abs(weekPnl));
        weekEl.className = weekPnl >= 0 ? "text-profit" : "text-loss";

        this.renderHistory();
    },

    renderStats() {
        let profit = 0,
            loss = 0,
            wins = 0,
            trades = 0;
        state.forex.history.forEach(t => {
            if (t.kind !== "trade") return;
            trades += 1;
            if (t.pnlValue >= 0) {
                profit += t.pnlValue;
                wins += 1;
            } else {
                loss += Math.abs(t.pnlValue);
            }
        });

        this.setBalance(document.getElementById("stat-profit"), profit);
        this.setBalance(document.getElementById("stat-loss"), loss);
        document.getElementById("stat-winrate").textContent =
            trades > 0 ? `${Math.round((wins / trades) * 100)}%` : "0%";
        document.getElementById("stat-trades").textContent = trades;
    },

    renderHistory() {
        const container = document.getElementById("history-container");
        const cat = state.forex;
        container.innerHTML = "";
        if (cat.history.length === 0) {
            container.innerHTML =
                '<p class="empty-state">Belum ada transaksi.</p>';
            return;
        }
        const sorted = [...cat.history].sort(
            (a, b) => b.timestamp - a.timestamp
        );
        sorted.forEach(entry => {
            const card = document.createElement("div");
            card.className = "history-card";
            const pnlClass = entry.pnlValue >= 0 ? "text-profit" : "text-loss";
            card.innerHTML = `
                <div class="hist-left">
                    <span class="hist-pair">${entry.label} <span class="hist-badge ${entry.badgeClass}">${entry.badgeText}</span></span>
                    <span class="hist-time">${entry.date}, ${entry.time}</span>
                </div>
                <div class="hist-actions">
                    <span class="hist-pnl ${pnlClass}">${entry.pnlValue >= 0 ? "+ " : "- "}${this.formatCurrency(Math.abs(entry.pnlValue))}</span>
                    <button class="hist-delete" onclick="app.confirmDeleteEntry(${entry.timestamp})" aria-label="Hapus transaksi">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    handleDeposit() {
        this.openSheet({
            title: "Deposit",
            fields: [
                {
                    id: "amount",
                    label: "Jumlah (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: ""
                }
            ],
            confirmLabel: "Deposit",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0)
                    return "Masukkan jumlah yang valid.";

                const cat = state.forex;
                cat.balance += amount;
                cat.deposited += amount;
                cat.history.push(
                    this.makeEntry(
                        "deposit",
                        "Deposit",
                        "DEPOSIT",
                        "badge-buy",
                        amount
                    )
                );

                this.saveState();
                this.renderTradingHub();
                this.renderHome();
                this.toast("Deposit berhasil ditambahkan 🚀");
                return null;
            }
        });
    },

    handleWithdraw() {
        this.openSheet({
            title: "Withdraw",
            fields: [
                {
                    id: "amount",
                    label: "Jumlah (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: ""
                }
            ],
            confirmLabel: "Withdraw",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0)
                    return "Masukkan jumlah yang valid.";

                const cat = state.forex;
                if (amount > cat.balance) return "Saldo kamu tidak cukup.";

                cat.balance -= amount;
                cat.history.push(
                    this.makeEntry(
                        "withdraw",
                        "Withdraw",
                        "WITHDRAW",
                        "badge-sell",
                        -amount
                    )
                );

                this.saveState();
                this.renderTradingHub();
                this.renderHome();
                this.toast("Penarikan berhasil diproses 💸");
                return null;
            }
        });
    },

    makeEntry(kind, label, badgeText, badgeClass, pnlValue) {
        const now = new Date();
        return {
            kind,
            label,
            badgeText,
            badgeClass,
            pnlValue,
            date: this.todayKey(),
            time:
                now.getHours() +
                ":" +
                String(now.getMinutes()).padStart(2, "0"),
            timestamp: now.getTime()
        };
    },

    confirmDeleteEntry(timestamp) {
        this.openSheet({
            title: "Hapus Transaksi?",
            message:
                "Transaksi ini akan dihapus permanen dan saldo akan disesuaikan.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                this.removeHistoryEntry(timestamp);
                return null;
            }
        });
    },

    removeHistoryEntry(timestamp) {
        const cat = state.forex;
        const idx = cat.history.findIndex(e => e.timestamp === timestamp);
        if (idx === -1) return;

        const entry = cat.history[idx];
        if (entry.kind === "deposit") {
            cat.balance -= entry.pnlValue;
            cat.deposited -= entry.pnlValue;
        } else if (entry.kind === "withdraw") {
            cat.balance -= entry.pnlValue;
        } else if (entry.kind === "trade") {
            cat.balance -= entry.pnlValue;
            cat.pnlTotal -= entry.pnlValue;
        }

        cat.history.splice(idx, 1);
        this.saveState();
        this.renderTradingHub();
        this.renderHome();
        this.renderStats();
        this.toast("Transaksi dihapus.");
    },

    confirmResetAll() {
        this.openSheet({
            title: "Reset Semua Data?",
            message:
                "Semua saldo, deposit, withdraw, aset investment, dan riwayat trading akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.",
            confirmLabel: "Reset Semua",
            danger: true,
            onConfirm: () => {
                this.resetAllData();
                return null;
            }
        });
    },

    resetAllData() {
        state.investment = { assets: {}, currentAsset: null };
        state.forex = { balance: 0, deposited: 0, pnlTotal: 0, history: [] };
        state.journal = {
            exchangeRate: 15800,
            maxLoss: 50,
            peakBalance: 0,
            currentBalance: 0,
            peakDate: null,
            lockdownActive: false,
            trades: []
        };

        this.saveState();
        document.getElementById("sidebar").classList.remove("open");
        document.getElementById("overlay").classList.remove("active");

        this.renderHome();
        this.renderTradingHub();
        this.renderStats();
        this.renderInvestmentView();
        this.renderJournal();
        this.navigate("home");
        this.toast("Semua data berhasil direset.");
    },

    // ============================================
    // RENDER — INVESTMENT (tidak berubah)
    // ============================================
    renderInvestmentView() {
        this.setBalance(
            document.getElementById("inv-total"),
            this.investmentBalance()
        );
        this.renderInvestmentList();
    },

    renderInvestmentList() {
        const container = document.getElementById("investment-list");
        const assets = state.investment.assets;
        const names = Object.keys(assets);
        container.innerHTML = "";

        if (names.length === 0) {
            container.innerHTML =
                '<p class="empty-state">Belum ada aset investment. Tambah aset dulu, misal "Solana".</p>';
            return;
        }

        names.forEach(name => {
            const asset = assets[name];
            const safeName = name.replace(/'/g, "\\'");
            const isSavings = asset.type === "savings";
            const icon = isSavings ? "fa-piggy-bank" : "fa-coins";
            const iconStyle = isSavings
                ? "background: rgba(0, 200, 83, 0.1); color: var(--profit-color);"
                : "background: rgba(255, 215, 0, 0.1); color: var(--primary-color);";
            const typeLabel = isSavings ? "Simpanan" : "Investasi";
            const card = document.createElement("div");
            card.className = "card category-card";
            card.style.cursor = "pointer";
            card.onclick = () => this.openInvestmentAsset(name);
            card.innerHTML = `
                <div class="cat-info">
                    <div class="cat-icon" style="${iconStyle}"><i class="fa-solid ${icon}"></i></div>
                    <div>
                        <h3>${name} <span class="asset-type-badge">${typeLabel}</span></h3>
                        <p class="balance-amount">${this.isBalanceHidden ? "Rp ••••••••" : this.formatCurrency(asset.balance)}</p>
                    </div>
                </div>
                <button class="hist-delete" aria-label="Hapus aset">
                    <i class="fa-solid fa-trash"></i>
                </button>
            `;
            card.querySelector(".hist-delete").onclick = e => {
                e.stopPropagation();
                this.confirmDeleteAssetFromList(safeName);
            };
            container.appendChild(card);
        });
    },

    handleAddAsset() {
        this.openSheet({
            title: "Tambah Aset",
            fields: [
                {
                    id: "type",
                    label: "Jenis Aset",
                    type: "segmented",
                    options: ["Investasi", "Simpanan"],
                    default: "Investasi"
                },
                {
                    id: "name",
                    label: "Nama Aset",
                    type: "text",
                    placeholder: ""
                }
            ],
            confirmLabel: "Tambah",
            onConfirm: values => {
                const name = values.name.trim();
                if (!name) return "Nama aset tidak boleh kosong.";
                if (state.investment.assets[name])
                    return "Aset dengan nama ini sudah ada.";

                const isSavings = values.type === "Simpanan";
                state.investment.assets[name] = isSavings
                    ? {
                          type: "savings",
                          balance: 0,
                          deposited: 0,
                          history: [],
                          minDeposit: 3000
                      }
                    : {
                          type: "invest",
                          balance: 0,
                          deposited: 0,
                          history: [],
                          cycleStart: this.todayISO(),
                          cycleAmount: 0,
                          cycleTarget: 150000,
                          minDeposit: 5000,
                          exchangeTotal: 0,
                          pendingAmount: 0,
                          topupLog: []
                      };
                this.saveState();
                this.renderInvestmentView();
                this.renderHome();
                this.toast(`Aset "${name}" berhasil ditambahkan ✨`);
                return null;
            }
        });
    },

    openInvestmentAsset(name) {
        state.investment.currentAsset = name;
        this.renderInvestmentAsset();
        this.navigate("investment-asset");
    },

    renderInvestmentAsset() {
        const name = state.investment.currentAsset;
        const asset = state.investment.assets[name];
        if (!asset) {
            this.navigate("investment");
            return;
        }

        const isSavings = asset.type === "savings";
        document.getElementById("inv-invest-section").style.display = isSavings
            ? "none"
            : "block";
        document.getElementById("inv-savings-section").style.display = isSavings
            ? "block"
            : "none";
        document.getElementById("inv-deposit-label").textContent = isSavings
            ? "Nabung"
            : "Deposit";
        document.getElementById("inv-withdraw-label").textContent = isSavings
            ? "Pakai"
            : "Withdraw";
        document.getElementById("inv-balance-label").textContent = isSavings
            ? "Saldo Celengan"
            : "Saldo Exchange (Total)";
        document.getElementById("inv-asset-title").textContent = name;

        if (isSavings) {
            this.setBalance(
                document.getElementById("inv-asset-balance"),
                asset.balance
            );
            const minInput = document.getElementById("inv-savings-min");
            if (minInput) minInput.value = asset.minDeposit;
        } else {
            this.checkCycleReset(asset);
            this.setBalance(
                document.getElementById("inv-asset-balance"),
                asset.exchangeTotal
            );

            const pct = Math.min(
                Math.round((asset.cycleAmount / asset.cycleTarget) * 100),
                100
            );
            document
                .getElementById("inv-cycle-ring")
                .style.setProperty("--pct", pct);
            document.getElementById("inv-cycle-pct").textContent = pct + "%";
            document.getElementById("inv-cycle-amount").textContent =
                `${this.formatCurrency(asset.cycleAmount)} / ${this.formatCurrency(asset.cycleTarget)}`;
            const daysSince = Math.min(
                this.getDaysSince(asset.cycleStart) + 1,
                30
            );
            document.getElementById("inv-cycle-day").textContent =
                `Hari ke-${daysSince} dari 30`;
            document.getElementById("inv-pending-amount").textContent =
                this.formatCurrency(asset.pendingAmount);
        }

        this.renderInvestmentHistory();
    },

    renderInvestmentHistory() {
        const container = document.getElementById(
            "investment-history-container"
        );
        const asset = state.investment.assets[state.investment.currentAsset];
        container.innerHTML = "";
        if (!asset || asset.history.length === 0) {
            container.innerHTML =
                '<p class="empty-state">Belum ada transaksi.</p>';
            return;
        }
        const sorted = [...asset.history].sort(
            (a, b) => b.timestamp - a.timestamp
        );
        sorted.forEach(entry => {
            const card = document.createElement("div");
            card.className = "history-card";
            const pnlClass = entry.pnlValue >= 0 ? "text-profit" : "text-loss";
            card.innerHTML = `
                <div class="hist-left">
                    <span class="hist-pair">${entry.label} <span class="hist-badge ${entry.badgeClass}">${entry.badgeText}</span></span>
                    <span class="hist-time">${entry.date}, ${entry.time}</span>
                </div>
                <div class="hist-actions">
                    <span class="hist-pnl ${pnlClass}">${entry.pnlValue >= 0 ? "+ " : "- "}${this.formatCurrency(Math.abs(entry.pnlValue))}</span>
                    <button class="hist-delete" onclick="app.confirmDeleteInvestmentEntry(${entry.timestamp})" aria-label="Hapus transaksi">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    handleInvestmentDeposit() {
        const currentAsset =
            state.investment.assets[state.investment.currentAsset];
        const isSavings = currentAsset && currentAsset.type === "savings";
        this.openSheet({
            title: isSavings ? "Nabung" : "Deposit",
            fields: [
                {
                    id: "amount",
                    label: "Jumlah (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: ""
                }
            ],
            confirmLabel: isSavings ? "Nabung" : "Deposit",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0)
                    return "Masukkan jumlah yang valid.";

                const asset =
                    state.investment.assets[state.investment.currentAsset];
                if (asset.type === "savings") {
                    asset.balance += amount;
                    asset.deposited += amount;
                    asset.history.push(
                        this.makeEntry(
                            "deposit",
                            "Nabung",
                            "NABUNG",
                            "badge-buy",
                            amount
                        )
                    );
                } else {
                    this.checkCycleReset(asset);
                    asset.pendingAmount += amount;
                    asset.deposited += amount;
                    asset.cycleAmount += amount;
                    asset.balance = asset.exchangeTotal + asset.pendingAmount;
                    asset.history.push(
                        this.makeEntry(
                            "deposit",
                            "Deposit",
                            "DEPOSIT",
                            "badge-buy",
                            amount
                        )
                    );
                }

                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast(
                    asset.type === "savings"
                        ? "Nabung berhasil ditambahkan 🐷"
                        : "Deposit berhasil ditambahkan 🚀"
                );
                return null;
            }
        });
    },

    handleInvestmentWithdraw() {
        const currentAsset =
            state.investment.assets[state.investment.currentAsset];
        const isSavings = currentAsset && currentAsset.type === "savings";
        this.openSheet({
            title: isSavings ? "Pakai Saldo" : "Withdraw",
            fields: [
                {
                    id: "amount",
                    label: "Jumlah (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: ""
                }
            ],
            confirmLabel: isSavings ? "Pakai" : "Withdraw",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0)
                    return "Masukkan jumlah yang valid.";

                const asset =
                    state.investment.assets[state.investment.currentAsset];
                if (asset.type === "savings") {
                    if (amount > asset.balance)
                        return "Saldo celengan tidak cukup.";
                    asset.balance -= amount;
                    asset.history.push(
                        this.makeEntry(
                            "withdraw",
                            "Pakai Saldo",
                            "PAKAI",
                            "badge-sell",
                            -amount
                        )
                    );
                } else {
                    if (amount > asset.exchangeTotal)
                        return "Saldo exchange tidak cukup (masih ada yang belum ditop up).";
                    asset.exchangeTotal -= amount;
                    asset.balance = asset.exchangeTotal + asset.pendingAmount;
                    asset.history.push(
                        this.makeEntry(
                            "withdraw",
                            "Withdraw",
                            "WITHDRAW",
                            "badge-sell",
                            -amount
                        )
                    );
                }

                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast(
                    asset.type === "savings"
                        ? "Saldo berhasil dipakai 💸"
                        : "Penarikan berhasil diproses 💸"
                );
                return null;
            }
        });
    },

    handleCycleSettings() {
        const asset = state.investment.assets[state.investment.currentAsset];
        this.openSheet({
            title: "Atur Target Siklus",
            fields: [
                {
                    id: "target",
                    label: "Target per Siklus (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(asset.cycleTarget)
                },
                {
                    id: "minDep",
                    label: "Minimal Nabung Harian (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(asset.minDeposit)
                },
                { id: "start", label: "Tanggal Mulai Siklus", type: "date" }
            ],
            confirmLabel: "Simpan",
            onConfirm: values => {
                const target = this.parseAmount(values.target);
                const minDep = this.parseAmount(values.minDep);
                if (target !== null && target > 0) asset.cycleTarget = target;
                if (minDep !== null && minDep >= 0) asset.minDeposit = minDep;
                if (values.start) asset.cycleStart = values.start;

                this.saveState();
                this.renderInvestmentAsset();
                this.toast("Pengaturan siklus disimpan ✨");
                return null;
            }
        });
    },

    handleSavingsSettings() {
        const asset = state.investment.assets[state.investment.currentAsset];
        if (!asset) return;
        const input = document.getElementById("inv-savings-min");
        const minDep = this.parseAmount(input.value);
        if (minDep === null || minDep < 0) {
            this.toast("Masukkan minimal nabung yang valid.");
            return;
        }
        asset.minDeposit = minDep;
        this.saveState();
        this.toast("Pengaturan disimpan ✨");
    },

    handleBalanceCorrection() {
        const asset = state.investment.assets[state.investment.currentAsset];
        if (!asset) return;

        if (asset.type === "savings") {
            this.openSheet({
                title: "Edit Saldo (Koreksi Manual)",
                fields: [
                    {
                        id: "balance",
                        label: "Saldo Celengan (Rp)",
                        type: "text",
                        inputmode: "numeric",
                        placeholder: String(asset.balance)
                    }
                ],
                confirmLabel: "Simpan Koreksi",
                onConfirm: values => {
                    const bal = this.parseAmount(values.balance);
                    if (bal === null || bal < 0)
                        return "Masukkan jumlah yang valid.";
                    asset.balance = bal;
                    this.saveState();
                    this.renderInvestmentAsset();
                    this.renderInvestmentView();
                    this.renderHome();
                    this.toast("Saldo dikoreksi ✨");
                    return null;
                }
            });
            return;
        }

        this.openSheet({
            title: "Edit Saldo (Koreksi Manual)",
            message: "Kosongkan field yang gak mau diubah.",
            fields: [
                {
                    id: "exchange",
                    label: "Saldo Exchange (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(asset.exchangeTotal)
                },
                {
                    id: "cycle",
                    label: "Saldo Siklus Saat Ini (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(asset.cycleAmount)
                },
                {
                    id: "pending",
                    label: "Saldo Belum Ditop Up (Rp)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(asset.pendingAmount)
                }
            ],
            confirmLabel: "Simpan Koreksi",
            onConfirm: values => {
                const exch = this.parseAmount(values.exchange);
                const cyc = this.parseAmount(values.cycle);
                const pend = this.parseAmount(values.pending);

                if (values.exchange.trim() !== "" && exch !== null && exch >= 0)
                    asset.exchangeTotal = exch;
                if (values.cycle.trim() !== "" && cyc !== null && cyc >= 0)
                    asset.cycleAmount = cyc;
                if (values.pending.trim() !== "" && pend !== null && pend >= 0)
                    asset.pendingAmount = pend;

                asset.balance = asset.exchangeTotal + asset.pendingAmount;

                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast("Saldo dikoreksi ✨");
                return null;
            }
        });
    },

    handleTopUp() {
        const asset = state.investment.assets[state.investment.currentAsset];
        if (asset.pendingAmount <= 0) {
            this.toast("Belum ada saldo yang bisa ditop up.");
            return;
        }
        this.openSheet({
            title: "Top Up ke Exchange",
            fields: [
                {
                    id: "amount",
                    label: `Jumlah (Rp) — Tersedia: ${this.formatCurrency(asset.pendingAmount)}`,
                    type: "text",
                    inputmode: "numeric",
                    placeholder: ""
                }
            ],
            confirmLabel: "Top Up",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0)
                    return "Masukkan jumlah yang valid.";
                if (amount > asset.pendingAmount)
                    return "Saldo belum ditop up tidak cukup.";

                asset.pendingAmount -= amount;
                asset.exchangeTotal += amount;
                asset.balance = asset.exchangeTotal + asset.pendingAmount;
                asset.topupLog.push({ amount, timestamp: Date.now() });
                asset.history.push(
                    this.makeEntry(
                        "topup",
                        "Top Up ke Exchange",
                        "TOP UP",
                        "badge-buy",
                        0
                    )
                );

                this.saveState();
                this.renderInvestmentAsset();
                this.toast(
                    `Top Up berhasil! +${this.formatCurrency(amount)} ke Exchange ✨`
                );
                return null;
            }
        });
    },

    confirmDeleteInvestmentEntry(timestamp) {
        this.openSheet({
            title: "Hapus Transaksi?",
            message:
                "Transaksi ini akan dihapus permanen dan saldo aset akan disesuaikan.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                this.removeInvestmentHistoryEntry(timestamp);
                return null;
            }
        });
    },

    removeInvestmentHistoryEntry(timestamp) {
        const asset = state.investment.assets[state.investment.currentAsset];
        const idx = asset.history.findIndex(e => e.timestamp === timestamp);
        if (idx === -1) return;

        const entry = asset.history[idx];
        if (asset.type === "savings") {
            if (entry.kind === "deposit") {
                asset.balance -= entry.pnlValue;
                asset.deposited -= entry.pnlValue;
            } else if (entry.kind === "withdraw") {
                asset.balance -= entry.pnlValue;
            }
        } else {
            if (entry.kind === "deposit") {
                asset.pendingAmount -= entry.pnlValue;
                asset.deposited -= entry.pnlValue;
                asset.cycleAmount -= entry.pnlValue;
            } else if (entry.kind === "withdraw") {
                asset.exchangeTotal -= entry.pnlValue;
            }
            asset.balance = asset.exchangeTotal + asset.pendingAmount;
        }

        asset.history.splice(idx, 1);
        this.saveState();
        this.renderInvestmentAsset();
        this.renderInvestmentView();
        this.renderHome();
        this.toast("Transaksi dihapus.");
    },

    confirmDeleteAsset() {
        const name = state.investment.currentAsset;
        this.openSheet({
            title: `Hapus Aset "${name}"?`,
            message:
                "Aset ini beserta seluruh riwayat transaksinya akan dihapus permanen.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                delete state.investment.assets[name];
                state.investment.currentAsset = null;
                this.saveState();
                this.renderInvestmentView();
                this.renderHome();
                this.navigate("investment");
                this.toast("Aset dihapus.");
                return null;
            }
        });
    },

    confirmDeleteAssetFromList(name) {
        this.openSheet({
            title: `Hapus Aset "${name}"?`,
            message:
                "Aset ini beserta seluruh riwayat transaksinya akan dihapus permanen.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                delete state.investment.assets[name];
                this.saveState();
                this.renderInvestmentView();
                this.renderHome();
                this.toast("Aset dihapus.");
                return null;
            }
        });
    },

    // ============================================
    // THEME / TOAST
    // ============================================
    toggleTheme() {
        const html = document.documentElement;
        if (this.currentTheme === "dark") {
            html.removeAttribute("data-theme");
            this.currentTheme = "light";
        } else {
            html.setAttribute("data-theme", "dark");
            this.currentTheme = "dark";
        }
        const settingToggle = document.getElementById("setting-theme");
        if (settingToggle) settingToggle.checked = this.currentTheme === "dark";
    },

    toast(message) {
        const toastEl = document.getElementById("toast");
        toastEl.textContent = message;
        toastEl.classList.add("show");
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(
            () => toastEl.classList.remove("show"),
            2600
        );
    },

    // ============================================
    // BOTTOM SHEET
    // ============================================
    openSheet({
        title,
        message,
        fields = [],
        confirmLabel = "Konfirmasi",
        danger = false,
        onConfirm
    }) {
        document.getElementById("sheet-title").textContent = title;
        document.getElementById("sheet-error").textContent = "";

        const body = document.getElementById("sheet-body");
        body.innerHTML = "";

        if (message) {
            const p = document.createElement("p");
            p.className = "sheet-message";
            p.textContent = message;
            body.appendChild(p);
        }

        fields.forEach(field => {
            const wrap = document.createElement("div");
            wrap.className = "sheet-field";
            const label = document.createElement("label");
            label.textContent = field.label;
            wrap.appendChild(label);

            if (field.type === "segmented") {
                const seg = document.createElement("div");
                seg.className = "segmented";
                seg.id = `sheet-input-${field.id}`;
                seg.dataset.value = field.default || field.options[0];

                let warnEl = null;
                if (field.warnMap) {
                    warnEl = document.createElement("p");
                    warnEl.className = "sheet-warning-text hidden";
                    const initialWarn = field.warnMap[seg.dataset.value];
                    if (initialWarn) {
                        warnEl.textContent = initialWarn;
                        warnEl.classList.remove("hidden");
                    }
                }

                field.options.forEach(opt => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className =
                        "segmented-option" +
                        (opt === seg.dataset.value ? " active" : "");
                    btn.textContent = opt;
                    btn.addEventListener("click", () => {
                        seg.dataset.value = opt;
                        seg.querySelectorAll(".segmented-option").forEach(b =>
                            b.classList.remove("active")
                        );
                        btn.classList.add("active");
                        if (warnEl) {
                            const w = field.warnMap[opt];
                            if (w) {
                                warnEl.textContent = w;
                                warnEl.classList.remove("hidden");
                            } else {
                                warnEl.classList.add("hidden");
                            }
                        }
                    });
                    seg.appendChild(btn);
                });
                wrap.appendChild(seg);
                if (warnEl) wrap.appendChild(warnEl);
            } else if (field.type === "checklist") {
                const list = document.createElement("div");
                list.className = "checklist";
                list.id = `sheet-input-${field.id}`;
                list.dataset.value = "[]";
                field.options.forEach(opt => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "checklist-option";
                    btn.textContent = opt;
                    btn.addEventListener("click", () => {
                        let selected = JSON.parse(list.dataset.value);
                        if (selected.includes(opt)) {
                            selected = selected.filter(v => v !== opt);
                            btn.classList.remove("active");
                        } else {
                            selected.push(opt);
                            btn.classList.add("active");
                        }
                        list.dataset.value = JSON.stringify(selected);
                    });
                    list.appendChild(btn);
                });
                wrap.appendChild(list);
            } else if (field.type === "textarea") {
                const textarea = document.createElement("textarea");
                textarea.className = "sheet-input";
                textarea.id = `sheet-input-${field.id}`;
                textarea.rows = 3;
                if (field.placeholder) textarea.placeholder = field.placeholder;
                wrap.appendChild(textarea);
            } else {
                const input = document.createElement("input");
                input.className = "sheet-input";
                input.id = `sheet-input-${field.id}`;
                input.type = field.type || "text";
                if (field.placeholder) input.placeholder = field.placeholder;
                if (field.inputmode) input.inputMode = field.inputmode;
                if (field.value !== undefined) input.value = field.value;
                wrap.appendChild(input);
            }
            body.appendChild(wrap);
        });

        const confirmBtn = document.getElementById("sheet-confirm-btn");
        confirmBtn.textContent = confirmLabel;
        confirmBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");

        const newBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
        newBtn.addEventListener("click", () => {
            const values = {};
            fields.forEach(field => {
                const el = document.getElementById(`sheet-input-${field.id}`);
                if (field.type === "segmented") {
                    values[field.id] = el.dataset.value;
                } else if (field.type === "checklist") {
                    values[field.id] = JSON.parse(el.dataset.value || "[]");
                } else {
                    values[field.id] = el.value;
                }
            });
            const error = onConfirm(values);
            if (error) {
                document.getElementById("sheet-error").textContent = error;
            } else {
                this.closeSheet();
            }
        });

        document.getElementById("sheet-overlay").classList.add("active");
        document.getElementById("bottom-sheet").classList.add("open");

        setTimeout(() => {
            const first = body.querySelector("input.sheet-input");
            if (first) first.focus();
        }, 300);
    },

    closeSheet() {
        document.getElementById("sheet-overlay").classList.remove("active");
        document.getElementById("bottom-sheet").classList.remove("open");
    },

    parseAmount(raw) {
        if (raw === null || raw === undefined) return null;
        const cleaned = String(raw)
            .trim()
            .replace(/[.\s]/g, "")
            .replace(/,/g, ".");
        if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
        const num = Number(cleaned);
        if (!Number.isFinite(num)) return null;
        return Math.round(num);
    },

    parseDecimal(raw) {
        if (raw === null || raw === undefined) return null;
        const cleaned = String(raw).trim().replace(/,/g, ".");
        if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
    },

    formatUSC(value) {
        const usc = Math.round(value);
        const usd = (usc / 100).toFixed(2);
        return `${usc.toLocaleString("id-ID")} USC ($${usd})`;
    },

    // ============================================
    // JOURNAL — RISK GUARD & TRADE PSYCHOLOGY
    // ============================================
    handleSetPeakBalance() {
        const input = document.getElementById("journal-peak-input");
        const val = this.parseAmount(input.value);
        if (val === null || val <= 0) {
            this.toast("Masukkan peak balance yang valid (USC).");
            return;
        }
        const j = state.journal;
        j.peakBalance = val;
        j.currentBalance = val;
        j.peakDate = this.todayISO();
        j.lockdownActive = false;
        this.saveState();
        this.renderJournal();
        this.toast("Peak balance hari ini disimpan ✨");
    },

    handleJournalSettings() {
        const j = state.journal;
        this.openSheet({
            title: "Pengaturan Trading",
            message:
                "Kurs dipakai untuk konversi P/L (USC) ke Rupiah. Max Daily Loss dipakai untuk Risk Guard.",
            fields: [
                {
                    id: "rate",
                    label: "Kurs 1 USD = Rp",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(j.exchangeRate)
                },
                {
                    id: "maxLoss",
                    label: "Max Daily Loss (USC)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: String(j.maxLoss)
                }
            ],
            confirmLabel: "Simpan",
            onConfirm: values => {
                const rate = this.parseAmount(values.rate);
                if (rate === null || rate <= 0)
                    return "Masukkan kurs yang valid.";
                const maxLoss = this.parseAmount(values.maxLoss);
                if (maxLoss === null || maxLoss <= 0)
                    return "Masukkan Max Daily Loss yang valid.";
                j.exchangeRate = rate;
                j.maxLoss = maxLoss;
                this.saveState();
                this.renderJournal();
                this.toast("Pengaturan disimpan ✨");
                return null;
            }
        });
    },

    checkJournalPeakReset() {
        const j = state.journal;
        if (j.peakDate && j.peakDate !== this.todayISO()) {
            j.peakBalance = 0;
            j.currentBalance = 0;
            j.peakDate = null;
            j.lockdownActive = false;
        }
    },

    renderJournal() {
        this.checkJournalPeakReset();
        const j = state.journal;

        const peakInput = document.getElementById("journal-peak-input");
        if (peakInput && j.peakDate === this.todayISO()) {
            peakInput.value = j.peakBalance;
        }

        const dynamicLimit = j.peakDate ? j.peakBalance - j.maxLoss : 0;
        document.getElementById("journal-limit-text").textContent = j.peakDate
            ? this.formatUSC(dynamicLimit)
            : "Belum diatur";

        const fillEl = document.getElementById("journal-health-fill");
        const badgeEl = document.getElementById("journal-risk-badge");
        const addBtn = document.getElementById("journal-add-trade-btn");

        if (!j.peakDate) {
            fillEl.style.width = "100%";
            fillEl.className = "health-bar-fill";
            badgeEl.className = "badge";
            badgeEl.textContent =
                "Set peak balance dulu untuk mulai tracking risiko.";
        } else {
            const pct = Math.max(
                0,
                Math.min(
                    100,
                    ((j.currentBalance - dynamicLimit) / j.maxLoss) * 100
                )
            );

            if (j.currentBalance <= dynamicLimit) {
                fillEl.className = "health-bar-fill zone-red";
                badgeEl.className = "badge loss";
                badgeEl.textContent = "LOCKDOWN AKTIF";
                j.lockdownActive = true;
            } else if (pct <= 30) {
                fillEl.className = "health-bar-fill zone-red";
                badgeEl.className = "badge loss";
                badgeEl.textContent =
                    "Peringatan: Mendekati Batas Trailing Loss!";
            } else if (pct <= 69) {
                fillEl.className = "health-bar-fill zone-yellow";
                badgeEl.className = "badge warning";
                badgeEl.textContent =
                    "Peringatan: Mendekati Batas Trailing Loss!";
            } else {
                fillEl.className = "health-bar-fill";
                badgeEl.className = "badge profit";
                badgeEl.textContent = "Sistem Aman. Tetap Disiplin!";
            }
        }

        const lockdownOverlay = document.getElementById("lockdown-overlay");
        if (j.lockdownActive) {
            document.getElementById("lockdown-message").textContent =
                `Max Daily Loss -${j.maxLoss} USC Tersentuh. Matikan Aplikasi & Rehat!`;
            lockdownOverlay.classList.add("active");
            addBtn.disabled = true;
            addBtn.style.opacity = "0.4";
            addBtn.style.pointerEvents = "none";
        } else {
            addBtn.disabled = false;
            addBtn.style.opacity = "1";
            addBtn.style.pointerEvents = "auto";
        }

        this.renderJournalActiveList();
        this.renderJournalStats();
    },

    dismissLockdown() {
        document.getElementById("lockdown-overlay").classList.remove("active");
    },

    handleAddJournalTrade() {
        if (state.journal.lockdownActive) {
            this.toast("Lockdown aktif — rehat dulu, bro.");
            return;
        }
        this.openSheet({
            title: "Tambah Trade Baru",
            fields: [
                { id: "pair", label: "Pair", type: "text", placeholder: "" },
                {
                    id: "type",
                    label: "Jenis",
                    type: "segmented",
                    options: ["BUY", "SELL"],
                    default: "BUY"
                },
                {
                    id: "entry",
                    label: "Entry Price",
                    type: "text",
                    inputmode: "decimal",
                    placeholder: ""
                },
                {
                    id: "sl",
                    label: "SL Price",
                    type: "text",
                    inputmode: "decimal",
                    placeholder: ""
                },
                {
                    id: "lot",
                    label: "Lot Size",
                    type: "text",
                    inputmode: "decimal",
                    value: "0.01"
                },
                {
                    id: "pip",
                    label: "Pip Size (buat hitung TP)",
                    type: "text",
                    inputmode: "decimal",
                    value: "0.0001"
                },
                {
                    id: "reasons",
                    label: "Kenapa Entry? (bisa pilih lebih dari 1)",
                    type: "checklist",
                    options: [
                        "Fundamental / Macro Data",
                        "Technical Setup",
                        "Live Stream Signal",
                        "Own Zone Validation"
                    ]
                },
                {
                    id: "note",
                    label: "Kenapa yakin sama trade ini, bro?",
                    type: "textarea",
                    placeholder: ""
                },
                {
                    id: "mood",
                    label: "Kondisi Psikologi Saat Ini",
                    type: "segmented",
                    options: ["😎 Calm", "🔥 Hyped", "😡 Revenge", "😨 FOMO"],
                    default: "😎 Calm",
                    warnMap: {
                        "😡 Revenge":
                            "⚠️ Otak sedang terdistraksi dopamin! Kecilkan lot atau tunda entry 10 menit dulu.",
                        "😨 FOMO":
                            "⚠️ Otak sedang terdistraksi dopamin! Kecilkan lot atau tunda entry 10 menit dulu."
                    }
                }
            ],
            confirmLabel: "Tambah Trade",
            onConfirm: values => {
                const pair = values.pair.trim();
                if (!pair) return "Pair tidak boleh kosong.";
                const entry = this.parseDecimal(values.entry);
                if (entry === null) return "Entry price harus angka valid.";
                const sl = this.parseDecimal(values.sl);
                if (sl === null) return "SL price harus angka valid.";
                const lot = this.parseDecimal(values.lot);
                if (lot === null || lot <= 0)
                    return "Lot size harus angka valid.";
                const pip = this.parseDecimal(values.pip) || 0.0001;
                if (values.reasons.length === 0)
                    return "Pilih minimal 1 alasan entry.";

                const trade = {
                    id: Date.now() + Math.random().toString(36).slice(2),
                    timestamp: Date.now(),
                    day: this.todayKey(),
                    pair: pair.toUpperCase(),
                    type: values.type,
                    entryPrice: entry,
                    slPrice: sl,
                    lot,
                    pipSize: pip,
                    reasons: values.reasons,
                    reasonNote: values.note.trim(),
                    mood: values.mood,
                    tp: { tp1: false, tp2: false, tp3: false },
                    status: "open",
                    pnlUSC: null
                };

                state.journal.trades.push(trade);
                this.saveState();
                this.renderJournal();
                this.toast("Trade baru dicatat 📝");
                return null;
            }
        });
    },

    toggleTP(tradeId, level) {
        const trade = state.journal.trades.find(t => t.id === tradeId);
        if (!trade) return;
        const key = "tp" + level;
        trade.tp[key] = !trade.tp[key];
        this.saveState();
        this.renderJournal();
        if (level === 1 && trade.tp.tp1) {
            this.toast(
                "🔔 WAJIB SET BREAK EVEN (SL BE) DI HARGA ENTRY SEKARANG!"
            );
        }
    },

    handleCloseJournalTrade(tradeId) {
        const trade = state.journal.trades.find(t => t.id === tradeId);
        if (!trade) return;
        this.openSheet({
            title: "Tutup Posisi",
            message: `${trade.pair} — ${trade.type}`,
            fields: [
                {
                    id: "sign",
                    label: "Hasil",
                    type: "segmented",
                    options: ["Profit", "Loss"],
                    default: "Profit"
                },
                {
                    id: "amount",
                    label: "Jumlah (USC)",
                    type: "text",
                    inputmode: "numeric",
                    placeholder: ""
                }
            ],
            confirmLabel: "Tutup Posisi",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0)
                    return "Masukkan jumlah yang valid.";

                const pnlUSC = values.sign === "Loss" ? -amount : amount;
                trade.status = "closed";
                trade.pnlUSC = pnlUSC;
                trade.closedAt = Date.now();

                const j = state.journal;
                j.currentBalance += pnlUSC;
                if (j.currentBalance > j.peakBalance) {
                    j.peakBalance = j.currentBalance;
                }

                const pnlIDR = Math.round((pnlUSC / 100) * j.exchangeRate);
                const cat = state.forex;
                cat.balance += pnlIDR;
                cat.pnlTotal += pnlIDR;
                cat.history.push(
                    this.makeEntry(
                        "trade",
                        trade.pair,
                        trade.type,
                        trade.type === "BUY" ? "badge-buy" : "badge-sell",
                        pnlIDR
                    )
                );

                this.saveState();
                this.renderJournal();
                this.renderTradingHub();
                this.renderHome();
                this.renderStats();
                this.toast(
                    pnlUSC >= 0
                        ? "Posisi ditutup, cuan dicatat 🚀"
                        : "Posisi ditutup, loss dicatat. Tetap disiplin ya."
                );
                return null;
            }
        });
    },

    confirmDeleteJournalTrade(tradeId) {
        this.openSheet({
            title: "Hapus Posisi?",
            message:
                "Posisi aktif ini akan dihapus tanpa dicatat sebagai hasil.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                state.journal.trades = state.journal.trades.filter(
                    t => t.id !== tradeId
                );
                this.saveState();
                this.renderJournal();
                this.toast("Posisi dihapus.");
                return null;
            }
        });
    },

    renderJournalActiveList() {
        const container = document.getElementById("journal-active-list");
        const active = state.journal.trades.filter(t => t.status === "open");
        container.innerHTML = "";

        if (active.length === 0) {
            container.innerHTML =
                '<p class="empty-state">Belum ada posisi trading aktif.</p>';
            return;
        }

        active
            .slice()
            .reverse()
            .forEach(trade => {
                const reasonTags = trade.reasons
                    .map(r => `<span class="reason-tag">${r}</span>`)
                    .join("");
                const card = document.createElement("div");
                card.className = "card journal-position-card";
                card.innerHTML = `
                <div class="journal-position-head">
                    <div>
                        <h3>${trade.pair} <span class="hist-badge ${trade.type === "BUY" ? "badge-buy" : "badge-sell"}">${trade.type}</span></h3>
                        <p style="color:var(--text-secondary); font-size:0.85rem; margin-top:4px;">Lot ${trade.lot} • Entry ${trade.entryPrice} • <span class="mood-badge">${trade.mood}</span></p>
                    </div>
                    <button class="journal-position-close-btn" onclick="app.handleCloseJournalTrade('${trade.id}')">Tutup</button>
                </div>
                <div style="margin-top:12px;">${reasonTags}</div>
                <div class="tp-row">
                    <button class="tp-btn ${trade.tp.tp1 ? "reached" : ""}" onclick="app.toggleTP('${trade.id}', 1)">TP1 +50p</button>
                    <button class="tp-btn ${trade.tp.tp2 ? "reached" : ""}" onclick="app.toggleTP('${trade.id}', 2)">TP2 +100p</button>
                    <button class="tp-btn ${trade.tp.tp3 ? "reached" : ""}" onclick="app.toggleTP('${trade.id}', 3)">TP3 +150p</button>
                </div>
                ${trade.tp.tp1 ? '<div class="be-reminder">🔔 WAJIB SET BREAK EVEN (SL BE) DI HARGA ENTRY SEKARANG!</div>' : ""}
                <button class="hist-delete" style="margin-top:12px;" onclick="app.confirmDeleteJournalTrade('${trade.id}')" aria-label="Hapus posisi">
                    <i class="fa-solid fa-trash"></i> <span style="font-size:0.8rem; margin-left:4px;">Hapus Posisi</span>
                </button>
            `;
                container.appendChild(card);
            });
    },

    renderJournalStats() {
        const closed = state.journal.trades.filter(t => t.status === "closed");

        const buildBars = (containerId, groupKeyFn) => {
            const container = document.getElementById(containerId);
            container.innerHTML = "";
            if (closed.length === 0) {
                container.innerHTML =
                    '<p class="empty-state">Belum ada trade selesai.</p>';
                return;
            }
            const groups = {};
            closed.forEach(t => {
                const keys = groupKeyFn(t);
                keys.forEach(key => {
                    if (!groups[key]) groups[key] = { win: 0, total: 0 };
                    groups[key].total += 1;
                    if (t.pnlUSC >= 0) groups[key].win += 1;
                });
            });
            Object.keys(groups).forEach(key => {
                const g = groups[key];
                const pct = Math.round((g.win / g.total) * 100);
                const row = document.createElement("div");
                row.className = "stat-bar-row";
                row.innerHTML = `
                    <div class="stat-bar-label">
                        <span>${key}</span>
                        <span class="text-accent" style="font-weight:700;">${pct}% (${g.win}/${g.total})</span>
                    </div>
                    <div class="stat-bar-track">
                        <div class="stat-bar-fill" style="width:${pct}%;"></div>
                    </div>
                `;
                container.appendChild(row);
            });
        };

        buildBars("journal-stats-reason", t => t.reasons);
        buildBars("journal-stats-mood", t => [t.mood]);
    }
};

document.addEventListener("DOMContentLoaded", () => {
    app.init();
});
