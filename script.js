/* =========================================================
   TRADEBOOK - Core JavaScript Application Logic
   (Multi-account Trading Hub + Journal Risk Guard, USD-based)
========================================================= */
const SUPABASE_URL = "https://wdkwiwpcxkbxwkbtukvy.supabase.co";
const SUPABASE_KEY = "sb_publishable_7kxe4wFEQSxLcc0lPEL3kw_GCQy2vIB";
let sb = null;
try {
    if (typeof supabase !== "undefined") {
        sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    } else {
        console.error("Supabase SDK gagal dimuat — app tetap jalan mode lokal.");
    }
} catch (e) {
    console.error("Gagal bikin Supabase client — app tetap jalan mode lokal:", e);
}

const state = {
    investment: { assets: {}, currentAsset: null },
    trading: {
        accounts: {},
        currentAccountId: null,
        monthId: null,
        monthlyHistory: []
    }
};

const app = {
    isBalanceHidden: false,
    currentTheme: "dark",
    exitArmed: false,

    // ============================================
    // PERSISTENCE
    // ============================================
    saveState() {
        try {
            localStorage.setItem("tradebook_state", JSON.stringify(state));
        } catch (e) {
            console.error("Gagal menyimpan data:", e);
        }
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.syncToSupabase(), 1000);
    },

    makeDefaultAccount(name) {
        return {
            id: "acc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: name || "Akun Utama",
            balance: 0,
            deposited: 0,
            pnlTotal: 0,
            history: [],
            journal: {
                exchangeRate: 15800,
                startBalance: 0,
                peakBalance: 0,
                currentBalance: 0,
                peakDate: null,
                trades: []
            }
        };
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
                        if (!asset.cycleStart) asset.cycleStart = this.todayISO();
                        if (asset.cycleAmount === undefined) asset.cycleAmount = 0;
                        if (asset.cycleTarget === undefined) asset.cycleTarget = 150000;
                        if (asset.minDeposit === undefined) asset.minDeposit = 5000;
                        if (asset.exchangeTotal === undefined) asset.exchangeTotal = asset.balance || 0;
                        if (asset.pendingAmount === undefined) asset.pendingAmount = 0;
                        if (!asset.topupLog) asset.topupLog = [];
                    } else {
                        if (asset.minDeposit === undefined) asset.minDeposit = 3000;
                    }
                });
            }

            if (saved.trading && saved.trading.accounts) {
                state.trading = Object.assign(
                    { accounts: {}, currentAccountId: null, monthId: null, monthlyHistory: [] },
                    saved.trading
                );
                Object.values(state.trading.accounts).forEach(acc => {
                    if (!acc.journal) acc.journal = { exchangeRate: 15800, startBalance: 0, peakBalance: 0, currentBalance: 0, peakDate: null, trades: [] };
                    if (acc.journal.exchangeRate === undefined) acc.journal.exchangeRate = 15800;
                    if (!acc.journal.trades) acc.journal.trades = [];
                });
            } else if (saved.forex) {
                // Migrasi dari struktur lama (single account)
                const acc = this.makeDefaultAccount("Akun Utama");
                acc.balance = saved.forex.balance || 0;
                acc.deposited = saved.forex.deposited || 0;
                acc.pnlTotal = saved.forex.pnlTotal || 0;
                acc.history = saved.forex.history || [];
                if (saved.journal) {
                    acc.journal.exchangeRate = saved.journal.exchangeRate || 15800;
                    acc.journal.startBalance = saved.journal.startBalance || 0;
                    acc.journal.peakBalance = saved.journal.peakBalance || 0;
                    acc.journal.currentBalance = saved.journal.currentBalance || 0;
                    acc.journal.peakDate = saved.journal.peakDate || null;
                    acc.journal.trades = saved.journal.trades || [];
                    // Migrasi unit cent -> USD kalau masih data lama
                    if (saved.journal.unit !== "usd") {
                        acc.journal.startBalance /= 100;
                        acc.journal.peakBalance /= 100;
                        acc.journal.currentBalance /= 100;
                        acc.journal.trades = acc.journal.trades.map(t =>
                            t.pnlUSC === null || t.pnlUSC === undefined ? t : Object.assign({}, t, { pnlUSC: t.pnlUSC / 100 })
                        );
                    }
                }
                state.trading.accounts[acc.id] = acc;
                state.trading.monthId = saved.forex.monthId || null;
                state.trading.monthlyHistory = saved.forex.monthlyHistory || [];
            }
        } catch (e) {
            console.error("Gagal memuat data tersimpan:", e);
        }
    },

    currentUser: null,
    syncTimer: null,

    async init() {
        // App langsung jalan dari data lokal, gak nunggu apa-apa.
        this.loadState();
        this.setDate();
        this.renderHome();
        this.renderTradingAccountsList();
        this.renderStats();
        this.renderInvestmentView();
        this.attachRipples();

        history.replaceState({ view: "home" }, "", "#home");
        history.pushState({ view: "home" }, "", "#home");
        this.exitArmed = false;
        window.addEventListener("popstate", e => {
            const sheet = document.getElementById("bottom-sheet");
            if (sheet.classList.contains("open")) {
                this.closeSheet();
                history.pushState({ view: "current" }, "", location.hash);
                return;
            }

            const view = (e.state && e.state.view) || "home";
            const currentlyOnHome = document.getElementById("view-home").classList.contains("active");

            if (view === "home" && currentlyOnHome) {
                if (this.exitArmed) return;
                this.exitArmed = true;
                this.toast("Tekan sekali lagi untuk keluar aplikasi");
                history.pushState({ view: "home" }, "", "#home");
                clearTimeout(this._exitTimer);
                this._exitTimer = setTimeout(() => {
                    this.exitArmed = false;
                }, 2000);
                return;
            }

            this.navigate(view, true);
        });

        // Cek diam-diam kalau kamu udah pernah login sebelumnya (opsional, gak ngeblokir apa-apa)
        this.checkExistingSession();

        console.log("TradeBook App Initialized! 🚀");
    },

    async checkExistingSession() {
        if (!sb) { this.updateAuthUI(null); return; }
        try {
            const { data: { session } } = await sb.auth.getSession();
            if (session) await this.onAuthSuccess(session.user, true);
            else this.updateAuthUI(null);
        } catch (e) {
            console.error("Gagal cek sesi Supabase:", e);
            this.updateAuthUI(null);
        }
    },

    updateAuthUI(user) {
        const guestSection = document.getElementById("auth-guest-section");
        const userSection = document.getElementById("auth-user-section");
        if (!guestSection || !userSection) return;
        if (user) {
            guestSection.style.display = "none";
            userSection.style.display = "block";
            document.getElementById("auth-user-email").textContent = user.email;
        } else {
            guestSection.style.display = "block";
            userSection.style.display = "none";
        }
    },

    async handleLogin() {
        const errEl = document.getElementById("auth-error");
        if (!sb) { errEl.textContent = "Fitur cloud lagi gak bisa diakses (koneksi ke Supabase gagal). Coba lagi nanti."; return; }
        const email = document.getElementById("auth-email").value.trim();
        const password = document.getElementById("auth-password").value;
        errEl.textContent = "";
        if (!email || !password) { errEl.textContent = "Isi email dan password dulu."; return; }
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) { errEl.textContent = error.message; return; }
        await this.onAuthSuccess(data.user);
    },

    async handleSignup() {
        const errEl = document.getElementById("auth-error");
        if (!sb) { errEl.textContent = "Fitur cloud lagi gak bisa diakses (koneksi ke Supabase gagal). Coba lagi nanti."; return; }
        const email = document.getElementById("auth-email").value.trim();
        const password = document.getElementById("auth-password").value;
        errEl.textContent = "";
        if (!email || !password || password.length < 6) { errEl.textContent = "Isi email valid & password minimal 6 karakter."; return; }
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) { errEl.textContent = error.message; return; }
        document.getElementById("auth-status").textContent = "Akun dibuat! Cek email buat verifikasi (kalau diminta), lalu tekan Masuk.";
    },

    // silent = true kalau ini auto-login pas buka app (bukan dari tombol Masuk manual)
    async onAuthSuccess(user, silent) {
        this.currentUser = user;
        this.updateAuthUI(user);

        try {
            const { data } = await sb.from("user_data").select("data").eq("user_id", user.id).maybeSingle();
            if (data && data.data && Object.keys(data.data).length > 0) {
                Object.assign(state, data.data);
                if (!silent) this.toast("Data dari cloud berhasil dimuat ✨");
            } else {
                // Belum ada data di cloud -> upload data lokal yang sekarang sebagai awalan
                this.syncToSupabase();
                if (!silent) this.toast("Login berhasil, data lokal kamu mulai di-backup 🚀");
            }
        } catch (e) {
            console.error("Gagal ambil data dari Supabase:", e);
        }

        this.saveState();
        this.renderHome();
        this.renderTradingAccountsList();
        this.renderStats();
        this.renderInvestmentView();
    },

    async syncToSupabase() {
        if (!sb || !this.currentUser) return;
        try {
            await sb.from("user_data").upsert({
                user_id: this.currentUser.id,
                data: state,
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            console.error("Gagal sync ke Supabase:", e);
        }
    },

    handleLogout() {
        if (sb) sb.auth.signOut();
        this.currentUser = null;
        this.updateAuthUI(null);
        this.toast("Berhasil keluar. Data tetap tersimpan lokal di HP ini.");
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
        const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
        dateElement.textContent = new Date().toLocaleDateString("en-US", options);
    },

    formatCurrency(value) {
        return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(value);
    },

    formatCompactIDR(value) {
        const abs = Math.abs(value);
        let str;
        if (abs >= 1000000) str = (abs / 1000000).toFixed(1).replace(/\.0$/, "") + "jt";
        else if (abs >= 1000) str = Math.round(abs / 1000) + "rb";
        else str = String(Math.round(abs));
        return (value >= 0 ? "+" : "-") + "Rp" + str;
    },

    formatUSD(value) {
        return `$${value.toFixed(2)}`;
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

    startOfDay(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    },

    getMonthId(date) {
        const d = new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    },

    monthLabel(monthId) {
        const [y, m] = monthId.split("-").map(Number);
        const months = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
        return `${months[m - 1]} ${y}`;
    },

    formatAllBalances() {
        document.querySelectorAll(".balance-amount").forEach(el => {
            const val = el.getAttribute("data-value");
            if (val !== null) el.textContent = this.isBalanceHidden ? "Rp ••••••••" : this.formatCurrency(val);
        });
    },

    setBalance(el, value) {
        const oldValue = parseFloat(el.getAttribute("data-value")) || 0;
        const newValue = Number(value);
        el.setAttribute("data-value", newValue);
        if (this.isBalanceHidden) { el.textContent = "Rp ••••••••"; return; }
        if (oldValue === newValue) { el.textContent = this.formatCurrency(newValue); return; }
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
        if (this.isBalanceHidden) { eyeIcon.classList.remove("fa-eye"); eyeIcon.classList.add("fa-eye-slash"); }
        else { eyeIcon.classList.remove("fa-eye-slash"); eyeIcon.classList.add("fa-eye"); }
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
        overlay.onclick = () => { sidebar.classList.remove("open"); overlay.classList.remove("active"); };
    },

    navigate(viewId, skipPush) {
        document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
        document.getElementById(`view-${viewId}`).classList.add("active");
        document.getElementById("sidebar").classList.remove("open");
        document.getElementById("overlay").classList.remove("active");
        window.scrollTo(0, 0);

        if (!skipPush) {
            const currentView = history.state && history.state.view;
            // Cuma tambah entry baru kalau beneran pindah ke halaman berbeda —
            // biar buka halaman yang sama berkali-kali gak numpuk history.
            if (currentView !== viewId) {
                history.pushState({ view: viewId }, "", "#" + viewId);
            }
        }
    },

    // ============================================
    // TRADING — MULTI ACCOUNT
    // ============================================
    allAccounts() {
        return Object.values(state.trading.accounts);
    },

    combinedHistory() {
        const out = [];
        this.allAccounts().forEach(acc => acc.history.forEach(h => out.push(h)));
        return out;
    },

    tradingTotal() {
        return this.allAccounts().reduce((sum, a) => sum + a.balance, 0);
    },

    totalBalance() {
        return this.investmentBalance() + this.tradingTotal();
    },

    investmentBalance() {
        return Object.values(state.investment.assets).reduce((sum, a) => sum + a.balance, 0);
    },

    sumMonthTrades(monthId) {
        let sum = 0;
        this.combinedHistory().forEach(t => {
            if (t.kind === "trade" && this.getMonthId(new Date(t.timestamp)) === monthId) sum += t.pnlValue;
        });
        return sum;
    },

    checkMonthRollover() {
        const t = state.trading;
        const currentMonthId = this.getMonthId(new Date());

        if (!t.monthId) { t.monthId = currentMonthId; return; }
        if (t.monthId === currentMonthId) return;

        const oldMonthId = t.monthId;
        let profit = 0, loss = 0, trades = 0;
        this.combinedHistory().forEach(h => {
            if (h.kind !== "trade") return;
            if (this.getMonthId(new Date(h.timestamp)) !== oldMonthId) return;
            trades += 1;
            if (h.pnlValue >= 0) profit += h.pnlValue; else loss += Math.abs(h.pnlValue);
        });
        const net = profit - loss;

        const closedTrades = [];
        this.allAccounts().forEach(acc => {
            acc.journal.trades.forEach(tr => {
                if (tr.status === "closed" && tr.closedDate && tr.closedDate.startsWith(oldMonthId)) closedTrades.push(tr);
            });
        });
        const buildStats = groupKeyFn => {
            const groups = {};
            closedTrades.forEach(tr => {
                groupKeyFn(tr).forEach(key => {
                    if (!groups[key]) groups[key] = { win: 0, total: 0 };
                    groups[key].total += 1;
                    if (tr.pnlUSC >= 0) groups[key].win += 1;
                });
            });
            return groups;
        };

        t.monthlyHistory.unshift({
            monthId: oldMonthId,
            label: this.monthLabel(oldMonthId),
            profit, loss, net, trades,
            reasonStats: buildStats(tr => tr.reasons),
            moodStats: buildStats(tr => [tr.mood])
        });
        if (t.monthlyHistory.length > 24) t.monthlyHistory = t.monthlyHistory.slice(0, 24);
        t.monthId = currentMonthId;
    },

    getCurrentAccount() {
        return state.trading.accounts[state.trading.currentAccountId];
    },

    renderTradingAccountsList() {
        this.setBalance(document.getElementById("trading-accounts-total"), this.tradingTotal());
        const container = document.getElementById("trading-accounts-list");
        const accounts = this.allAccounts();
        container.innerHTML = "";

        if (accounts.length === 0) {
            container.innerHTML = '<p class="empty-state">Belum ada akun trading. Tambah akun dulu, misal "Akun Harian".</p>';
            return;
        }

        accounts.forEach(acc => {
            const trendClass = acc.pnlTotal >= 0 ? "text-profit" : "text-loss";
            const card = document.createElement("div");
            card.className = "card category-card";
            card.style.cursor = "pointer";
            card.onclick = () => this.openTradingAccount(acc.id);
            card.innerHTML = `
                <div class="cat-info">
                    <div class="cat-icon" style="background: rgba(255, 215, 0, 0.1); color: var(--primary-color);"><i class="fa-solid fa-chart-line"></i></div>
                    <div>
                        <h3>${acc.name}</h3>
                        <p class="balance-amount">${this.isBalanceHidden ? "Rp ••••••••" : this.formatCurrency(acc.balance)}</p>
                    </div>
                </div>
                <div class="cat-trend ${trendClass}">${acc.pnlTotal >= 0 ? "+" : "-"}${this.formatCompactIDR(Math.abs(acc.pnlTotal)).replace("+", "").replace("-", "")}</div>
            `;
            container.appendChild(card);
        });
    },

    handleAddTradingAccount() {
        this.openSheet({
            title: "Tambah Akun Trading",
            fields: [{ id: "name", label: "Nama Akun", type: "text", placeholder: "" }],
            confirmLabel: "Tambah",
            onConfirm: values => {
                const name = values.name.trim();
                if (!name) return "Nama akun tidak boleh kosong.";
                const acc = this.makeDefaultAccount(name);
                state.trading.accounts[acc.id] = acc;
                this.saveState();
                this.renderTradingAccountsList();
                this.renderHome();
                this.toast(`Akun "${name}" berhasil ditambahkan ✨`);
                return null;
            }
        });
    },

    openTradingAccount(id) {
        state.trading.currentAccountId = id;
        this.renderTradingHub();
        this.navigate("trading");
    },

    confirmDeleteTradingAccountCurrent() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: `Hapus Akun "${acc.name}"?`,
            message: "Akun ini beserta seluruh riwayat & posisi trading-nya akan dihapus permanen.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                delete state.trading.accounts[acc.id];
                state.trading.currentAccountId = null;
                this.saveState();
                this.renderTradingAccountsList();
                this.renderHome();
                this.navigate("trading-accounts");
                this.toast("Akun dihapus.");
                return null;
            }
        });
    },

    // ============================================
    // RENDER — HOME
    // ============================================
    renderHome() {
        this.checkMonthRollover();
        this.setBalance(document.getElementById("home-total"), this.totalBalance());
        this.setBalance(document.getElementById("home-investment"), this.investmentBalance());
        this.setBalance(document.getElementById("home-trading"), this.tradingTotal());

        const monthNet = this.sumMonthTrades(state.trading.monthId);
        const badge = document.getElementById("home-total-badge");
        badge.className = "badge " + (monthNet >= 0 ? "profit" : "loss");
        badge.innerHTML = `<i class="fa-solid fa-arrow-trend-${monthNet >= 0 ? "up" : "down"}"></i> ${monthNet >= 0 ? "+ " : "- "}${this.formatCurrency(Math.abs(monthNet))} Bulan Ini`;

        const todayStart = this.startOfDay(new Date());
        let todayPnl = 0, todayTrades = 0;
        this.combinedHistory().forEach(t => {
            if (t.kind === "trade" && t.timestamp >= todayStart) { todayPnl += t.pnlValue; todayTrades += 1; }
        });

        const profitEl = document.getElementById("home-today-profit");
        profitEl.textContent = (todayPnl >= 0 ? "+ " : "- ") + this.formatCurrency(Math.abs(todayPnl));
        profitEl.className = todayPnl >= 0 ? "text-profit" : "text-loss";
        document.getElementById("home-today-trades").textContent = todayTrades;

        const growthEl = document.getElementById("home-monthly-growth");
        growthEl.textContent = `${monthNet >= 0 ? "+ " : "- "}${this.formatCurrency(Math.abs(monthNet))}`;
        growthEl.className = monthNet >= 0 ? "text-profit" : "text-loss";
    },

    // ============================================
    // RENDER — TRADING HUB (per akun)
    // ============================================
    renderTradingHub() {
        const acc = this.getCurrentAccount();
        if (!acc) { this.navigate("trading-accounts"); return; }

        document.getElementById("trading-account-name").textContent = acc.name;
        this.setBalance(document.getElementById("trading-total"), acc.balance);

        const todayStart = this.startOfDay(new Date());
        let todayPnl = 0;
        acc.history.forEach(t => { if (t.kind === "trade" && t.timestamp >= todayStart) todayPnl += t.pnlValue; });
        const todayEl = document.getElementById("trading-today-pnl");
        todayEl.textContent = (todayPnl >= 0 ? "+ " : "- ") + this.formatCurrency(Math.abs(todayPnl));
        todayEl.className = todayPnl >= 0 ? "text-profit" : "text-loss";

        const monday = this.getMonday(new Date()).getTime();
        let weekPnl = 0;
        acc.history.forEach(t => { if (t.kind === "trade" && t.timestamp >= monday) weekPnl += t.pnlValue; });
        const weekEl = document.getElementById("trading-week-pnl");
        weekEl.textContent = (weekPnl >= 0 ? "+ " : "- ") + this.formatCurrency(Math.abs(weekPnl));
        weekEl.className = weekPnl >= 0 ? "text-profit" : "text-loss";

        this.renderHistory();
        this.renderJournal();
    },

    renderStats() {
        this.checkMonthRollover();
        let profit = 0, loss = 0, wins = 0, trades = 0;
        this.combinedHistory().forEach(t => {
            if (t.kind !== "trade") return;
            if (this.getMonthId(new Date(t.timestamp)) !== state.trading.monthId) return;
            trades += 1;
            if (t.pnlValue >= 0) { profit += t.pnlValue; wins += 1; } else { loss += Math.abs(t.pnlValue); }
        });

        this.setBalance(document.getElementById("stat-profit"), profit);
        this.setBalance(document.getElementById("stat-loss"), loss);
        document.getElementById("stat-winrate").textContent = trades > 0 ? `${Math.round((wins / trades) * 100)}%` : "0%";
        document.getElementById("stat-trades").textContent = trades;
        this.renderMonthlyHistory();
        this.renderGrowthChart();
    },

    renderMonthlyHistory() {
        const container = document.getElementById("monthly-history-list");
        if (!container) return;
        const list = state.trading.monthlyHistory || [];
        container.innerHTML = "";
        if (list.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada riwayat bulan sebelumnya.</p>'; return; }
        list.slice(0, 5).forEach(m => this.renderMonthlyCard(container, m));
        if (list.length > 5) {
            const note = document.createElement("p");
            note.className = "empty-state";
            note.style.fontSize = "0.8rem";
            note.textContent = `Ada ${list.length - 5} bulan lagi di riwayat — cari pakai kolom di atas.`;
            container.appendChild(note);
        }
    },

    renderMonthlyCard(container, m) {
        const netClass = m.net >= 0 ? "text-profit" : "text-loss";
        const card = document.createElement("div");
        card.className = "history-card";
        card.style.flexDirection = "column";
        card.style.alignItems = "stretch";
        card.innerHTML = `
            <div class="hist-left" style="flex-direction:row; justify-content:space-between; width:100%;">
                <div>
                    <span class="hist-pair">${m.label}</span>
                    <span class="hist-time" style="display:block;">${m.trades} trade tercatat</span>
                </div>
                <span class="hist-pnl ${netClass}">${m.net >= 0 ? "+ " : "- "}${this.formatCurrency(Math.abs(m.net))}</span>
            </div>
        `;
        if (m.reasonStats || m.moodStats) {
            const detail = document.createElement("div");
            detail.style.marginTop = "12px";
            detail.style.width = "100%";
            const buildRows = (title, stats) => {
                if (!stats || Object.keys(stats).length === 0) return "";
                let rows = `<p class="card-subtitle" style="margin-top:10px;">${title}</p>`;
                Object.keys(stats).forEach(key => {
                    const g = stats[key];
                    const pct = Math.round((g.win / g.total) * 100);
                    rows += `
                        <div class="stat-bar-row" style="margin-top:8px;">
                            <div class="stat-bar-label"><span>${key}</span><span class="text-accent" style="font-weight:700;">${pct}% (${g.win}/${g.total})</span></div>
                            <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%;"></div></div>
                        </div>
                    `;
                });
                return rows;
            };
            detail.innerHTML = buildRows("Win Rate berdasarkan Alasan Entry", m.reasonStats) + buildRows("Win Rate berdasarkan Mood", m.moodStats);
            card.appendChild(detail);
        }
        container.appendChild(card);
    },

    renderGrowthChart() {
        const container = document.getElementById("growth-chart");
        if (!container) return;
        const archived = (state.trading.monthlyHistory || []).slice(0, 11).reverse();
        const currentNet = this.sumMonthTrades(state.trading.monthId);
        const currentLabel = this.monthLabel(state.trading.monthId || this.getMonthId(new Date()));
        const data = [...archived.map(m => ({ label: m.label, net: m.net })), { label: currentLabel, net: currentNet }];

        container.innerHTML = "";
        const maxAbs = Math.max(1000, ...data.map(d => Math.abs(d.net)));

        data.forEach(d => {
            const heightPct = Math.min(100, (Math.abs(d.net) / maxAbs) * 100);
            const col = document.createElement("div");
            col.className = "growth-bar-col";
            col.innerHTML = `
                <div class="growth-bar-track"><div class="growth-bar-fill ${d.net >= 0 ? "bar-profit" : "bar-loss"}" style="height:${heightPct}%;"></div></div>
                <span class="growth-bar-pct ${d.net >= 0 ? "text-profit" : "text-loss"}">${this.formatCompactIDR(d.net)}</span>
                <span class="growth-bar-label">${d.label.slice(0, 3)}</span>
            `;
            container.appendChild(col);
        });
    },

    searchMonthlyHistory() {
        const input = document.getElementById("monthly-search-input");
        const resultEl = document.getElementById("monthly-search-result");
        if (!input || !input.value) { this.toast("Pilih bulan dulu."); return; }
        const monthId = input.value;
        const found = (state.trading.monthlyHistory || []).find(m => m.monthId === monthId);
        resultEl.innerHTML = "";
        if (!found) { resultEl.innerHTML = '<p class="empty-state">Tidak ada riwayat untuk bulan itu.</p>'; return; }
        this.renderMonthlyCard(resultEl, found);
    },

    renderHistory() {
        const acc = this.getCurrentAccount();
        const container = document.getElementById("history-container");
        container.innerHTML = "";
        if (!acc || acc.history.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada transaksi.</p>'; return; }
        const sorted = [...acc.history].sort((a, b) => b.timestamp - a.timestamp);
        sorted.forEach(entry => {
            const card = document.createElement("div");
            card.className = "history-card";
            const pnlClass = entry.pnlValue >= 0 ? "text-profit" : "text-loss";
            const psychHtml = entry.mood
                ? `<div style="margin-top:8px;">
                       <span class="mood-badge">${entry.mood}</span>
                       ${(entry.reasons || []).map(r => `<span class="reason-tag">${r}</span>`).join("")}
                       ${entry.reasonNote ? `<p style="margin-top:6px; font-size:0.8rem; color:var(--text-secondary); font-style:italic;">"${entry.reasonNote}"</p>` : ""}
                   </div>`
                : "";
            card.innerHTML = `
                <div class="hist-left" style="flex:1;">
                    <span class="hist-pair">${entry.label} <span class="hist-badge ${entry.badgeClass}">${entry.badgeText}</span></span>
                    <span class="hist-time">${entry.date}, ${entry.time}</span>
                    ${psychHtml}
                </div>
                <div class="hist-actions">
                    <span class="hist-pnl ${pnlClass}">${entry.pnlValue >= 0 ? "+ " : "- "}${this.formatCurrency(Math.abs(entry.pnlValue))}</span>
                    <button class="hist-delete" onclick="app.confirmDeleteEntry(${entry.timestamp})" aria-label="Hapus transaksi"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    handleDeposit() {
        const acc = this.getCurrentAccount();
        this.openSheet({
            title: "Deposit",
            fields: [{ id: "amount", label: "Jumlah (USD)", type: "text", inputmode: "decimal", placeholder: "" }],
            confirmLabel: "Deposit",
            onConfirm: values => {
                const usd = this.parseDecimal(values.amount);
                if (usd === null || usd <= 0) return "Masukkan jumlah yang valid.";

                const idr = Math.round(usd * acc.journal.exchangeRate);
                acc.balance += idr;
                acc.deposited += idr;
                const entry = this.makeEntry("deposit", "Deposit", "DEPOSIT", "badge-buy", idr);
                entry.usdDelta = usd;
                acc.history.push(entry);

                const j = acc.journal;
                if (!j.peakDate) { j.peakDate = this.todayISO(); j.startBalance = usd; }
                else j.startBalance += usd;
                this.recomputeJournalDaily(acc);

                this.saveState();
                this.renderTradingHub();
                this.renderTradingAccountsList();
                this.renderHome();
                this.toast("Deposit berhasil ditambahkan 🚀");
                return null;
            }
        });
    },

    handleWithdraw() {
        const acc = this.getCurrentAccount();
        this.openSheet({
            title: "Withdraw",
            fields: [{ id: "amount", label: "Jumlah (USD)", type: "text", inputmode: "decimal", placeholder: "" }],
            confirmLabel: "Withdraw",
            onConfirm: values => {
                const usd = this.parseDecimal(values.amount);
                if (usd === null || usd <= 0) return "Masukkan jumlah yang valid.";

                const j = acc.journal;
                if (j.peakDate && usd > j.currentBalance) return "Saldo USD tidak cukup untuk penarikan sebesar ini.";

                const idr = Math.round(usd * j.exchangeRate);
                if (idr > acc.balance) return "Saldo kamu tidak cukup.";

                acc.balance -= idr;
                const entry = this.makeEntry("withdraw", "Withdraw", "WITHDRAW", "badge-sell", -idr);
                entry.usdDelta = -usd;
                acc.history.push(entry);

                if (j.peakDate) { j.startBalance -= usd; this.recomputeJournalDaily(acc); }

                this.saveState();
                this.renderTradingHub();
                this.renderTradingAccountsList();
                this.renderHome();
                this.toast("Penarikan berhasil diproses 💸");
                return null;
            }
        });
    },

    makeEntry(kind, label, badgeText, badgeClass, pnlValue) {
        const now = new Date();
        return { kind, label, badgeText, badgeClass, pnlValue, date: this.todayKey(), time: now.getHours() + ":" + String(now.getMinutes()).padStart(2, "0"), timestamp: now.getTime() };
    },

    confirmDeleteEntry(timestamp) {
        this.openSheet({
            title: "Hapus Transaksi?",
            message: "Transaksi ini akan dihapus permanen dan saldo akan disesuaikan.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => { this.removeHistoryEntry(timestamp); return null; }
        });
    },

    removeHistoryEntry(timestamp) {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const idx = acc.history.findIndex(e => e.timestamp === timestamp);
        if (idx === -1) return;

        const entry = acc.history[idx];
        if (entry.kind === "deposit") { acc.balance -= entry.pnlValue; acc.deposited -= entry.pnlValue; }
        else if (entry.kind === "withdraw") { acc.balance -= entry.pnlValue; }
        else if (entry.kind === "trade") {
            acc.balance -= entry.pnlValue;
            acc.pnlTotal -= entry.pnlValue;
            if (entry.tradeId) {
                acc.journal.trades = acc.journal.trades.filter(t => t.id !== entry.tradeId);
                this.recomputeJournalDaily(acc);
            }
} else if (entry.kind === "adjustment") { acc.balance -= entry.pnlValue; }

        // Balikin juga sisi USD di Risk Guard, biar gak "nyangkut" kayak bug kemarin.
        if (entry.usdDelta !== undefined && acc.journal.peakDate) {
            acc.journal.startBalance -= entry.usdDelta;
            this.recomputeJournalDaily(acc);
        }

        acc.history.splice(idx, 1);
        this.saveState();
        this.renderTradingHub();
        this.renderTradingAccountsList();
        this.renderHome();
        this.renderStats();
        this.toast("Transaksi dihapus.");
    },

    confirmResetAll() {
        this.openSheet({
            title: "Reset Semua Data?",
            message: "Semua saldo, deposit, withdraw, aset investment, dan seluruh akun trading akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.",
            confirmLabel: "Reset Semua",
            danger: true,
            onConfirm: () => { this.resetAllData(); return null; }
        });
    },

    resetAllData() {
        state.investment = { assets: {}, currentAsset: null };
        state.trading = { accounts: {}, currentAccountId: null, monthId: null, monthlyHistory: [] };

        this.saveState();
        document.getElementById("sidebar").classList.remove("open");
        document.getElementById("overlay").classList.remove("active");

        this.renderHome();
        this.renderTradingAccountsList();
        this.renderStats();
        this.renderInvestmentView();
        this.navigate("home");
        this.toast("Semua data berhasil direset.");
    },

    // ============================================
    // JOURNAL — RISK GUARD & TRADE PSYCHOLOGY (per akun)
    // ============================================
    handleSetPeakBalance() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const input = document.getElementById("journal-peak-input");
        const val = this.parseDecimal(input.value);
        if (val === null || val < 0) { this.toast("Masukkan saldo yang valid (USD)."); return; }

        const j = acc.journal;
        const today = this.todayISO();
        const oldCurrent = j.currentBalance;

        if (j.peakDate !== today) { j.startBalance = val; j.peakDate = today; }
        else {
            const todaysPnl = j.trades.filter(t => t.status === "closed" && t.closedDate === today).reduce((s, t) => s + t.pnlUSC, 0);
            j.startBalance = val - todaysPnl;
        }
        this.recomputeJournalDaily(acc);

        const delta = j.currentBalance - oldCurrent;
        if (Math.abs(delta) > 0.001) {
            const deltaIDR = Math.round(delta * j.exchangeRate);
            acc.balance += deltaIDR;
            const entry = this.makeEntry("adjustment", "Koreksi Saldo USD", "KOREKSI", delta >= 0 ? "badge-buy" : "badge-sell", deltaIDR);
            entry.usdDelta = delta;
            acc.history.push(entry);
        }

        this.saveState();
        this.renderJournal();
        this.renderTradingHub();
        this.renderTradingAccountsList();
        this.renderHome();
        this.toast("Saldo disimpan ✨");
    },

    recomputeJournalDaily(acc) {
        const j = acc.journal;
        if (!j.peakDate) return;
        let running = j.startBalance;
        let peak = running;
        const todayTrades = j.trades.filter(t => t.status === "closed" && t.closedDate === j.peakDate).sort((a, b) => a.closedAt - b.closedAt);
        todayTrades.forEach(t => { running += t.pnlUSC; if (running > peak) peak = running; });
        j.currentBalance = running;
        j.peakBalance = peak;
    },

    handleJournalSettings() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const j = acc.journal;
        this.openSheet({
            title: "Pengaturan Akun",
            message: "Kurs dipakai untuk konversi USD ke Rupiah di akun ini.",
            fields: [{ id: "rate", label: "Kurs 1 USD = Rp", type: "text", inputmode: "numeric", placeholder: String(j.exchangeRate) }],
            confirmLabel: "Simpan",
            onConfirm: values => {
                const rate = this.parseAmount(values.rate);
                if (rate === null || rate <= 0) return "Masukkan kurs yang valid.";
                j.exchangeRate = rate;
                this.saveState();
                this.renderJournal();
                this.toast("Pengaturan disimpan ✨");
                return null;
            }
        });
    },

    checkJournalPeakReset(acc) {
        const j = acc.journal;
        if (j.peakDate && j.peakDate !== this.todayISO()) {
            j.startBalance = j.currentBalance;
            j.peakBalance = j.currentBalance;
            j.peakDate = this.todayISO();
        }
    },

    renderJournal() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.checkJournalPeakReset(acc);
        const j = acc.journal;

        const peakInput = document.getElementById("journal-peak-input");
        if (peakInput && j.peakDate === this.todayISO()) peakInput.value = Math.round(j.currentBalance * 100) / 100;

        const fillEl = document.getElementById("journal-health-fill");
        const badgeEl = document.getElementById("journal-risk-badge");
        const limitEl = document.getElementById("journal-limit-text");

        if (!j.peakDate) {
            limitEl.textContent = "Belum diatur";
            fillEl.style.width = "100%";
            fillEl.className = "health-bar-fill";
            badgeEl.className = "badge";
            badgeEl.textContent = "Set saldo dulu untuk mulai tracking risiko.";
        } else {
            const lossPercent = j.peakBalance > 0 ? Math.max(0, ((j.peakBalance - j.currentBalance) / j.peakBalance) * 100) : 0;
            limitEl.textContent = `${lossPercent.toFixed(1)}%`;
            fillEl.style.width = Math.max(0, 100 - lossPercent) + "%";

            if (j.currentBalance <= 0) {
                fillEl.className = "health-bar-fill zone-red";
                badgeEl.className = "badge loss";
                badgeEl.textContent = "Saldo habis! Silakan deposit lagi untuk lanjut trading.";
            } else if (lossPercent <= 10) {
                fillEl.className = "health-bar-fill";
                badgeEl.className = "badge profit";
                badgeEl.textContent = "Aman. Tetap disiplin!";
            } else if (lossPercent <= 50) {
                fillEl.className = "health-bar-fill zone-yellow";
                badgeEl.className = "badge warning";
                badgeEl.textContent = "Waspada, kerugian mulai terasa.";
            } else {
                fillEl.className = "health-bar-fill zone-red";
                badgeEl.className = "badge loss";
                badgeEl.textContent = "Hati-hati! Kerugian sudah besar, kurangi risiko.";
            }
        }

        this.renderJournalActiveList();
        this.renderJournalStats();
    },

    handleAddJournalTrade() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: "Tambah Trade Baru",
            fields: [
                { id: "pair", label: "Pair", type: "text", placeholder: "" },
                { id: "type", label: "Jenis", type: "segmented", options: ["BUY", "SELL"], default: "BUY" },
                { id: "entry", label: "Entry Price", type: "text", inputmode: "decimal", placeholder: "" },
                { id: "sl", label: "SL Price", type: "text", inputmode: "decimal", placeholder: "" },
                { id: "lot", label: "Lot Size", type: "text", inputmode: "decimal", value: "0.01" },
                { id: "pip", label: "Pip Size (buat hitung TP)", type: "text", inputmode: "decimal", value: "0.0001" },
                { id: "reasons", label: "Kenapa Entry? (bisa pilih lebih dari 1)", type: "checklist", options: ["Fundamental / Macro Data", "Technical Setup", "Live Stream Signal", "Own Zone Validation"] },
                { id: "note", label: "Kenapa yakin sama trade ini, bro?", type: "textarea", placeholder: "" },
                {
                    id: "mood", label: "Kondisi Psikologi Saat Ini", type: "segmented",
                    options: ["😎 Calm", "🔥 Hyped", "😡 Revenge", "😨 FOMO"], default: "😎 Calm",
                    warnMap: {
                        "😡 Revenge": "⚠️ Otak sedang terdistraksi dopamin! Kecilkan lot atau tunda entry 10 menit dulu.",
                        "😨 FOMO": "⚠️ Otak sedang terdistraksi dopamin! Kecilkan lot atau tunda entry 10 menit dulu."
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
                if (lot === null || lot <= 0) return "Lot size harus angka valid.";
                const pip = this.parseDecimal(values.pip) || 0.0001;
                if (values.reasons.length === 0) return "Pilih minimal 1 alasan entry.";

                const trade = {
                    id: Date.now() + Math.random().toString(36).slice(2),
                    timestamp: Date.now(), day: this.todayKey(),
                    pair: pair.toUpperCase(), type: values.type,
                    entryPrice: entry, slPrice: sl, lot, pipSize: pip,
                    reasons: values.reasons, reasonNote: values.note.trim(), mood: values.mood,
                    tp: { tp1: false, tp2: false, tp3: false },
                    status: "open", pnlUSC: null
                };
                acc.journal.trades.push(trade);
                this.saveState();
                this.renderJournal();
                this.toast("Trade baru dicatat 📝");
                return null;
            }
        });
    },

    toggleTP(tradeId, level) {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const trade = acc.journal.trades.find(t => t.id === tradeId);
        if (!trade) return;
        trade.tp["tp" + level] = !trade.tp["tp" + level];
        this.saveState();
        this.renderJournal();
        if (level === 1 && trade.tp.tp1) this.toast("🔔 WAJIB SET BREAK EVEN (SL BE) DI HARGA ENTRY SEKARANG!");
    },

    handleCloseJournalTrade(tradeId) {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const trade = acc.journal.trades.find(t => t.id === tradeId);
        if (!trade) return;
        this.openSheet({
            title: "Tutup Posisi",
            message: `${trade.pair} — ${trade.type}`,
            fields: [
                { id: "sign", label: "Hasil", type: "segmented", options: ["Profit", "Loss"], default: "Profit" },
                { id: "amount", label: "Jumlah (USD)", type: "text", inputmode: "decimal", placeholder: "" }
            ],
            confirmLabel: "Tutup Posisi",
            onConfirm: values => {
                const amount = this.parseDecimal(values.amount);
                if (amount === null || amount <= 0) return "Masukkan jumlah yang valid.";

                const pnlUSC = values.sign === "Loss" ? -amount : amount;
                trade.status = "closed";
                trade.pnlUSC = pnlUSC;
                trade.closedAt = Date.now();
                trade.closedDate = this.todayISO();

                const j = acc.journal;
                this.recomputeJournalDaily(acc);

                const pnlIDR = Math.round(pnlUSC * j.exchangeRate);
                acc.balance += pnlIDR;
                acc.pnlTotal += pnlIDR;
                const historyEntry = this.makeEntry("trade", trade.pair, trade.type, trade.type === "BUY" ? "badge-buy" : "badge-sell", pnlIDR);
                historyEntry.mood = trade.mood;
                historyEntry.reasons = trade.reasons;
                historyEntry.reasonNote = trade.reasonNote;
                historyEntry.tradeId = trade.id;
                acc.history.push(historyEntry);

                this.saveState();
                this.renderJournal();
                this.renderTradingHub();
                this.renderTradingAccountsList();
                this.renderHome();
                this.renderStats();
                this.toast(pnlUSC >= 0 ? "Posisi ditutup, cuan dicatat 🚀" : "Posisi ditutup, loss dicatat. Tetap disiplin ya.");
                return null;
            }
        });
    },

    confirmDeleteJournalTrade(tradeId) {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: "Hapus Posisi?",
            message: "Posisi aktif ini akan dihapus tanpa dicatat sebagai hasil.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => {
                acc.journal.trades = acc.journal.trades.filter(t => t.id !== tradeId);
                this.saveState();
                this.renderJournal();
                this.toast("Posisi dihapus.");
                return null;
            }
        });
    },

    renderJournalActiveList() {
        const acc = this.getCurrentAccount();
        const container = document.getElementById("journal-active-list");
        if (!acc) return;
        const active = acc.journal.trades.filter(t => t.status === "open");
        container.innerHTML = "";
        if (active.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada posisi trading aktif.</p>'; return; }

        active.slice().reverse().forEach(trade => {
            const reasonTags = trade.reasons.map(r => `<span class="reason-tag">${r}</span>`).join("");
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
                ${trade.reasonNote ? `<p style="margin-top:8px; font-size:0.85rem; color:var(--text-secondary); font-style:italic;">"${trade.reasonNote}"</p>` : ""}
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
        const acc = this.getCurrentAccount();
        const currentMonthId = state.trading.monthId || this.getMonthId(new Date());
        const closed = acc ? acc.journal.trades.filter(t => t.status === "closed" && t.closedDate && t.closedDate.startsWith(currentMonthId)) : [];

        const buildBars = (containerId, groupKeyFn) => {
            const container = document.getElementById(containerId);
            container.innerHTML = "";
            if (closed.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada trade selesai.</p>'; return; }
            const groups = {};
            closed.forEach(t => {
                groupKeyFn(t).forEach(key => {
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
                    <div class="stat-bar-label"><span>${key}</span><span class="text-accent" style="font-weight:700;">${pct}% (${g.win}/${g.total})</span></div>
                    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%;"></div></div>
                `;
                container.appendChild(row);
            });
        };

        buildBars("journal-stats-reason", t => t.reasons);
        buildBars("journal-stats-mood", t => [t.mood]);
    },

    // ============================================
    // RENDER — INVESTMENT (tidak berubah)
    // ============================================
    renderInvestmentView() {
        this.setBalance(document.getElementById("inv-total"), this.investmentBalance());
        this.renderInvestmentList();
    },

    renderInvestmentList() {
        const container = document.getElementById("investment-list");
        const assets = state.investment.assets;
        const names = Object.keys(assets);
        container.innerHTML = "";
        if (names.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada aset investment. Tambah aset dulu, misal "Solana".</p>'; return; }

        names.forEach(name => {
            const asset = assets[name];
            const safeName = name.replace(/'/g, "\\'");
            const isSavings = asset.type === "savings";
            const icon = isSavings ? "fa-piggy-bank" : "fa-coins";
            const iconStyle = isSavings ? "background: rgba(0, 200, 83, 0.1); color: var(--profit-color);" : "background: rgba(255, 215, 0, 0.1); color: var(--primary-color);";
            const typeLabel = isSavings ? "Simpanan" : "Investasi";
            const card = document.createElement("div");
            card.className = "card category-card";
            card.style.cursor = "pointer";
            card.onclick = () => this.openInvestmentAsset(name);
            card.innerHTML = `
                <div class="cat-info">
                    <div class="cat-icon" style="${iconStyle}"><i class="fa-solid ${icon}"></i></div>
                    <div><h3>${name} <span class="asset-type-badge">${typeLabel}</span></h3><p class="balance-amount">${this.isBalanceHidden ? "Rp ••••••••" : this.formatCurrency(asset.balance)}</p></div>
                </div>
                <button class="hist-delete" aria-label="Hapus aset"><i class="fa-solid fa-trash"></i></button>
            `;
            card.querySelector(".hist-delete").onclick = e => { e.stopPropagation(); this.confirmDeleteAssetFromList(safeName); };
            container.appendChild(card);
        });
    },

    handleAddAsset() {
        this.openSheet({
            title: "Tambah Aset",
            fields: [
                { id: "type", label: "Jenis Aset", type: "segmented", options: ["Investasi", "Simpanan"], default: "Investasi" },
                { id: "name", label: "Nama Aset", type: "text", placeholder: "" }
            ],
            confirmLabel: "Tambah",
            onConfirm: values => {
                const name = values.name.trim();
                if (!name) return "Nama aset tidak boleh kosong.";
                if (state.investment.assets[name]) return "Aset dengan nama ini sudah ada.";
                const isSavings = values.type === "Simpanan";
                state.investment.assets[name] = isSavings
                    ? { type: "savings", balance: 0, deposited: 0, history: [], minDeposit: 3000 }
                    : { type: "invest", balance: 0, deposited: 0, history: [], cycleStart: this.todayISO(), cycleAmount: 0, cycleTarget: 150000, minDeposit: 5000, exchangeTotal: 0, pendingAmount: 0, topupLog: [] };
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
        if (!asset) { this.navigate("investment"); return; }

        const isSavings = asset.type === "savings";
        document.getElementById("inv-invest-section").style.display = isSavings ? "none" : "block";
        document.getElementById("inv-savings-section").style.display = isSavings ? "block" : "none";
        document.getElementById("inv-deposit-label").textContent = isSavings ? "Nabung" : "Deposit";
        document.getElementById("inv-withdraw-label").textContent = isSavings ? "Pakai" : "Withdraw";
        document.getElementById("inv-balance-label").textContent = isSavings ? "Saldo Celengan" : "Saldo Exchange (Total)";
        document.getElementById("inv-asset-title").textContent = name;

        if (isSavings) {
            this.setBalance(document.getElementById("inv-asset-balance"), asset.balance);
            const minInput = document.getElementById("inv-savings-min");
            if (minInput) minInput.value = asset.minDeposit;
        } else {
            this.checkCycleReset(asset);
            this.setBalance(document.getElementById("inv-asset-balance"), asset.exchangeTotal);
            const pct = Math.min(Math.round((asset.cycleAmount / asset.cycleTarget) * 100), 100);
            document.getElementById("inv-cycle-ring").style.setProperty("--pct", pct);
            document.getElementById("inv-cycle-pct").textContent = pct + "%";
            document.getElementById("inv-cycle-amount").textContent = `${this.formatCurrency(asset.cycleAmount)} / ${this.formatCurrency(asset.cycleTarget)}`;
            const daysSince = Math.min(this.getDaysSince(asset.cycleStart) + 1, 30);
            document.getElementById("inv-cycle-day").textContent = `Hari ke-${daysSince} dari 30`;
            document.getElementById("inv-pending-amount").textContent = this.formatCurrency(asset.pendingAmount);
        }
        this.renderInvestmentHistory();
    },

    renderInvestmentHistory() {
        const container = document.getElementById("investment-history-container");
        const asset = state.investment.assets[state.investment.currentAsset];
        container.innerHTML = "";
        if (!asset || asset.history.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada transaksi.</p>'; return; }
        const sorted = [...asset.history].sort((a, b) => b.timestamp - a.timestamp);
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
                    <button class="hist-delete" onclick="app.confirmDeleteInvestmentEntry(${entry.timestamp})" aria-label="Hapus transaksi"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    handleInvestmentDeposit() {
        const currentAsset = state.investment.assets[state.investment.currentAsset];
        const isSavings = currentAsset && currentAsset.type === "savings";
        this.openSheet({
            title: isSavings ? "Nabung" : "Deposit",
            fields: [{ id: "amount", label: "Jumlah (Rp)", type: "text", inputmode: "numeric", placeholder: "" }],
            confirmLabel: isSavings ? "Nabung" : "Deposit",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return "Masukkan jumlah yang valid.";
                const asset = state.investment.assets[state.investment.currentAsset];
                if (asset.type === "savings") {
                    asset.balance += amount; asset.deposited += amount;
                    asset.history.push(this.makeEntry("deposit", "Nabung", "NABUNG", "badge-buy", amount));
                } else {
                    this.checkCycleReset(asset);
                    asset.pendingAmount += amount; asset.deposited += amount; asset.cycleAmount += amount;
                    asset.balance = asset.exchangeTotal + asset.pendingAmount;
                    asset.history.push(this.makeEntry("deposit", "Deposit", "DEPOSIT", "badge-buy", amount));
                }
                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast(asset.type === "savings" ? "Nabung berhasil ditambahkan 🐷" : "Deposit berhasil ditambahkan 🚀");
                return null;
            }
        });
    },

    handleInvestmentWithdraw() {
        const currentAsset = state.investment.assets[state.investment.currentAsset];
        const isSavings = currentAsset && currentAsset.type === "savings";
        this.openSheet({
            title: isSavings ? "Pakai Saldo" : "Withdraw",
            fields: [{ id: "amount", label: "Jumlah (Rp)", type: "text", inputmode: "numeric", placeholder: "" }],
            confirmLabel: isSavings ? "Pakai" : "Withdraw",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return "Masukkan jumlah yang valid.";
                const asset = state.investment.assets[state.investment.currentAsset];
                if (asset.type === "savings") {
                    if (amount > asset.balance) return "Saldo celengan tidak cukup.";
                    asset.balance -= amount;
                    asset.history.push(this.makeEntry("withdraw", "Pakai Saldo", "PAKAI", "badge-sell", -amount));
                } else {
                    if (amount > asset.exchangeTotal) return "Saldo exchange tidak cukup (masih ada yang belum ditop up).";
                    asset.exchangeTotal -= amount;
                    asset.balance = asset.exchangeTotal + asset.pendingAmount;
                    asset.history.push(this.makeEntry("withdraw", "Withdraw", "WITHDRAW", "badge-sell", -amount));
                }
                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast(asset.type === "savings" ? "Saldo berhasil dipakai 💸" : "Penarikan berhasil diproses 💸");
                return null;
            }
        });
    },

    handleCycleSettings() {
        const asset = state.investment.assets[state.investment.currentAsset];
        this.openSheet({
            title: "Atur Target Siklus",
            fields: [
                { id: "target", label: "Target per Siklus (Rp)", type: "text", inputmode: "numeric", placeholder: String(asset.cycleTarget) },
                { id: "minDep", label: "Minimal Nabung Harian (Rp)", type: "text", inputmode: "numeric", placeholder: String(asset.minDeposit) },
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
        if (minDep === null || minDep < 0) { this.toast("Masukkan minimal nabung yang valid."); return; }
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
                fields: [{ id: "balance", label: "Saldo Celengan (Rp)", type: "text", inputmode: "numeric", placeholder: String(asset.balance) }],
                confirmLabel: "Simpan Koreksi",
                onConfirm: values => {
                    const bal = this.parseAmount(values.balance);
                    if (bal === null || bal < 0) return "Masukkan jumlah yang valid.";
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
                { id: "exchange", label: "Saldo Exchange (Rp)", type: "text", inputmode: "numeric", placeholder: String(asset.exchangeTotal) },
                { id: "cycle", label: "Saldo Siklus Saat Ini (Rp)", type: "text", inputmode: "numeric", placeholder: String(asset.cycleAmount) },
                { id: "pending", label: "Saldo Belum Ditop Up (Rp)", type: "text", inputmode: "numeric", placeholder: String(asset.pendingAmount) }
            ],
            confirmLabel: "Simpan Koreksi",
            onConfirm: values => {
                const exch = this.parseAmount(values.exchange);
                const cyc = this.parseAmount(values.cycle);
                const pend = this.parseAmount(values.pending);
                if (values.exchange.trim() !== "" && exch !== null && exch >= 0) asset.exchangeTotal = exch;
                if (values.cycle.trim() !== "" && cyc !== null && cyc >= 0) asset.cycleAmount = cyc;
                if (values.pending.trim() !== "" && pend !== null && pend >= 0) asset.pendingAmount = pend;
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
        if (asset.pendingAmount <= 0) { this.toast("Belum ada saldo yang bisa ditop up."); return; }
        this.openSheet({
            title: "Top Up ke Exchange",
            fields: [{ id: "amount", label: `Jumlah (Rp) — Tersedia: ${this.formatCurrency(asset.pendingAmount)}`, type: "text", inputmode: "numeric", placeholder: "" }],
            confirmLabel: "Top Up",
            onConfirm: values => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return "Masukkan jumlah yang valid.";
                if (amount > asset.pendingAmount) return "Saldo belum ditop up tidak cukup.";
                asset.pendingAmount -= amount;
                asset.exchangeTotal += amount;
                asset.balance = asset.exchangeTotal + asset.pendingAmount;
                asset.topupLog.push({ amount, timestamp: Date.now() });
                asset.history.push(this.makeEntry("topup", "Top Up ke Exchange", "TOP UP", "badge-buy", 0));
                this.saveState();
                this.renderInvestmentAsset();
                this.toast(`Top Up berhasil! +${this.formatCurrency(amount)} ke Exchange ✨`);
                return null;
            }
        });
    },

    confirmDeleteInvestmentEntry(timestamp) {
        this.openSheet({
            title: "Hapus Transaksi?",
            message: "Transaksi ini akan dihapus permanen dan saldo aset akan disesuaikan.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => { this.removeInvestmentHistoryEntry(timestamp); return null; }
        });
    },

    removeInvestmentHistoryEntry(timestamp) {
        const asset = state.investment.assets[state.investment.currentAsset];
        const idx = asset.history.findIndex(e => e.timestamp === timestamp);
        if (idx === -1) return;
        const entry = asset.history[idx];
        if (asset.type === "savings") {
            if (entry.kind === "deposit") { asset.balance -= entry.pnlValue; asset.deposited -= entry.pnlValue; }
            else if (entry.kind === "withdraw") { asset.balance -= entry.pnlValue; }
        } else {
            if (entry.kind === "deposit") { asset.pendingAmount -= entry.pnlValue; asset.deposited -= entry.pnlValue; asset.cycleAmount -= entry.pnlValue; }
            else if (entry.kind === "withdraw") { asset.exchangeTotal -= entry.pnlValue; }
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
            message: "Aset ini beserta seluruh riwayat transaksinya akan dihapus permanen.",
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
            message: "Aset ini beserta seluruh riwayat transaksinya akan dihapus permanen.",
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
        if (this.currentTheme === "dark") { html.removeAttribute("data-theme"); this.currentTheme = "light"; }
        else { html.setAttribute("data-theme", "dark"); this.currentTheme = "dark"; }
        const settingToggle = document.getElementById("setting-theme");
        if (settingToggle) settingToggle.checked = this.currentTheme === "dark";
    },

    toast(message) {
        const toastEl = document.getElementById("toast");
        toastEl.textContent = message;
        toastEl.classList.add("show");
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
    },

    // ============================================
    // BOTTOM SHEET
    // ============================================
    openSheet({ title, message, fields = [], confirmLabel = "Konfirmasi", danger = false, onConfirm }) {
        document.getElementById("sheet-title").textContent = title;
        document.getElementById("sheet-error").textContent = "";
        const body = document.getElementById("sheet-body");
        body.innerHTML = "";

        if (message) { const p = document.createElement("p"); p.className = "sheet-message"; p.textContent = message; body.appendChild(p); }

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
                    if (initialWarn) { warnEl.textContent = initialWarn; warnEl.classList.remove("hidden"); }
                }
                field.options.forEach(opt => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "segmented-option" + (opt === seg.dataset.value ? " active" : "");
                    btn.textContent = opt;
                    btn.addEventListener("click", () => {
                        seg.dataset.value = opt;
                        seg.querySelectorAll(".segmented-option").forEach(b => b.classList.remove("active"));
                        btn.classList.add("active");
                        if (warnEl) {
                            const w = field.warnMap[opt];
                            if (w) { warnEl.textContent = w; warnEl.classList.remove("hidden"); } else warnEl.classList.add("hidden");
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
                        if (selected.includes(opt)) { selected = selected.filter(v => v !== opt); btn.classList.remove("active"); }
                        else { selected.push(opt); btn.classList.add("active"); }
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
                if (field.type === "segmented") values[field.id] = el.dataset.value;
                else if (field.type === "checklist") values[field.id] = JSON.parse(el.dataset.value || "[]");
                else values[field.id] = el.value;
            });
            const error = onConfirm(values);
            if (error) document.getElementById("sheet-error").textContent = error;
            else this.closeSheet();
        });

        document.getElementById("sheet-overlay").classList.add("active");
        document.getElementById("bottom-sheet").classList.add("open");
        setTimeout(() => { const first = body.querySelector("input.sheet-input"); if (first) first.focus(); }, 300);
    },

    closeSheet() {
        document.getElementById("sheet-overlay").classList.remove("active");
        document.getElementById("bottom-sheet").classList.remove("open");
    },

    parseAmount(raw) {
        if (raw === null || raw === undefined) return null;
        const cleaned = String(raw).trim().replace(/[.\s]/g, "").replace(/,/g, ".");
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
    }
};

document.addEventListener("DOMContentLoaded", () => {
    app.init();
});