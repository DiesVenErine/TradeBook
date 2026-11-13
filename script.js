/* =========================================================
   TRADEBOOK v3 - Trading only, akun CENT (USC)
   Ringkasan ala MT5: Keuntungan, Deposito, Penarikan, Swap, Komisi, Saldo
   Saldo akun SELALU dihitung dari riwayat (single source of truth).
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

const STORAGE_KEY = "tradebook_state_v3";
const OLD_STORAGE_KEY = "tradebook_state";

const state = {
    version: 3,
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
    currentUser: null,
    syncTimer: null,
    accountPeriod: "all",
    reportMode: "week",
    reportOffset: 0,

    // ============================================
    // HELPERS
    // ============================================
    esc(str) {
        return String(str === undefined || str === null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    },

    round2(n) {
        return Math.round((Number(n) || 0) * 100) / 100;
    },

    // ============================================
    // PERSISTENCE + MIGRASI
    // ============================================
    saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            console.error("Gagal menyimpan data:", e);
            this.toast("Penyimpanan HP penuh, data gagal disimpan. Coba hapus foto akun.");
        }
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.syncToSupabase(), 1000);
    },

    makeDefaultAccount(name) {
        return {
            id: "acc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: name || "Akun Utama",
            photo: "",
            legacy: { maxDD: 0 },
            history: [],
            journal: { trades: [] }
        };
    },

    // Data versi lama (IDR + USD + investment) -> versi 3 (USC saja)
    migrateLegacyTrading(t) {
        const accounts = {};
        let rate0 = 0;
        Object.values(t.accounts || {}).forEach(acc => {
            const j = acc.journal || {};
            const rate = j.exchangeRate || 15800;
            if (!rate0) rate0 = rate;
            const byId = {};
            (j.trades || []).forEach(tr => { byId[tr.id] = tr; });

            const history = (acc.history || []).map((h, i) => {
                let v;
                if (typeof h.usdDelta === "number") v = h.usdDelta;
                else if (h.kind === "trade" && h.tradeId && byId[h.tradeId] && typeof byId[h.tradeId].pnlUSC === "number") v = byId[h.tradeId].pnlUSC;
                else v = (h.pnlValue || 0) / rate;
                const e = Object.assign({}, h, {
                    id: "h_" + h.timestamp + "_" + i,
                    pnlValue: this.round2(v),
                    swap: 0,
                    commission: 0
                });
                delete e.usdDelta;
                return e;
            });

            const trades = (j.trades || []).map(tr => {
                const pnl = typeof tr.pnlUSC === "number" ? tr.pnlUSC : null;
                const n = Object.assign({}, tr, { pnl, swap: 0, commission: 0, net: pnl });
                delete n.pnlUSC;
                return n;
            });

            accounts[acc.id] = { id: acc.id, name: acc.name, history, journal: { trades } };
        });

        const rate = rate0 || 15800;
        const monthlyHistory = (t.monthlyHistory || []).map(m => Object.assign({}, m, {
            profit: this.round2((m.profit || 0) / rate),
            loss: this.round2((m.loss || 0) / rate),
            net: this.round2((m.net || 0) / rate)
        }));

        return {
            accounts,
            currentAccountId: t.currentAccountId || null,
            monthId: t.monthId || null,
            monthlyHistory
        };
    },

    normalizeTrading(t) {
        const out = Object.assign({ accounts: {}, currentAccountId: null, monthId: null, monthlyHistory: [] }, t);
        Object.values(out.accounts).forEach(acc => {
            if (!Array.isArray(acc.history)) acc.history = [];
            if (typeof acc.photo !== "string") acc.photo = "";
if (typeof acc.archived !== "boolean") acc.archived = false;
            if (!acc.legacy || typeof acc.legacy.maxDD !== "number") acc.legacy = { maxDD: 0 };
            if (!acc.journal) acc.journal = { trades: [] };
            if (!Array.isArray(acc.journal.trades)) acc.journal.trades = [];
            acc.history.forEach((h, i) => {
                if (!h.id) h.id = "h_" + h.timestamp + "_" + i;
                if (h.swap === undefined) h.swap = 0;
                if (h.commission === undefined) h.commission = 0;
            });
        });
        if (!Array.isArray(out.monthlyHistory)) out.monthlyHistory = [];
        return out;
    },

    migrate(saved) {
        if (!saved || !saved.trading || !saved.trading.accounts) return null;
        const t = saved.version === 3 ? saved.trading : this.migrateLegacyTrading(saved.trading);
        return this.normalizeTrading(t);
    },

    loadState() {
        try {
            let raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) raw = localStorage.getItem(OLD_STORAGE_KEY);
            if (!raw) return;
            const trading = this.migrate(JSON.parse(raw));
            if (trading) state.trading = trading;
        } catch (e) {
            console.error("Gagal memuat data tersimpan:", e);
        }
    },

    // ============================================
    // INIT
    // ============================================
    async init() {
        this.initPrefs();
        this.loadState();
        this.setDate();
        this.refreshAll();
        this.attachRipples();
        this.updateNav("home");

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
                this._exitTimer = setTimeout(() => { this.exitArmed = false; }, 2000);
                return;
            }

            this.navigate(view, true);
        });

        this.checkExistingSession();
        console.log("TradeBook v3 (USC) Initialized! 🚀");
    },

    refreshAll() {
        this.renderHome();
        this.renderTradingAccountsList();
        this.renderStats();
        if (document.getElementById("view-trading").classList.contains("active")) this.renderTradingHub();
        if (document.getElementById("view-trading-report").classList.contains("active")) this.renderReportPage();
    },

    // ============================================
    // AUTH / CLOUD
    // ============================================
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
        const { error } = await sb.auth.signUp({ email, password });
        if (error) { errEl.textContent = error.message; return; }
        document.getElementById("auth-status").textContent = "Akun dibuat! Cek email buat verifikasi (kalau diminta), lalu tekan Masuk.";
    },

    async onAuthSuccess(user, silent) {
        this.currentUser = user;
        this.updateAuthUI(user);

        try {
            const { data } = await sb.from("user_data").select("data").eq("user_id", user.id).maybeSingle();
            const cloud = data && data.data && Object.keys(data.data).length > 0 ? this.migrate(data.data) : null;
            if (cloud) {
                state.trading = cloud;
                if (!silent) this.toast("Data dari cloud berhasil dimuat ✨");
            } else {
                this.syncToSupabase();
                if (!silent) this.toast("Login berhasil, data lokal kamu mulai di-backup 🚀");
            }
        } catch (e) {
            console.error("Gagal ambil data dari Supabase:", e);
        }

        this.saveState();
        this.refreshAll();
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

    // ============================================
    // DATE / FORMAT
    // ============================================
    setDate() {
        const dateElement = document.getElementById("current-date");
        const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
        dateElement.textContent = new Date().toLocaleDateString("en-US", options);
        const h = new Date().getHours();
        const word = h < 11 ? "Morning" : h < 15 ? "Afternoon" : h < 19 ? "Evening" : "Night";
        const greet = document.getElementById("greeting-word");
        if (greet) greet.textContent = word + "!";
    },

    numFmt(value) {
        return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
    },

    // "1,234.56 USC"
    formatUSC(value) {
        return this.numFmt(value) + " USC";
    },

    // angka polos buat baris ringkasan (ikut mode sembunyikan saldo)
    plain(value) {
        return this.isBalanceHidden ? "••••••" : this.numFmt(value);
    },

    money(value) {
        return this.isBalanceHidden ? "•••••• USC" : this.formatUSC(value);
    },

    signed(value) {
        const v = Number(value) || 0;
        if (this.isBalanceHidden) return "•••••• USC";
        return (v >= 0 ? "+ " : "- ") + this.formatUSC(Math.abs(v));
    },

    formatCompact(value) {
        const abs = Math.abs(value);
        let str;
        if (abs >= 1000000) str = (abs / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
        else if (abs >= 1000) str = (abs / 1000).toFixed(1).replace(/\.0$/, "") + "k";
        else str = abs.toFixed(abs >= 100 ? 0 : 1).replace(/\.0$/, "");
        return (value >= 0 ? "+" : "-") + str;
    },

    todayKey() {
        const d = new Date();
        return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
    },

    todayISO() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
            if (val !== null) el.textContent = this.money(Number(val));
        });
    },

    setBalance(el, value) {
        if (!el) return;
        const oldValue = parseFloat(el.getAttribute("data-value")) || 0;
        const newValue = Number(value) || 0;
        el.setAttribute("data-value", newValue);
        if (this.isBalanceHidden) { el.textContent = this.money(newValue); return; }
        if (oldValue === newValue) { el.textContent = this.formatUSC(newValue); return; }
        this.animateValue(el, oldValue, newValue, 500);
    },

    animateValue(el, start, end, duration) {
        const startTime = performance.now();
        const step = now => {
            const progress = Math.min((now - startTime) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = start + (end - start) * eased;
            el.textContent = this.formatUSC(current);
            if (progress < 1) requestAnimationFrame(step);
            else el.textContent = this.formatUSC(end);
        };
        requestAnimationFrame(step);
    },

    setSigned(el, value) {
        if (!el) return;
        el.textContent = this.signed(value);
        el.className = value >= 0 ? "text-profit" : "text-loss";
    },

    toggleBalance() {
        this.isBalanceHidden = !this.isBalanceHidden;
        const eyeIcon = document.querySelector(".toggle-eye i");
        if (eyeIcon) {
            eyeIcon.classList.toggle("fa-eye-slash", this.isBalanceHidden);
            eyeIcon.classList.toggle("fa-eye", !this.isBalanceHidden);
        }
        const settingToggle = document.getElementById("setting-hide-balance");
        if (settingToggle) settingToggle.checked = this.isBalanceHidden;
        this.refreshAll();
        this.formatAllBalances();
    },

    // tab navigasi bawah: halaman dalam (detail akun, laporan, about) ikut tab induknya
    tabOf(viewId) {
        const map = {
            home: "home",
            "trading-accounts": "trade",
            trading: "trade",
            "trading-report": "trade",
            stats: "stats",
            settings: "settings",
            about: "settings"
        };
        return map[viewId] || "home";
    },

    updateNav(viewId) {
        const tab = this.tabOf(viewId);
        document.querySelectorAll(".bn-item").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    },

    navigate(viewId, skipPush) {
        const target = document.getElementById(`view-${viewId}`);
        if (!target) return;
        document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
        target.classList.add("active");
        this.updateNav(viewId);
        window.scrollTo(0, 0);

        if (!skipPush) {
            const currentView = history.state && history.state.view;
            if (currentView !== viewId) history.pushState({ view: viewId }, "", "#" + viewId);
        }
    },

    // ============================================
    // CORE: saldo & ringkasan (ala MT5)
    // ============================================
      allAccounts() {
        return Object.values(state.trading.accounts);
    },

    activeAccounts() {
        return this.allAccounts().filter(a => !a.archived);
    },

    combinedHistory() {
        const out = [];
        this.allAccounts().forEach(acc => acc.history.forEach(h => out.push(h)));
        return out;
    },

    combinedHistoryTagged() {
        const out = [];
        this.allAccounts().forEach(acc => {
            acc.history.forEach(h => out.push(Object.assign({}, h, { accountId: acc.id, accountName: acc.name })));
        });
        return out;
    },

    // perubahan saldo dari satu entri
    delta(e) {
        return (e.pnlValue || 0) + (e.swap || 0) + (e.commission || 0);
    },

    balanceOf(acc) {
        return this.round2(acc.history.reduce((s, h) => s + this.delta(h), 0));
    },

    tradingTotal() {
        return this.round2(this.allAccounts().reduce((s, a) => s + this.balanceOf(a), 0));
    },

    summarize(entries) {
        const s = { profit: 0, deposit: 0, withdraw: 0, swap: 0, commission: 0, adjustment: 0, transfer: 0, transferIn: 0, transferOut: 0, trades: 0, wins: 0, grossProfit: 0, grossLoss: 0 };
        entries.forEach(e => {
            if (e.kind === "deposit") s.deposit += e.pnlValue || 0;
            else if (e.kind === "withdraw") s.withdraw += e.pnlValue || 0; // sudah negatif
            else if (e.kind === "transfer") {
                const v = e.pnlValue || 0;
                if (v >= 0) s.transferIn += v; else s.transferOut += -v;
            }
            else if (e.kind === "adjustment") s.adjustment += e.pnlValue || 0;
            else if (e.kind === "opening") {
                // hasil trading lama dari "Sesuaikan Akun Lama": masuk ke Keuntungan/Swap/Komisi, tapi bukan hitungan trade
                s.profit += e.pnlValue || 0;
                s.swap += e.swap || 0;
                s.commission += e.commission || 0;
            } else if (e.kind === "trade") {
                s.profit += e.pnlValue || 0;
                s.swap += e.swap || 0;
                s.commission += e.commission || 0;
                s.trades += 1;
                const net = this.delta(e);
                if (net > 0) { s.wins += 1; s.grossProfit += net; } else s.grossLoss += Math.abs(net);
            }
        });
        ["profit", "deposit", "withdraw", "swap", "commission", "adjustment", "transferIn", "transferOut", "grossProfit", "grossLoss"].forEach(k => { s[k] = this.round2(s[k]); });
        s.transfer = this.round2(s.transferIn - s.transferOut);
        s.saldo = this.round2(s.deposit + s.withdraw + s.transfer + s.profit + s.swap + s.commission + s.adjustment);
        s.net = this.round2(s.grossProfit - s.grossLoss);
        return s;
    },

    inRange(entries, start, end) {
        return entries.filter(e => e.timestamp >= start && (end === undefined || e.timestamp < end));
    },

    periodStart(mode) {
        const now = new Date();
        if (mode === "day") return this.startOfDay(now);
        if (mode === "week") return this.getMonday(now).getTime();
        if (mode === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        return 0;
    },

    mt5RowsHTML(s) {
        const rows = [
            ["Keuntungan", s.profit, s.profit >= 0 ? "text-profit" : "text-loss"],
            ["Deposito", s.deposit, ""],
            ["Penarikan", s.withdraw, ""],
            ["Swap", s.swap, ""],
            ["Komisi", s.commission, ""]
        ];
        if (Math.abs(s.transfer || 0) > 0.004) rows.push(["Transfer", s.transfer, ""]);
        if (Math.abs(s.adjustment) > 0.004) rows.push(["Koreksi", s.adjustment, ""]);
        rows.push(["Saldo", s.saldo, "mt5-total"]);
        return rows.map(([label, val, cls]) => `
            <div class="mt5-row ${cls === "mt5-total" ? "mt5-total" : ""}">
                <span class="mt5-label">${label}:</span>
                <span class="mt5-dots"></span>
                <span class="mt5-value ${cls === "mt5-total" ? "" : cls}">${this.plain(val)}</span>
            </div>`).join("");
    },

    renderMt5(containerId, entries) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = this.mt5RowsHTML(this.summarize(entries));
    },

    // Risk Guard: dihitung dari riwayat hari ini, bukan disimpan
    dailyStats(acc) {
        const startTs = this.startOfDay(new Date());
        const current = this.balanceOf(acc);
        const todays = acc.history.filter(h => h.timestamp >= startTs).sort((a, b) => a.timestamp - b.timestamp);
        const todaysDelta = todays.reduce((s, h) => s + this.delta(h), 0);
        let running = current - todaysDelta;
        let peak = running;
        todays.forEach(h => {
            const d = this.delta(h);
            running += d;
            if (h.kind !== "trade") peak += d;
            else if (running > peak) peak = running;
        });
        const lossPercent = peak > 0 ? Math.max(0, ((peak - current) / peak) * 100) : 0;
        return { current, peak: this.round2(peak), lossPercent, hasData: acc.history.length > 0 };
    },

    // ---------- SEPANJANG WAKTU ----------
    // Deposito, penarikan, koreksi & import cuma menggeser saldo DAN puncak sama besar
    // (itu bukan untung/rugi), jadi hanya hasil trade yang bisa menciptakan drawdown.
    walkDrawdown(entries) {
        const sorted = entries.slice().sort((a, b) => a.timestamp - b.timestamp);
        let bal = 0, peak = 0, maxDD = 0, maxDDPct = 0;
        sorted.forEach(h => {
            const d = this.delta(h);
            bal += d;
            if (h.kind === "trade") { if (bal > peak) peak = bal; }
            else peak += d;
            const dd = peak - bal;
            if (dd > maxDD) maxDD = dd;
            if (peak > 0) maxDDPct = Math.max(maxDDPct, (dd / peak) * 100);
        });
        const curDD = Math.max(0, peak - bal);
        return {
            maxDD: this.round2(maxDD),
            maxDDPct,
            curDD: this.round2(curDD),
            curDDPct: peak > 0 ? (curDD / peak) * 100 : 0
        };
    },

    // Hasil bersih = (uang yang sudah ditarik + sisa saldo) - total deposito.
    // Positif = sudah lebih dari modal, negatif = masih minus.
    lifetimeStats(entries, legacyMaxDD) {
        const s = this.summarize(entries);
        const w = this.walkDrawdown(entries);
        const legacy = legacyMaxDD || 0;
        const useLegacy = legacy > w.maxDD;
                const moneyIn = this.round2(s.deposit + s.transferIn);
        const moneyOut = this.round2(-s.withdraw + s.transferOut);
        return {
            moneyIn, moneyOut,
            saldo: s.saldo,
            net: this.round2(moneyOut + s.saldo - moneyIn),
            maxDD: useLegacy ? this.round2(legacy) : w.maxDD,
            maxDDPct: useLegacy ? null : w.maxDDPct, // null = persen gak diketahui (angka dari catatan manual)
            curDD: w.curDD,
            curDDPct: w.curDDPct,
            hasData: entries.length > 0
        };
    },

    combinedLegacyMaxDD() {
        return Math.max(0, ...this.allAccounts().map(a => (a.legacy && a.legacy.maxDD) || 0));
    },

    mt5RowHTML(label, value, cls, total) {
        return `
            <div class="mt5-row ${total ? "mt5-total" : ""}">
                <span class="mt5-label">${label}:</span>
                <span class="mt5-dots"></span>
                <span class="mt5-value ${cls || ""}">${value}</span>
            </div>`;
    },

    renderLifetime(containerId, entries, legacyMaxDD) {
        const el = document.getElementById(containerId);
        if (!el) return;
        const L = this.lifetimeStats(entries, legacyMaxDD);
        if (!L.hasData) {
            el.innerHTML = '<p class="empty-state" style="padding:8px 0;">Belum ada data. Catat deposito, atau pakai "Sesuaikan Akun Lama" di menu titik tiga akun.</p>';
            return;
        }
        const plus = L.net >= 0;
        const pct = v => (v === null ? "" : ` (${v.toFixed(1)}%)`);
        const verdict = `<div class="badge ${plus ? "profit" : "loss"} verdict-badge">
                <i class="fa-solid fa-${plus ? "circle-check" : "circle-exclamation"}"></i>
                ${plus ? "Sudah plus" : "Masih minus"} ${this.money(Math.abs(L.net))}
            </div>`;
        const rows =
            this.mt5RowHTML("Uang Masuk (Deposito)", this.plain(L.moneyIn)) +
            this.mt5RowHTML("Uang Keluar + Sisa Saldo", this.plain(L.moneyOut + L.saldo)) +
            this.mt5RowHTML("Hasil Bersih", (plus ? "+" : "-") + this.plain(Math.abs(L.net)), plus ? "text-profit" : "text-loss", true) +
            this.mt5RowHTML("Drawdown Terbesar", this.plain(L.maxDD) + pct(L.maxDDPct), L.maxDD > 0.004 ? "text-loss" : "") +
            this.mt5RowHTML("Drawdown Sekarang", this.plain(L.curDD) + ` (${L.curDDPct.toFixed(1)}%)`, L.curDD > 0.004 ? "text-loss" : "");
        el.innerHTML = verdict + rows +
            '<p class="lifetime-note">Hasil bersih = penarikan + saldo - deposito. Drawdown = turun terdalam dari puncak saldo, deposito/penarikan tidak dihitung sebagai untung/rugi.</p>';
    },

    sumMonthTrades(monthId) {
        let sum = 0;
        this.combinedHistory().forEach(t => {
            if (t.kind === "trade" && this.getMonthId(new Date(t.timestamp)) === monthId) sum += this.delta(t);
        });
        return this.round2(sum);
    },

    checkMonthRollover() {
        const t = state.trading;
        const currentMonthId = this.getMonthId(new Date());

        if (!t.monthId) { t.monthId = currentMonthId; return; }
        if (t.monthId === currentMonthId) return;

        const oldMonthId = t.monthId;
        const oldEntries = this.combinedHistory().filter(h => this.getMonthId(new Date(h.timestamp)) === oldMonthId);
        const sum = this.summarize(oldEntries);

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
                    if ((tr.net !== undefined && tr.net !== null ? tr.net : tr.pnl) > 0) groups[key].win += 1;
                });
            });
            return groups;
        };

        t.monthlyHistory.unshift({
            monthId: oldMonthId,
            label: this.monthLabel(oldMonthId),
            profit: sum.grossProfit, loss: sum.grossLoss, net: sum.net, trades: sum.trades,
            mt5: { profit: sum.profit, deposit: sum.deposit, withdraw: sum.withdraw, swap: sum.swap, commission: sum.commission, adjustment: sum.adjustment, transfer: sum.transfer, saldo: sum.saldo },
            reasonStats: buildStats(tr => tr.reasons || []),
            moodStats: buildStats(tr => [tr.mood])
        });
        if (t.monthlyHistory.length > 24) t.monthlyHistory = t.monthlyHistory.slice(0, 24);
        t.monthId = currentMonthId;
    },

    // ============================================
    // TRADING — DAFTAR AKUN
    // ============================================
    getCurrentAccount() {
        return state.trading.accounts[state.trading.currentAccountId];
    },

    renderTradingAccountsList() {
        this.setBalance(document.getElementById("trading-accounts-total"), this.tradingTotal());
        this.renderMt5("accounts-mt5", this.combinedHistory());

        // kartu akun bergaya "pocket": foto di atas, nama, saldo, chip hasil bersih
        const container = document.getElementById("trading-accounts-list");
        const accounts = this.activeAccounts();
        container.innerHTML = "";

        accounts.forEach(acc => {
            const L = this.lifetimeStats(acc.history, acc.legacy && acc.legacy.maxDD);
            const card = document.createElement("div");
            card.className = "acc-card";
            card.onclick = () => this.openTradingAccount(acc.id);

            let media;
            if (acc.photo) {
                media = document.createElement("img");
                media.className = "acc-photo";
                media.alt = "";
                media.loading = "lazy";
                media.src = acc.photo;
            } else {
                media = document.createElement("div");
                media.className = "acc-photo acc-photo-empty";
                media.innerHTML = '<i class="fa-solid fa-chart-line"></i>';
            }

            const name = document.createElement("div");
            name.className = "acc-name";
            name.textContent = acc.name;

            const bal = document.createElement("div");
            bal.className = "acc-balance";
            bal.textContent = this.money(this.balanceOf(acc));

            card.appendChild(media);
            card.appendChild(name);
            card.appendChild(bal);

            if (acc.history.length > 0) {
                const chip = document.createElement("div");
                const plus = L.net >= 0;
                chip.className = "acc-chip " + (plus ? "profit" : "loss");
                chip.textContent = this.isBalanceHidden ? "••••" : `${plus ? "Plus" : "Minus"} ${this.numFmt(Math.abs(L.net))}`;
                card.appendChild(chip);
            }
            container.appendChild(card);
        });

        const add = document.createElement("div");
        add.className = "acc-card acc-add";
        add.onclick = () => this.handleAddTradingAccount();
        add.innerHTML = '<i class="fa-solid fa-plus"></i><span>Tambah Akun</span>';
        container.appendChild(add);

        if (accounts.length === 0) {
            const hint = document.createElement("p");
            hint.className = "empty-state acc-hint";
            hint.textContent = 'Belum ada akun trading. Tambah akun dulu, misal "Akun Cent".';
                        container.appendChild(hint);
        }
        this.renderArchived();
    },

        archivedOpen: false,

    renderArchived() {
        const el = document.getElementById("archived-section");
        if (!el) return;
        const list = this.allAccounts().filter(a => a.archived);
        el.innerHTML = "";
        if (list.length === 0) return;

        const header = document.createElement("div");
        header.className = "week-group-header";
        header.style.marginTop = "24px";
        header.innerHTML = `
            <div><span class="week-group-title">Diarsipkan</span><span class="week-group-sub">${list.length} akun</span></div>
            <i class="fa-solid fa-chevron-down week-group-chevron${this.archivedOpen ? " rotated" : ""}"></i>`;
        const body = document.createElement("div");
        body.className = "week-group-body" + (this.archivedOpen ? "" : " collapsed");

        list.forEach(acc => {
            const row = document.createElement("div");
            row.className = "arch-row";
            row.onclick = () => this.openTradingAccount(acc.id);
            row.innerHTML = `<div><b>${this.esc(acc.name)}</b><small>${this.money(this.balanceOf(acc))}</small></div>
                             <i class="fa-solid fa-chevron-right" style="color:var(--text-secondary)"></i>`;
            body.appendChild(row);
        });
        header.onclick = () => {
            this.archivedOpen = !this.archivedOpen;
            body.classList.toggle("collapsed");
            header.querySelector(".week-group-chevron").classList.toggle("rotated");
        };
        el.appendChild(header);
        el.appendChild(body);
    },

    toggleArchiveCurrent() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const archiving = !acc.archived;
        const bal = this.balanceOf(acc);
        this.openSheet({
            title: archiving ? `Arsipkan "${acc.name}"?` : `Aktifkan "${acc.name}" lagi?`,
            message: archiving
                ? "Akun disembunyikan dari daftar utama. Data & saldonya tetap tersimpan dan tetap dihitung di total." +
                  (bal > 0.004 ? ` Masih ada saldo ${this.formatUSC(bal)}, pastikan memang sudah gak dipakai.` : "")
                : "Akun akan muncul lagi di daftar utama.",
            confirmLabel: archiving ? "Arsipkan" : "Aktifkan",
            onConfirm: () => {
                acc.archived = archiving;
                this.saveState();
                this.navigate("trading-accounts");
                this.refreshAll();
                this.toast(archiving ? "Akun diarsipkan 📦" : "Akun diaktifkan lagi ✨");
                return null;
            }
        });
    },

    handleAddTradingAccount() {
        this.openSheet({
            title: "Tambah Akun Trading (Cent)",
            fields: [
                { id: "name", label: "Nama Akun", type: "text", placeholder: "Akun Cent" },
                { id: "photo", label: "Foto Akun (opsional)", type: "image", value: "" }
            ],
            confirmLabel: "Tambah",
            onConfirm: values => {
                const name = values.name.trim();
                if (!name) return "Nama akun tidak boleh kosong.";
                const acc = this.makeDefaultAccount(name);
                acc.photo = values.photo || "";
                state.trading.accounts[acc.id] = acc;
                this.saveState();
                this.refreshAll();
                this.toast(`Akun "${name}" berhasil ditambahkan ✨`);
                return null;
            }
        });
    },

    openTradingAccount(id) {
        state.trading.currentAccountId = id;
        this.accountPeriod = "all";
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
                this.navigate("trading-accounts");
                this.refreshAll();
                this.toast("Akun dihapus.");
                return null;
            }
        });
    },

    // ============================================
    // LAPORAN — gabungan semua akun
    // ============================================
    navigateToReport() {
        this.reportMode = "week";
        this.reportOffset = 0;
        document.getElementById("report-mode-week").classList.add("active");
        document.getElementById("report-mode-month").classList.remove("active");
        this.renderReportPage();
        this.navigate("trading-report");
    },

    setReportMode(mode) {
        this.reportMode = mode;
        this.reportOffset = 0;
        document.getElementById("report-mode-week").classList.toggle("active", mode === "week");
        document.getElementById("report-mode-month").classList.toggle("active", mode === "month");
        this.renderReportPage();
    },

    shiftReportPeriod(dir) {
        if (this.reportOffset + dir > 0) return;
        this.reportOffset += dir;
        this.renderReportPage();
    },

    getReportRange() {
        const now = new Date();
        if (this.reportMode === "week") {
            const monday = this.getMonday(now);
            monday.setDate(monday.getDate() + this.reportOffset * 7);
            const start = monday.getTime();
            const endDate = new Date(monday);
            endDate.setDate(endDate.getDate() + 7);
            const lastDay = new Date(endDate);
            lastDay.setDate(lastDay.getDate() - 1);
            const fmt = d => `${d.getDate()} ${d.toLocaleString("id-ID", { month: "short" })}`;
            return { start, end: endDate.getTime(), label: `${fmt(monday)} - ${fmt(lastDay)}` };
        }
        const base = new Date(now.getFullYear(), now.getMonth() + this.reportOffset, 1);
        const endDate = new Date(base.getFullYear(), base.getMonth() + 1, 1);
        return { start: base.getTime(), end: endDate.getTime(), label: this.monthLabel(this.getMonthId(base)) };
    },

    historyEntryHTML(entry, opts) {
        const o = opts || {};
        const net = this.delta(entry);
        const pnlClass = net >= 0 ? "text-profit" : "text-loss";
        const psychHtml = entry.mood
            ? `<div style="margin-top:8px;">
                   <span class="mood-badge">${this.esc(entry.mood)}</span>
                   ${(entry.reasons || []).map(r => `<span class="reason-tag">${this.esc(r)}</span>`).join("")}
                   ${!o.compact && entry.reasonNote ? `<p style="margin-top:6px; font-size:0.8rem; color:var(--text-secondary); font-style:italic;">"${this.esc(entry.reasonNote)}"</p>` : ""}
               </div>`
            : "";
        const extra = [];
        if (entry.kind === "trade" || entry.kind === "opening") {
            if (entry.swap) extra.push(`Swap ${this.numFmt(entry.swap)}`);
            if (entry.commission) extra.push(`Komisi ${this.numFmt(entry.commission)}`);
        }
        const extraHtml = extra.length && !this.isBalanceHidden ? `<span class="hist-time">${extra.join(" • ")}</span>` : "";
        const where = o.accountName ? `${this.esc(o.accountName)} • ` : "";
        return `
            <div class="hist-left" style="flex:1;">
                <span class="hist-pair">${this.esc(entry.label)} <span class="hist-badge ${this.esc(entry.badgeClass)}">${this.esc(entry.badgeText)}</span></span>
                <span class="hist-time">${where}${this.esc(entry.date)}, ${this.esc(entry.time)}</span>
                ${extraHtml}
                ${psychHtml}
            </div>
            <div class="hist-actions">
                <span class="hist-pnl ${pnlClass}">${this.signed(net)}</span>
                ${o.deletable ? `<button class="hist-delete" onclick="app.confirmDeleteEntry('${entry.id}')" aria-label="Hapus transaksi"><i class="fa-solid fa-trash"></i></button>` : ""}
            </div>`;
    },

    renderReportPage() {
        const range = this.getReportRange();
        document.getElementById("report-period-label").textContent = range.label;

        const entries = this.inRange(this.combinedHistoryTagged(), range.start, range.end);
        const s = this.summarize(entries);

        this.setBalance(document.getElementById("report-profit"), s.grossProfit);
        this.setBalance(document.getElementById("report-loss"), s.grossLoss);
        const netEl = document.getElementById("report-net");
        netEl.textContent = this.signed(s.net);
        netEl.className = s.net >= 0 ? "text-profit" : "text-loss";
        document.getElementById("report-trades-info").textContent =
            s.trades > 0 ? `${s.trades} trade • ${Math.round((s.wins / s.trades) * 100)}% win rate` : "Belum ada trade di periode ini.";

        this.renderMt5("report-mt5", entries);

        const byAccount = {};
        entries.forEach(h => {
            if (h.kind !== "trade") return;
            if (!byAccount[h.accountId]) byAccount[h.accountId] = { name: h.accountName, net: 0, trades: 0 };
            byAccount[h.accountId].net += this.delta(h);
            byAccount[h.accountId].trades += 1;
        });
        const accContainer = document.getElementById("report-account-breakdown");
        accContainer.innerHTML = "";
        const accKeys = Object.keys(byAccount);
        if (accKeys.length === 0) {
            accContainer.innerHTML = '<p class="empty-state">Belum ada transaksi di periode ini.</p>';
        } else {
            accKeys.forEach(id => {
                const a = byAccount[id];
                const cls = a.net >= 0 ? "text-profit" : "text-loss";
                const card = document.createElement("div");
                card.className = "history-card";
                card.innerHTML = `
                    <div class="hist-left">
                        <span class="hist-pair">${this.esc(a.name)}</span>
                        <span class="hist-time">${a.trades} trade</span>
                    </div>
                    <span class="hist-pnl ${cls}">${this.signed(a.net)}</span>
                `;
                accContainer.appendChild(card);
            });
        }

        const listContainer = document.getElementById("report-history-list");
        listContainer.innerHTML = "";
        if (entries.length === 0) {
            listContainer.innerHTML = '<p class="empty-state">Belum ada transaksi di periode ini.</p>';
            return;
        }
        entries.slice().sort((a, b) => b.timestamp - a.timestamp).forEach(entry => {
            const card = document.createElement("div");
            card.className = "history-card";
            card.innerHTML = this.historyEntryHTML(entry, { accountName: entry.accountName, compact: true });
            listContainer.appendChild(card);
        });
    },

    // ============================================
    // RENDER — HOME
    // ============================================
    renderHome() {
        this.checkMonthRollover();
        this.setBalance(document.getElementById("home-total"), this.tradingTotal());
        this.renderMt5("home-mt5", this.combinedHistory());
        this.renderLifetime("home-lifetime", this.combinedHistory(), this.combinedLegacyMaxDD());

        const monthNet = this.sumMonthTrades(state.trading.monthId);
        const badge = document.getElementById("home-total-badge");
        badge.className = "badge " + (monthNet >= 0 ? "profit" : "loss");
        badge.innerHTML = `<i class="fa-solid fa-arrow-trend-${monthNet >= 0 ? "up" : "down"}"></i> ${this.signed(monthNet)} Bulan Ini`;

        const todayStart = this.startOfDay(new Date());
        let todayPnl = 0, todayTrades = 0;
        this.combinedHistory().forEach(t => {
            if (t.kind === "trade" && t.timestamp >= todayStart) { todayPnl += this.delta(t); todayTrades += 1; }
        });

        this.setSigned(document.getElementById("home-today-profit"), this.round2(todayPnl));
        document.getElementById("home-today-trades").textContent = todayTrades;
        this.setSigned(document.getElementById("home-monthly-growth"), monthNet);
    },

    // ============================================
    // RENDER — HUB PER AKUN
    // ============================================
    setAccountPeriod(mode) {
        this.accountPeriod = mode;
        this.renderTradingHub();
    },

    renderTradingHub() {
        const acc = this.getCurrentAccount();
        if (!acc) return;

        document.getElementById("trading-account-name").textContent = acc.name;
        const avatar = document.getElementById("trading-account-photo");
        if (avatar) {
            if (acc.photo) { avatar.src = acc.photo; avatar.style.display = "block"; }
            else { avatar.removeAttribute("src"); avatar.style.display = "none"; }
        }
        this.setBalance(document.getElementById("trading-total"), this.balanceOf(acc));

        document.querySelectorAll("#acc-period-seg .segmented-option").forEach(b => {
            b.classList.toggle("active", b.dataset.period === this.accountPeriod);
        });
        this.renderMt5("account-mt5", this.inRange(acc.history, this.periodStart(this.accountPeriod)));
        this.renderLifetime("account-lifetime", acc.history, acc.legacy && acc.legacy.maxDD);

        const todayStart = this.startOfDay(new Date());
        let todayPnl = 0;
        acc.history.forEach(t => { if (t.kind === "trade" && t.timestamp >= todayStart) todayPnl += this.delta(t); });
        this.setSigned(document.getElementById("trading-today-pnl"), this.round2(todayPnl));

        const monday = this.getMonday(new Date()).getTime();
        let weekPnl = 0;
        acc.history.forEach(t => { if (t.kind === "trade" && t.timestamp >= monday) weekPnl += this.delta(t); });
        this.setSigned(document.getElementById("trading-week-pnl"), this.round2(weekPnl));

        this.renderHistory();
        this.renderJournal();
    },

    // ============================================
    // STATISTIK
    // ============================================
    renderStats() {
        this.checkMonthRollover();
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
        const entries = this.inRange(this.combinedHistory(), monthStart);
        const s = this.summarize(entries);

        this.setBalance(document.getElementById("stat-profit"), s.grossProfit);
        this.setBalance(document.getElementById("stat-loss"), s.grossLoss);
        document.getElementById("stat-winrate").textContent = s.trades > 0 ? `${Math.round((s.wins / s.trades) * 100)}%` : "0%";
        document.getElementById("stat-trades").textContent = s.trades;
        this.renderMt5("stats-mt5", entries);
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
                    <span class="hist-pair">${this.esc(m.label)}</span>
                    <span class="hist-time" style="display:block;">${m.trades} trade tercatat</span>
                </div>
                <span class="hist-pnl ${netClass}">${this.signed(m.net)}</span>
            </div>
        `;
        if (m.mt5) {
            const wrap = document.createElement("div");
            wrap.style.marginTop = "12px";
            wrap.style.width = "100%";
            wrap.innerHTML = this.mt5RowsHTML(m.mt5);
            card.appendChild(wrap);
        }
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
                            <div class="stat-bar-label"><span>${this.esc(key)}</span><span class="text-accent" style="font-weight:700;">${pct}% (${g.win}/${g.total})</span></div>
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
        const maxAbs = Math.max(1, ...data.map(d => Math.abs(d.net)));

        data.forEach(d => {
            const heightPct = Math.min(100, (Math.abs(d.net) / maxAbs) * 100);
            const col = document.createElement("div");
            col.className = "growth-bar-col";
            col.innerHTML = `
                <div class="growth-bar-track"><div class="growth-bar-fill ${d.net >= 0 ? "bar-profit" : "bar-loss"}" style="height:${heightPct}%;"></div></div>
                <span class="growth-bar-pct ${d.net >= 0 ? "text-profit" : "text-loss"}">${this.isBalanceHidden ? "•••" : this.formatCompact(d.net)}</span>
                <span class="growth-bar-label">${this.esc(d.label.slice(0, 3))}</span>
            `;
            container.appendChild(col);
        });
    },

    searchMonthlyHistory() {
        const input = document.getElementById("monthly-search-input");
        const resultEl = document.getElementById("monthly-search-result");
        if (!input || !input.value) { this.toast("Pilih bulan dulu."); return; }
        const found = (state.trading.monthlyHistory || []).find(m => m.monthId === input.value);
        resultEl.innerHTML = "";
        if (!found) { resultEl.innerHTML = '<p class="empty-state">Tidak ada riwayat untuk bulan itu.</p>'; return; }
        this.renderMonthlyCard(resultEl, found);
    },

    // ============================================
    // RIWAYAT AKUN (dikelompokkan per minggu)
    // ============================================
    renderHistory() {
        const acc = this.getCurrentAccount();
        const container = document.getElementById("history-container");
        container.innerHTML = "";
        if (!acc || acc.history.length === 0) { container.innerHTML = '<p class="empty-state">Belum ada transaksi.</p>'; return; }

        const groups = {};
        acc.history.forEach(entry => {
            const mondayTs = this.getMonday(new Date(entry.timestamp)).getTime();
            if (!groups[mondayTs]) groups[mondayTs] = [];
            groups[mondayTs].push(entry);
        });

        const currentWeekTs = this.getMonday(new Date()).getTime();
        const fmt = d => `${d.getDate()} ${d.toLocaleString("id-ID", { month: "short" })}`;

        Object.keys(groups).map(Number).sort((a, b) => b - a).forEach(mondayTs => {
            const entries = groups[mondayTs].sort((a, b) => b.timestamp - a.timestamp);
            const s = this.summarize(entries);
            const isCurrent = mondayTs === currentWeekTs;
            const sundayDate = new Date(mondayTs); sundayDate.setDate(sundayDate.getDate() + 6);
            const label = isCurrent ? "Minggu Ini" : `${fmt(new Date(mondayTs))} - ${fmt(sundayDate)}`;

            const groupWrap = document.createElement("div");
            groupWrap.className = "week-group";

            const header = document.createElement("div");
            header.className = "week-group-header";
            header.innerHTML = `
                <div>
                    <span class="week-group-title">${label}</span>
                    <span class="week-group-sub">${s.trades} trade</span>
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                    <span class="${s.net >= 0 ? "text-profit" : "text-loss"}" style="font-weight:700;">${this.signed(s.net)}</span>
                    <i class="fa-solid fa-chevron-down week-group-chevron${isCurrent ? " rotated" : ""}"></i>
                </div>
            `;

            const body = document.createElement("div");
            body.className = "week-group-body" + (isCurrent ? "" : " collapsed");

            entries.forEach(entry => {
                const card = document.createElement("div");
                card.className = "history-card";
                card.innerHTML = this.historyEntryHTML(entry, { deletable: true });
                body.appendChild(card);
            });

            header.onclick = () => {
                body.classList.toggle("collapsed");
                header.querySelector(".week-group-chevron").classList.toggle("rotated");
            };

            groupWrap.appendChild(header);
            groupWrap.appendChild(body);
            container.appendChild(groupWrap);
        });
    },

    makeEntry(kind, label, badgeText, badgeClass, pnlValue) {
        const now = new Date();
        return {
            id: "h_" + now.getTime() + "_" + Math.random().toString(36).slice(2, 6),
            kind, label, badgeText, badgeClass,
            pnlValue: this.round2(pnlValue),
            swap: 0, commission: 0,
            date: this.todayKey(),
            time: now.getHours() + ":" + String(now.getMinutes()).padStart(2, "0"),
            timestamp: now.getTime()
        };
    },

    afterChange() {
        this.saveState();
        this.refreshAll();
    },

    handleDeposit() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: "Deposito",
            fields: [{ id: "amount", label: "Jumlah (USC)", type: "text", inputmode: "decimal", placeholder: "" }],
            confirmLabel: "Deposit",
            onConfirm: values => {
                const amt = this.parseDecimal(values.amount);
                if (amt === null || amt <= 0) return "Masukkan jumlah yang valid.";
                acc.history.push(this.makeEntry("deposit", "Deposito", "DEPOSIT", "badge-buy", amt));
                this.afterChange();
                this.toast("Deposito berhasil dicatat 🚀");
                return null;
            }
        });
    },

    handleWithdraw() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: "Penarikan",
            message: `Saldo saat ini: ${this.formatUSC(this.balanceOf(acc))}`,
            fields: [{ id: "amount", label: "Jumlah (USC)", type: "text", inputmode: "decimal", placeholder: "" }],
            confirmLabel: "Withdraw",
            onConfirm: values => {
                const amt = this.parseDecimal(values.amount);
                if (amt === null || amt <= 0) return "Masukkan jumlah yang valid.";
                const willBeNegative = this.balanceOf(acc) - amt < -0.004;
                acc.history.push(this.makeEntry("withdraw", "Penarikan", "WITHDRAW", "badge-sell", -amt));
                this.afterChange();
                this.toast(willBeNegative ? "Dicatat, tapi saldo jadi minus — cek lagi angkanya ⚠️" : "Penarikan berhasil dicatat 💸");
                return null;
            }
        });
    },

    handleTransfer() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const targets = this.activeAccounts().filter(a => a.id !== acc.id);
        if (targets.length === 0) { this.toast("Belum ada akun tujuan. Tambah akun lain dulu."); return; }
        this.openSheet({
            title: "Transfer ke Akun Lain",
            message: `Saldo ${acc.name}: ${this.formatUSC(this.balanceOf(acc))}. Transfer tidak dihitung sebagai penarikan.`,
            fields: [
                { id: "to", label: "Akun Tujuan", type: "select", options: targets.map(a => ({ value: a.id, label: a.name })), default: targets[0].id },
                { id: "amount", label: "Jumlah (USC)", type: "text", inputmode: "decimal", placeholder: "" }
            ],
            confirmLabel: "Transfer",
            onConfirm: values => {
                const to = state.trading.accounts[values.to];
                if (!to) return "Pilih akun tujuan dulu.";
                const amt = this.parseDecimal(values.amount);
                if (amt === null || amt <= 0) return "Masukkan jumlah yang valid.";
                if (amt > this.balanceOf(acc) + 0.004) return "Saldo akun ini tidak cukup.";
                const tid = "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
                const out = this.makeEntry("transfer", "Transfer ke " + to.name, "TRANSFER", "badge-sell", -amt);
                const inn = this.makeEntry("transfer", "Transfer dari " + acc.name, "TRANSFER", "badge-buy", amt);
                out.transferId = tid;
                inn.transferId = tid;
                acc.history.push(out);
                to.history.push(inn);
                this.afterChange();
                this.toast(`Transfer ${this.formatUSC(amt)} ke ${to.name} berhasil 🔁`);
                return null;
            }
        });
    },

    handleBalanceCorrection() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: "Koreksi Saldo",
            message: `Saldo di app: ${this.formatUSC(this.balanceOf(acc))}. Isi saldo sebenarnya dari MT5, selisihnya dicatat sebagai "Koreksi".`,
            fields: [{ id: "balance", label: "Saldo Sebenarnya (USC)", type: "text", inputmode: "decimal", placeholder: "" }],
            confirmLabel: "Simpan",
            onConfirm: values => {
                const target = this.parseDecimal(values.balance);
                if (target === null) return "Masukkan saldo yang valid.";
                const diff = this.round2(target - this.balanceOf(acc));
                if (Math.abs(diff) < 0.005) return "Saldo sudah sama, gak ada yang perlu dikoreksi.";
                acc.history.push(this.makeEntry("adjustment", "Koreksi Saldo", "KOREKSI", diff >= 0 ? "badge-buy" : "badge-sell", diff));
                this.afterChange();
                this.toast("Saldo dikoreksi ✨");
                return null;
            }
        });
    },

    confirmDeleteEntry(id) {
        this.openSheet({
            title: "Hapus Transaksi?",
            message: "Transaksi ini akan dihapus permanen dan saldo akan disesuaikan.",
            confirmLabel: "Hapus",
            danger: true,
            onConfirm: () => { this.removeHistoryEntry(id); return null; }
        });
    },

    removeHistoryEntry(id) {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const idx = acc.history.findIndex(e => e.id === id);
        if (idx === -1) return;
        const entry = acc.history[idx];
        if (entry.kind === "transfer" && entry.transferId) {
            this.allAccounts().forEach(a => {
                a.history = a.history.filter(e => e.transferId !== entry.transferId);
            });
            this.afterChange();
            this.toast("Transfer dihapus di kedua akun.");
            return;
        }
        if (entry.kind === "trade" && entry.tradeId) {
            acc.journal.trades = acc.journal.trades.filter(t => t.id !== entry.tradeId);
        }
        acc.history.splice(idx, 1);
        if (entry.kind === "opening") acc.legacy = { maxDD: 0 };
        this.afterChange();
        this.toast("Transaksi dihapus.");
    },

    confirmResetAll() {
        this.openSheet({
            title: "Reset Semua Data?",
            message: "Semua akun trading beserta riwayat, posisi, dan statistik akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.",
            confirmLabel: "Reset Semua",
            danger: true,
            onConfirm: () => { this.resetAllData(); return null; }
        });
    },

    resetAllData() {
        state.trading = { accounts: {}, currentAccountId: null, monthId: null, monthlyHistory: [] };
        this.saveState();
        this.refreshAll();
        this.navigate("home");
        this.toast("Semua data berhasil direset.");
    },

    // menu titik tiga di halaman akun
    handleAccountMenu() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openMenu("Pengaturan Akun", [
            { icon: "fa-image", label: "Ubah Nama & Foto", desc: "Ganti nama akun dan foto kartunya", onClick: () => this.handleJournalSettings() },
            { icon: "fa-file-import", label: "Sesuaikan Akun Lama", desc: "Masukin Keuntungan, Deposito, Penarikan dari MT5 sekali isi", onClick: () => this.handleImportLegacy() },
            { icon: "fa-pen", label: "Koreksi Saldo", desc: "Samain saldo app dengan saldo MT5 sekarang", onClick: () => this.handleBalanceCorrection() },
            { icon: acc.archived ? "fa-box-open" : "fa-box-archive",
              label: acc.archived ? "Aktifkan Kembali" : "Arsipkan Akun",
              desc: acc.archived ? "Munculkan lagi di daftar akun" : "Sembunyikan akun yang sudah gak dipakai",
              onClick: () => this.toggleArchiveCurrent() }
        ]);
    },

    handleJournalSettings() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        this.openSheet({
            title: "Nama & Foto Akun",
            fields: [
                { id: "name", label: "Nama Akun", type: "text", value: acc.name },
                { id: "photo", label: "Foto Akun", type: "image", value: acc.photo || "" }
            ],
            confirmLabel: "Simpan",
            onConfirm: values => {
                const newName = values.name.trim();
                if (!newName) return "Nama akun tidak boleh kosong.";
                acc.name = newName;
                acc.photo = values.photo || "";
                this.afterChange();
                this.toast("Pengaturan disimpan ✨");
                return null;
            }
        });
    },

    // Import data lama dari MT5 (tab Riwayat > Posisi) tanpa ngetik transaksi satu-satu
    handleImportLegacy() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const oldest = acc.history.reduce((m, h) => Math.min(m, h.timestamp), Infinity);
        const d0 = new Date(isFinite(oldest) ? oldest - 86400000 : Date.now() - 90 * 86400000);
        const iso = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;
        const warn = acc.history.length > 0
            ? " Akun ini sudah punya transaksi — kalau datanya sudah kamu input manual, jangan diimport lagi biar gak dobel (pakai Koreksi Saldo aja)."
            : "";
        this.openSheet({
            title: "Sesuaikan Akun Lama",
            message: "Salin angka dari MT5 (Riwayat > Posisi) untuk seluruh periode trading lama. Saldo dihitung otomatis dan dicatat sebagai entri \"Import\"." + warn,
            fields: [
                { id: "date", label: "Tanggal mulai trading", type: "date", value: iso },
                { id: "profit", label: "Keuntungan (USC) — minus pakai tanda -", type: "text", placeholder: "0" },
                { id: "deposit", label: "Deposito (USC)", type: "text", inputmode: "decimal", placeholder: "0" },
                { id: "withdraw", label: "Penarikan (USC)", type: "text", inputmode: "decimal", placeholder: "0" },
                { id: "swap", label: "Swap (USC) — opsional, minus pakai tanda -", type: "text", placeholder: "0" },
                { id: "commission", label: "Komisi (USC) — opsional, minus pakai tanda -", type: "text", placeholder: "0" },
                { id: "maxdd", label: "Kerugian terbesar dari puncak saldo (USC) — opsional, perkiraan kamu", type: "text", inputmode: "decimal", placeholder: "0" }
            ],
            confirmLabel: "Import",
            onConfirm: values => {
                const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(values.date || "");
                if (!m) return "Pilih tanggal mulai trading dulu.";
                const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0).getTime();
                if (!Number.isFinite(ts)) return "Tanggal tidak valid.";

                const profit = this.parseOptional(values.profit);
                const deposit = this.parseOptional(values.deposit);
                const withdraw = this.parseOptional(values.withdraw);
                const swap = this.parseOptional(values.swap);
                const commission = this.parseOptional(values.commission);
                const maxDD = this.parseOptional(values.maxdd);
                if ([profit, deposit, withdraw, swap, commission, maxDD].some(v => v === null)) return "Ada angka yang formatnya salah.";

                const p = {
                    ts, profit, swap, commission,
                    deposit: Math.abs(deposit),
                    withdraw: Math.abs(withdraw), // boleh diketik -896.00 seperti di MT5
                    maxDD: Math.abs(maxDD)
                };
                if (!p.deposit && !p.withdraw && !p.profit && !p.swap && !p.commission && !p.maxDD) return "Isi minimal satu angka.";

                this.applyLegacyImport(acc, p);
                this.afterChange();
                this.toast(`Import selesai. Saldo sekarang ${this.formatUSC(this.balanceOf(acc))} ✨`);
                return null;
            }
        });
    },

    applyLegacyImport(acc, p) {
        const stamp = (e, offset) => {
            const d = new Date(p.ts);
            e.timestamp = p.ts + offset;
            e.date = `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
            e.time = "0:00";
            return e;
        };
        if (p.deposit > 0) acc.history.push(stamp(this.makeEntry("deposit", "Deposito (Import)", "IMPORT", "badge-buy", p.deposit), 0));
        if (p.profit || p.swap || p.commission) {
            const e = stamp(this.makeEntry("opening", "Hasil Trading Lama", "IMPORT", p.profit >= 0 ? "badge-buy" : "badge-sell", p.profit), 1);
            e.swap = p.swap;
            e.commission = p.commission;
            acc.history.push(e);
        }
        if (p.withdraw > 0) acc.history.push(stamp(this.makeEntry("withdraw", "Penarikan (Import)", "IMPORT", "badge-sell", -p.withdraw), 2));
        if (p.maxDD > 0) acc.legacy = { maxDD: Math.max((acc.legacy && acc.legacy.maxDD) || 0, p.maxDD) };
    },

    // ============================================
    // JOURNAL — RISK GUARD & PSIKOLOGI
    // ============================================
    renderJournal() {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const d = this.dailyStats(acc);

        const fillEl = document.getElementById("journal-health-fill");
        const badgeEl = document.getElementById("journal-risk-badge");
        const limitEl = document.getElementById("journal-limit-text");
        const infoEl = document.getElementById("journal-peak-info");

        if (!d.hasData) {
            limitEl.textContent = "Belum diatur";
            fillEl.style.width = "100%";
            fillEl.className = "health-bar-fill";
            badgeEl.className = "badge";
            badgeEl.textContent = "Catat deposito dulu untuk mulai tracking risiko.";
            infoEl.textContent = "";
        } else {
            limitEl.textContent = `${d.lossPercent.toFixed(1)}%`;
            fillEl.style.width = Math.max(0, 100 - d.lossPercent) + "%";
            infoEl.textContent = this.isBalanceHidden ? "" : `Puncak hari ini: ${this.formatUSC(d.peak)} • Saldo: ${this.formatUSC(d.current)}`;

            if (d.current <= 0) {
                fillEl.className = "health-bar-fill zone-red";
                badgeEl.className = "badge loss";
                badgeEl.textContent = "Saldo habis! Silakan deposit lagi untuk lanjut trading.";
            } else if (d.lossPercent <= 10) {
                fillEl.className = "health-bar-fill";
                badgeEl.className = "badge profit";
                badgeEl.textContent = "Aman. Tetap disiplin!";
            } else if (d.lossPercent <= 50) {
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
                { id: "pair", label: "Pair", type: "text", placeholder: "XAUUSD" },
                { id: "type", label: "Jenis", type: "segmented", options: ["BUY", "SELL"], default: "BUY" },
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
                if (values.reasons.length === 0) return "Pilih minimal 1 alasan entry.";

                acc.journal.trades.push({
                    id: Date.now() + Math.random().toString(36).slice(2),
                    timestamp: Date.now(), day: this.todayKey(),
                    pair: pair.toUpperCase(), type: values.type,
                    reasons: values.reasons, reasonNote: values.note.trim(), mood: values.mood,
                    status: "open", pnl: null, swap: 0, commission: 0, net: null
                });
                this.saveState();
                this.renderJournal();
                this.toast("Trade baru dicatat 📝");
                return null;
            }
        });
    },

    handleCloseJournalTrade(tradeId) {
        const acc = this.getCurrentAccount();
        if (!acc) return;
        const trade = acc.journal.trades.find(t => t.id === tradeId);
        if (!trade) return;
        this.openSheet({
            title: "Tutup Posisi",
            message: `${trade.pair} — ${trade.type}. Isi sesuai riwayat MT5 (swap & komisi boleh minus, kosongkan kalau 0).`,
            fields: [
                { id: "sign", label: "Hasil", type: "segmented", options: ["Profit", "Loss"], default: "Profit" },
                { id: "amount", label: "Keuntungan (USC)", type: "text", inputmode: "decimal", placeholder: "" },
                { id: "swap", label: "Swap (USC) — opsional, minus pakai tanda -", type: "text", placeholder: "0" },
                { id: "commission", label: "Komisi (USC) — opsional, minus pakai tanda -", type: "text", placeholder: "0" }
            ],
            confirmLabel: "Tutup Posisi",
            onConfirm: values => {
                const rawAmount = this.parseDecimal(values.amount);
                if (rawAmount === null) return "Masukkan jumlah keuntungan/kerugian yang valid.";
                // tanda minus yang diketik juga dianggap Loss
                const amount = Math.abs(rawAmount);
                if (rawAmount < 0) values.sign = "Loss";
                const swap = this.parseOptional(values.swap);
                if (swap === null) return "Swap harus angka valid (atau kosong).";
                const commission = this.parseOptional(values.commission);
                if (commission === null) return "Komisi harus angka valid (atau kosong).";

                const pnl = this.round2(values.sign === "Loss" ? -amount : amount);
                const net = this.round2(pnl + swap + commission);

                trade.status = "closed";
                trade.pnl = pnl;
                trade.swap = swap;
                trade.commission = commission;
                trade.net = net;
                trade.closedAt = Date.now();
                trade.closedDate = this.todayISO();

                const entry = this.makeEntry("trade", trade.pair, trade.type, trade.type === "BUY" ? "badge-buy" : "badge-sell", pnl);
                entry.swap = swap;
                entry.commission = commission;
                entry.mood = trade.mood;
                entry.reasons = trade.reasons;
                entry.reasonNote = trade.reasonNote;
                entry.tradeId = trade.id;
                acc.history.push(entry);

                this.afterChange();
                this.toast(net >= 0 ? "Posisi ditutup, cuan dicatat 🚀" : "Posisi ditutup, loss dicatat. Tetap disiplin ya.");
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
            const opened = new Date(trade.timestamp);
            const when = `${trade.day || ""}, ${opened.getHours()}:${String(opened.getMinutes()).padStart(2, "0")}`;
            const reasonTags = (trade.reasons || []).map(r => `<span class="reason-tag">${this.esc(r)}</span>`).join("");
            const card = document.createElement("div");
            card.className = "card journal-position-card";
            card.innerHTML = `
                <div class="journal-position-head">
                    <div>
                        <h3>${this.esc(trade.pair)} <span class="hist-badge ${trade.type === "BUY" ? "badge-buy" : "badge-sell"}">${this.esc(trade.type)}</span></h3>
                        <p style="color:var(--text-secondary); font-size:0.85rem; margin-top:4px;">Dibuka ${this.esc(when)} • <span class="mood-badge">${this.esc(trade.mood)}</span></p>
                    </div>
                    <button class="journal-position-close-btn" onclick="app.handleCloseJournalTrade('${trade.id}')">Tutup</button>
                </div>
                <div style="margin-top:12px;">${reasonTags}</div>
                ${trade.reasonNote ? `<p style="margin-top:8px; font-size:0.85rem; color:var(--text-secondary); font-style:italic;">"${this.esc(trade.reasonNote)}"</p>` : ""}
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
                const net = t.net !== undefined && t.net !== null ? t.net : t.pnl;
                groupKeyFn(t).forEach(key => {
                    if (!groups[key]) groups[key] = { win: 0, total: 0 };
                    groups[key].total += 1;
                    if (net > 0) groups[key].win += 1;
                });
            });
            Object.keys(groups).forEach(key => {
                const g = groups[key];
                const pct = Math.round((g.win / g.total) * 100);
                const row = document.createElement("div");
                row.className = "stat-bar-row";
                row.innerHTML = `
                    <div class="stat-bar-label"><span>${this.esc(key)}</span><span class="text-accent" style="font-weight:700;">${pct}% (${g.win}/${g.total})</span></div>
                    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%;"></div></div>
                `;
                container.appendChild(row);
            });
        };

        buildBars("journal-stats-reason", t => t.reasons || []);
        buildBars("journal-stats-mood", t => [t.mood]);
    },

    dismissLockdown() {
        document.getElementById("lockdown-overlay").classList.remove("active");
    },

    // ============================================
    // THEME / TOAST
    // ============================================
    // ---------- Tema: warna latar + warna aksen (preset atau bebas), disimpan per HP ----------
    ACCENT_PRESETS: { cyan: "#22cfe8", blue: "#4d8dff", violet: "#9b7bff", coral: "#ff8466", gold: "#f0be4a" },
    BG_PRESETS: {
        warm:   { label: "Hangat",      base: "#171612" },
        amoled: { label: "Pekat",       base: "#000000" },
        night:  { label: "Biru Malam",  base: "#0c1220" },
        forest: { label: "Hijau Malam", base: "#0e1612" },
        plum:   { label: "Ungu Malam",  base: "#16101e" },
        slate:  { label: "Abu",         base: "#1a1b1d" },
        cream:  { label: "Krem",        base: "#f4efe6" },
        snow:   { label: "Putih",       base: "#eef1f5" }
    },
    COLOR_VARS: [
        "--bg-color", "--bg-rgb", "--surface-color", "--surface-rgb", "--surface-2",
        "--text-primary", "--text-secondary", "--border-color", "--sheen",
        "--primary-color", "--primary-hover", "--primary-rgb", "--on-primary", "--ink-d", "--ink-l"
    ],
    currentBg: "warm",
    currentAccent: "cyan",
    customBg: "#2a1f3d",
    customAccent: "#ff7ab8",
    currentVars: {},
    currentBase: "#171612",

    has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); },

    // ----- matematika warna -----
    hexToRgb(h) {
        h = String(h).replace("#", "");
        if (h.length === 3) h = h.split("").map(c => c + c).join("");
        const n = parseInt(h, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    },
    rgbToHex(r, g, b) {
        return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
    },
    mixHex(a, b, t) {
        const A = this.hexToRgb(a), B = this.hexToRgb(b);
        return this.rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
    },
    lumOf(hex) {
        const [r, g, b] = this.hexToRgb(hex).map(v => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    },
    contrast(a, b) {
        const la = this.lumOf(a), lb = this.lumOf(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    },
    hslOf(hex) {
        const [r, g, b] = this.hexToRgb(hex).map(v => v / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        const l = (max + min) / 2;
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        return { h, s, l };
    },

    // terima "#22cfe8", "22cfe8", "#2ce", "34, 207, 232", "rgb(34 207 232)" -> "#rrggbb" atau null
    parseColor(raw) {
        const s = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
        let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
        if (m) {
            let h = m[1];
            if (h.length === 3) h = h.split("").map(c => c + c).join("");
            return "#" + h;
        }
        m = /^(?:rgb\(\s*)?(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/.exec(s);
        if (m) {
            const n = [m[1], m[2], m[3]].map(Number);
            if (n.every(v => v <= 255)) return this.rgbToHex(n[0], n[1], n[2]);
        }
        return null;
    },

    // dari satu warna latar -> permukaan kartu, teks, border (mode gelap/terang ditentukan otomatis)
    deriveBg(base, dark) {
        const white = "#ffffff", black = "#000000";
        let surface, surf2, text, sec;
        if (dark) {
            surface = this.mixHex(base, white, 0.06);
            surf2 = this.mixHex(base, black, 0.14);
            text = this.mixHex(white, base, 0.1);
            sec = this.mixHex(text, base, 0.5);
        } else {
            surface = this.mixHex(base, white, 0.6);
            surf2 = this.mixHex(base, black, 0.03);
            text = this.mixHex(black, base, 0.14);
            sec = this.mixHex(text, base, 0.45);
        }
        for (let i = 0; i < 12 && this.contrast(sec, surface) < 4.5; i++) sec = this.mixHex(sec, text, 0.2);
        const tr = this.hexToRgb(text).join(", ");
        return {
            surface, text,
            vars: {
                "--bg-color": base,
                "--bg-rgb": this.hexToRgb(base).join(", "),
                "--surface-color": surface,
                "--surface-rgb": this.hexToRgb(surface).join(", "),
                "--surface-2": surf2,
                "--text-primary": text,
                "--text-secondary": sec,
                "--border-color": `rgba(${tr}, ${dark ? 0.07 : 0.09})`,
                "--sheen": dark ? `rgba(${tr}, 0.04)` : "transparent"
            }
        };
    },

    // dari satu warna aksen -> hover, teks tombol, teks aksen yang kebaca di atas permukaan
    deriveAccent(hex, surface, dark, bgColor) {
        const toward = dark ? "#ffffff" : "#000000";
        let c = hex;
        for (let i = 0; i < 12 && this.contrast(c, bgColor) < 2; i++) c = this.mixHex(c, toward, 0.12); // tombol harus kelihatan di atas latar
        const on = this.contrast(c, "#0c0c0c") >= this.contrast(c, "#ffffff") ? "#0c0c0c" : "#ffffff";
        let ink = c;
        for (let i = 0; i < 20 && this.contrast(ink, surface) < 4.5; i++) ink = this.mixHex(ink, toward, 0.1);
        return {
            "--primary-color": c,
            "--primary-hover": this.mixHex(c, "#000000", 0.12),
            "--primary-rgb": this.hexToRgb(c).join(", "),
            "--on-primary": on,
            "--ink-d": ink,
            "--ink-l": ink
        };
    },

    accentHint(hex) {
        const { h, s, l } = this.hslOf(hex);
        if (s > 0.45 && l > 0.25 && l < 0.8 && ((h >= 95 && h <= 165) || h <= 12 || h >= 348)) {
            return "Warna ini mirip hijau/merah untung-rugi, tombol bisa membingungkan.";
        }
        return "";
    },

    // hitung & pasang semua warna dari pilihan sekarang
    refreshColors() {
        const html = document.documentElement;
        this.COLOR_VARS.forEach(v => html.style.removeProperty(v));

        const base = this.currentBg === "custom" ? this.customBg : this.BG_PRESETS[this.currentBg].base;
        const isDefaultBg = this.currentBg === "warm" || this.currentBg === "cream";
        let dark;
        if (this.currentBg === "warm") dark = true;
        else if (this.currentBg === "cream") dark = false;
        else dark = this.contrast("#ffffff", base) >= this.contrast("#000000", base);
        this.currentTheme = dark ? "dark" : "light";
        if (dark) html.setAttribute("data-theme", "dark");
        else html.removeAttribute("data-theme");

        const vars = {};
        let surface = dark ? "#211f1b" : "#fbf8f2";
        let bgHint = "";
        if (!isDefaultBg) {
            const d = this.deriveBg(base, dark);
            Object.assign(vars, d.vars);
            surface = d.surface;
            if (this.contrast(d.text, d.surface) < 7) bgHint = "Warna latar ini bikin teks kurang jelas, coba lebih gelap atau lebih terang.";
        }

        const accHex = this.currentAccent === "custom" ? this.customAccent : this.ACCENT_PRESETS[this.currentAccent];
        html.setAttribute("data-accent", this.currentAccent);
        if (this.currentAccent === "custom" || !isDefaultBg) {
            Object.assign(vars, this.deriveAccent(accHex, surface, dark, base));
        }
        Object.keys(vars).forEach(k => html.style.setProperty(k, vars[k]));
        this.currentVars = vars;
        this.currentBase = base;

        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", base);
        this.syncColorUI(accHex, bgHint);
    },

    syncColorUI(accHex, bgHint) {
        const dm = document.getElementById("setting-theme");
        if (dm) dm.checked = this.currentTheme === "dark";
        document.querySelectorAll("#accent-picker .swatch").forEach(b => b.classList.toggle("active", b.dataset.accent === this.currentAccent));
        document.querySelectorAll("#bg-picker .swatch").forEach(b => b.classList.toggle("active", b.dataset.bg === this.currentBg));

        const setPanel = (panelId, show, wheelId, textId, value) => {
            const panel = document.getElementById(panelId);
            if (panel) panel.classList.toggle("is-hidden", !show);
            const wheel = document.getElementById(wheelId);
            if (wheel) wheel.value = value;
            const text = document.getElementById(textId);
            if (text && document.activeElement !== text) text.value = value;
        };
        setPanel("accent-custom", this.currentAccent === "custom", "accent-color-input", "accent-hex-input", this.customAccent);
        setPanel("bg-custom", this.currentBg === "custom", "bg-color-input", "bg-hex-input", this.customBg);

        const ah = document.getElementById("accent-hint");
        if (ah) ah.textContent = this.currentAccent === "custom" ? this.accentHint(accHex) : "";
        const bh = document.getElementById("bg-hint");
        if (bh) bh.textContent = this.currentBg === "custom" ? (bgHint || "") : "";
    },

    // ----- penyimpanan -----
    loadPrefs() {
        try { return JSON.parse(localStorage.getItem("tradebook_prefs") || "{}") || {}; }
        catch (e) { return {}; }
    },

    savePrefs() {
        try {
            localStorage.setItem("tradebook_prefs", JSON.stringify({
                theme: this.currentTheme,
                accent: this.currentAccent,
                bg: this.currentBg,
                customAccent: this.customAccent,
                customBg: this.customBg,
                base: this.currentBase,
                vars: this.currentVars
            }));
        } catch (e) { /* tema tetap jalan walau gagal disimpan */ }
    },

    savePrefsSoon() {
        clearTimeout(this._prefsTimer);
        this._prefsTimer = setTimeout(() => this.savePrefs(), 250);
    },

    initPrefs() {
        const p = this.loadPrefs();
        const ca = this.parseColor(p.customAccent);
        const cb = this.parseColor(p.customBg);
        if (ca) this.customAccent = ca;
        if (cb) this.customBg = cb;
        this.currentAccent = (p.accent === "custom" || (typeof p.accent === "string" && this.has(this.ACCENT_PRESETS, p.accent))) ? p.accent : "cyan";
        // pilihan lama hanya punya "theme" (gelap/terang): petakan ke latar bawaan
        const fallbackBg = p.theme === "light" ? "cream" : "warm";
        this.currentBg = (p.bg === "custom" || (typeof p.bg === "string" && this.has(this.BG_PRESETS, p.bg))) ? p.bg : fallbackBg;
        this.refreshColors();
    },

    // ----- aksi dari Setelan -----
    toggleTheme() {
        this.setBg(this.currentTheme === "dark" ? "cream" : "warm");
    },

    setBg(name) {
        if (name === "custom") {
            if (this.currentBg !== "custom") this.customBg = this.currentBase; // mulai dari latar yang sedang dipakai
            this.currentBg = "custom";
        } else if (this.has(this.BG_PRESETS, name)) {
            this.currentBg = name;
        } else return;
        this.refreshColors();
        this.savePrefs();
    },

    setAccent(name) {
        if (name === "custom") {
            if (this.currentAccent !== "custom") this.customAccent = this.ACCENT_PRESETS[this.currentAccent] || this.customAccent;
            this.currentAccent = "custom";
        } else if (this.has(this.ACCENT_PRESETS, name)) {
            this.currentAccent = name;
        } else return;
        this.refreshColors();
        this.savePrefs();
    },

    setCustomAccent(raw) {
        const hex = this.parseColor(raw);
        if (!hex) {
            const h = document.getElementById("accent-hint");
            if (h) h.textContent = "Format kode: #22cfe8 atau 34, 207, 232";
            return;
        }
        this.customAccent = hex;
        this.currentAccent = "custom";
        this.refreshColors();
        this.savePrefsSoon();
    },

    setCustomBg(raw) {
        const hex = this.parseColor(raw);
        if (!hex) {
            const h = document.getElementById("bg-hint");
            if (h) h.textContent = "Format kode: #1a1b1d atau 26, 27, 29";
            return;
        }
        this.customBg = hex;
        this.currentBg = "custom";
        this.refreshColors();
        this.savePrefsSoon();
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
    openSheet({ title, message, fields = [], confirmLabel = "Konfirmasi", danger = false, hideConfirm = false, onConfirm }) {
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
            } else if (field.type === "image") {
                const holder = document.createElement("div");
                holder.className = "photo-field";
                holder.id = `sheet-input-${field.id}`;
                holder.dataset.value = field.value || "";

                const preview = document.createElement("div");
                preview.className = "photo-preview";
                const renderPreview = () => {
                    preview.innerHTML = "";
                    if (holder.dataset.value) {
                        const img = document.createElement("img");
                        img.alt = "";
                        img.src = holder.dataset.value;
                        preview.appendChild(img);
                    } else {
                        preview.innerHTML = '<i class="fa-solid fa-image"></i>';
                    }
                };
                renderPreview();

                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "image/*";
                fileInput.style.display = "none";
                fileInput.addEventListener("change", async () => {
                    const f = fileInput.files && fileInput.files[0];
                    if (!f) return;
                    try {
                        holder.dataset.value = await this.resizeImage(f);
                        renderPreview();
                        document.getElementById("sheet-error").textContent = "";
                    } catch (err) {
                        document.getElementById("sheet-error").textContent = "Foto gagal dibaca, coba foto lain.";
                    }
                    fileInput.value = "";
                });

                const actions = document.createElement("div");
                actions.className = "photo-actions";
                const pick = document.createElement("button");
                pick.type = "button";
                pick.className = "btn btn-secondary";
                pick.innerHTML = '<i class="fa-solid fa-camera"></i> Pilih Foto';
                pick.addEventListener("click", () => fileInput.click());
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "btn btn-secondary";
                remove.innerHTML = '<i class="fa-solid fa-trash"></i> Hapus';
                remove.addEventListener("click", () => { holder.dataset.value = ""; renderPreview(); });
                actions.appendChild(pick);
                actions.appendChild(remove);

                holder.appendChild(preview);
                holder.appendChild(actions);
                holder.appendChild(fileInput);
                wrap.appendChild(holder);
           } else if (field.type === "select") {
                const list = document.createElement("div");
                list.className = "checklist";
                list.id = `sheet-input-${field.id}`;
                list.dataset.value = field.default || (field.options[0] && field.options[0].value) || "";
                field.options.forEach(opt => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "checklist-option" + (opt.value === list.dataset.value ? " active" : "");
                    btn.textContent = opt.label;
                    btn.addEventListener("click", () => {
                        list.dataset.value = opt.value;
                        list.querySelectorAll(".checklist-option").forEach(b => b.classList.remove("active"));
                        btn.classList.add("active");
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
        newBtn.style.display = hideConfirm ? "none" : "";
        const actionsRow = document.querySelector(".sheet-actions");
        if (actionsRow) actionsRow.style.gridTemplateColumns = hideConfirm ? "1fr" : "";
        newBtn.addEventListener("click", () => {
            const values = {};
            fields.forEach(field => {
                const el = document.getElementById(`sheet-input-${field.id}`);
                if (field.type === "segmented" || field.type === "select") values[field.id] = el.dataset.value;
                else if (field.type === "checklist") values[field.id] = JSON.parse(el.dataset.value || "[]");
                else if (field.type === "image") values[field.id] = el.dataset.value || "";
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

    // sheet berisi daftar menu (dipakai tombol titik tiga)
    openMenu(title, items) {
        this.openSheet({ title, fields: [], hideConfirm: true, onConfirm: () => null });
        const body = document.getElementById("sheet-body");
        items.forEach(it => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sheet-menu-item";
            btn.innerHTML = `
                <span class="sheet-menu-icon"><i class="fa-solid ${it.icon}"></i></span>
                <span class="sheet-menu-text"><b>${this.esc(it.label)}</b><small>${this.esc(it.desc || "")}</small></span>
                <i class="fa-solid fa-chevron-right sheet-menu-arrow"></i>`;
            btn.addEventListener("click", () => it.onClick());
            body.appendChild(btn);
        });
    },

    // foto diperkecil di browser (max 640px, JPEG) biar gak menuh penyimpanan & backup cloud
    resizeImage(file, maxSize = 640, quality = 0.78) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("read"));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error("decode"));
                img.onload = () => {
                    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                    const w = Math.max(1, Math.round(img.width * scale));
                    const h = Math.max(1, Math.round(img.height * scale));
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL("image/jpeg", quality));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    },

    parseDecimal(raw) {
        if (raw === null || raw === undefined) return null;
        // spasi dibuang (MT5 nulis "4 153.20"); "1,234.56" -> koma = ribuan; "12,5" -> koma = desimal
        let cleaned = String(raw).trim().replace(/\s+/g, "");
        if (cleaned.includes(",") && cleaned.includes(".")) cleaned = cleaned.replace(/,/g, "");
        else cleaned = cleaned.replace(/,/g, ".");
        if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
    },

    // kosong = 0, salah format = null
    parseOptional(raw) {
        if (raw === null || raw === undefined || String(raw).trim() === "") return 0;
        return this.parseDecimal(raw);
    }
};

document.addEventListener("DOMContentLoaded", () => {
    app.init();
});
