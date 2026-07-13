/* =========================================================
   TRADEBOOK - Core JavaScript Application Logic
========================================================= */

const state = {
    investment: { assets: {}, currentAsset: null },
    categories: {
        Forex:  { balance: 0, deposited: 0, pnlTotal: 0, history: [] },
        Crypto: { balance: 0, deposited: 0, pnlTotal: 0, history: [] },
        Stocks: { balance: 0, deposited: 0, pnlTotal: 0, history: [] }
    },
    currentCategory: null
};

const app = {
    isBalanceHidden: false,
    currentTheme: 'dark',

    // ============================================
    // PERSISTENCE — fix untuk "data reset lagi pas reload"
    // ============================================
    saveState() {
        try {
            localStorage.setItem('tradebook_state', JSON.stringify(state));
        } catch (e) {
            console.error('Gagal menyimpan data:', e);
        }
    },

    loadState() {
        try {
            const raw = localStorage.getItem('tradebook_state');
            if (!raw) return;
            const saved = JSON.parse(raw);

            if (saved.investment && saved.investment.assets) {
                state.investment.assets = saved.investment.assets;
            }
            if (saved.categories) {
                Object.keys(state.categories).forEach(name => {
                    if (saved.categories[name]) state.categories[name] = saved.categories[name];
                });
            }
        } catch (e) {
            console.error('Gagal memuat data tersimpan:', e);
        }
    },

    init() {
        this.loadState();
        this.setDate();
        this.renderHome();
        this.renderTradingHub();
        this.renderStats();
        this.renderInvestmentView();
        this.attachRipples();
        console.log("TradeBook App Initialized! 🚀");
    },

    // Ripple effect untuk semua .clickable-card (Investment & Trading di home)
    attachRipples() {
        document.querySelectorAll('.clickable-card').forEach(card => {
            card.addEventListener('pointerdown', (e) => {
                const rect = card.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height);
                const ripple = document.createElement('span');
                ripple.className = 'ripple';
                ripple.style.width = ripple.style.height = size + 'px';
                ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
                ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
                card.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
            });
        });
    },

    setDate() {
        const dateElement = document.getElementById('current-date');
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        dateElement.textContent = new Date().toLocaleDateString('en-US', options);
    },

    formatCurrency(value) {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(value);
    },

    todayKey() {
        const d = new Date();
        return `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`;
    },

    formatAllBalances() {
        const elements = document.querySelectorAll('.balance-amount');
        elements.forEach(el => {
            const val = el.getAttribute('data-value');
            if (val !== null) {
                el.textContent = this.isBalanceHidden ? 'Rp ••••••••' : this.formatCurrency(val);
            }
        });
    },

    setBalance(el, value) {
        const oldValue = parseFloat(el.getAttribute('data-value')) || 0;
        const newValue = Number(value);
        el.setAttribute('data-value', newValue);

        if (this.isBalanceHidden) {
            el.textContent = 'Rp ••••••••';
            return;
        }

        if (oldValue === newValue) {
            el.textContent = this.formatCurrency(newValue);
            return;
        }

        this.animateValue(el, oldValue, newValue, 500);
    },

    // Animasi hitung naik/turun saat saldo berubah (ease-out, 500ms)
    animateValue(el, start, end, duration) {
        const startTime = performance.now();
        const step = (now) => {
            const progress = Math.min((now - startTime) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = start + (end - start) * eased;
            el.textContent = this.formatCurrency(Math.round(current));
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = this.formatCurrency(end);
            }
        };
        requestAnimationFrame(step);
    },

    toggleBalance() {
        this.isBalanceHidden = !this.isBalanceHidden;
        const eyeIcon = document.querySelector('.toggle-eye i');
        if (this.isBalanceHidden) {
            eyeIcon.classList.remove('fa-eye');
            eyeIcon.classList.add('fa-eye-slash');
        } else {
            eyeIcon.classList.remove('fa-eye-slash');
            eyeIcon.classList.add('fa-eye');
        }
        this.formatAllBalances();
        this.renderInvestmentList();

        const settingToggle = document.getElementById('setting-hide-balance');
        if (settingToggle) settingToggle.checked = this.isBalanceHidden;
    },

    toggleMenu() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('overlay');
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
        overlay.onclick = () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        };
    },

    navigate(viewId) {
        document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
        document.getElementById(`view-${viewId}`).classList.add('active');
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('overlay').classList.remove('active');
        window.scrollTo(0, 0);
    },

    // ============================================
    // DERIVED TOTALS
    // ============================================
    tradingTotal() {
        return Object.values(state.categories).reduce((sum, c) => sum + c.balance, 0);
    },

    totalBalance() {
        return this.investmentBalance() + this.tradingTotal();
    },

    investmentBalance() {
        return Object.values(state.investment.assets).reduce((sum, a) => sum + a.balance, 0);
    },

    overallTrendPercent() {
        const deposited = Object.values(state.categories).reduce((s, c) => s + c.deposited, 0);
        const pnl = Object.values(state.categories).reduce((s, c) => s + c.pnlTotal, 0);
        return deposited > 0 ? (pnl / deposited) * 100 : 0;
    },

    // ============================================
    // RENDER — HOME
    // ============================================
    renderHome() {
        this.setBalance(document.getElementById('home-total'), this.totalBalance());
        this.setBalance(document.getElementById('home-investment'), this.investmentBalance());
        this.setBalance(document.getElementById('home-trading'), this.tradingTotal());

        const trend = this.overallTrendPercent();
        const badge = document.getElementById('home-total-badge');
        badge.className = 'badge ' + (trend >= 0 ? 'profit' : 'loss');
        badge.innerHTML = `<i class="fa-solid fa-arrow-trend-${trend >= 0 ? 'up' : 'down'}"></i> ${trend >= 0 ? '+' : ''}${trend.toFixed(1)}% This Month`;

        const today = this.todayKey();
        let todayPnl = 0;
        let todayTrades = 0;
        Object.values(state.categories).forEach(cat => {
            cat.history.forEach(t => {
                if (t.kind === 'trade' && t.date === today) {
                    todayPnl += t.pnlValue;
                    todayTrades += 1;
                }
            });
        });

        const profitEl = document.getElementById('home-today-profit');
        profitEl.textContent = (todayPnl >= 0 ? '+ ' : '- ') + this.formatCurrency(Math.abs(todayPnl));
        profitEl.className = todayPnl >= 0 ? 'text-profit' : 'text-loss';
        document.getElementById('home-today-trades').textContent = todayTrades;

        const growthEl = document.getElementById('home-monthly-growth');
        growthEl.textContent = `${trend >= 0 ? '+ ' : '- '}${Math.abs(trend).toFixed(1)}%`;
        growthEl.className = trend >= 0 ? 'text-profit' : 'text-loss';
    },

    // ============================================
    // RENDER — TRADING
    // ============================================
    renderTradingHub() {
        this.setBalance(document.getElementById('trading-total'), this.tradingTotal());
        Object.keys(state.categories).forEach(name => {
            const cat = state.categories[name];
            this.setBalance(document.getElementById(`cat-list-${name}`), cat.balance);
            const trend = cat.deposited > 0 ? (cat.pnlTotal / cat.deposited) * 100 : 0;
            const trendEl = document.getElementById(`cat-trend-${name}`);
            trendEl.textContent = `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`;
            trendEl.className = 'cat-trend ' + (trend >= 0 ? 'text-profit' : 'text-loss');
        });
    },

    renderStats() {
        let profit = 0, loss = 0, wins = 0, trades = 0;
        Object.values(state.categories).forEach(cat => {
            cat.history.forEach(t => {
                if (t.kind !== 'trade') return;
                trades += 1;
                if (t.pnlValue >= 0) { profit += t.pnlValue; wins += 1; }
                else { loss += Math.abs(t.pnlValue); }
            });
        });

        this.setBalance(document.getElementById('stat-profit'), profit);
        this.setBalance(document.getElementById('stat-loss'), loss);
        document.getElementById('stat-winrate').textContent = trades > 0 ? `${Math.round((wins / trades) * 100)}%` : '0%';
        document.getElementById('stat-trades').textContent = trades;
        this.renderAssetAllocation();
    },

    renderAssetAllocation() {
        const colors = { Forex: '#00C853', Crypto: '#FFD700', Stocks: '#FF3D00' };
        const total = this.tradingTotal();
        const pie = document.getElementById('asset-pie');
        const legend = document.getElementById('asset-legend');
        legend.innerHTML = '';

        if (total <= 0) {
            pie.style.background = 'var(--border-color)';
            legend.innerHTML = '<p class="empty-state">Belum ada saldo trading untuk ditampilkan.</p>';
            return;
        }

        let cursor = 0;
        const stops = [];
        Object.keys(state.categories).forEach(name => {
            const value = Math.max(state.categories[name].balance, 0);
            const pct = (value / total) * 100;
            if (pct > 0) stops.push(`${colors[name]} ${cursor}% ${cursor + pct}%`);
            cursor += pct;

            const row = document.createElement('div');
            row.className = 'legend-row';
            row.innerHTML = `<span class="legend-dot" style="background:${colors[name]}"></span> ${name} <span class="legend-pct">${pct.toFixed(1)}%</span>`;
            legend.appendChild(row);
        });

        pie.style.background = `conic-gradient(${stops.join(', ')})`;
    },

    openCategory(name) {
        state.currentCategory = name;
        this.renderCategory();
        this.navigate('category');
    },

    renderCategory() {
        const name = state.currentCategory;
        const cat = state.categories[name];
        document.getElementById('cat-title').textContent = name;
        this.setBalance(document.getElementById('cat-balance'), cat.balance);
        const trend = cat.deposited > 0 ? (cat.pnlTotal / cat.deposited) * 100 : 0;
        const profitEl = document.getElementById('cat-profit');
        profitEl.textContent = `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`;
        profitEl.className = 'badge ' + (trend >= 0 ? 'profit' : 'loss');
        this.renderHistory();
    },

    renderHistory() {
        const container = document.getElementById('history-container');
        const cat = state.categories[state.currentCategory];
        container.innerHTML = '';
        if (cat.history.length === 0) {
            container.innerHTML = '<p class="empty-state">Belum ada transaksi di kategori ini.</p>';
            return;
        }
        const sorted = [...cat.history].sort((a, b) => b.timestamp - a.timestamp);
        sorted.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'history-card';
            const pnlClass = entry.pnlValue >= 0 ? 'text-profit' : 'text-loss';
            card.innerHTML = `
                <div class="hist-left">
                    <span class="hist-pair">${entry.label} <span class="hist-badge ${entry.badgeClass}">${entry.badgeText}</span></span>
                    <span class="hist-time">${entry.date}, ${entry.time}</span>
                </div>
                <div class="hist-actions">
                    <span class="hist-pnl ${pnlClass}">${entry.pnlValue >= 0 ? '+ ' : '- '}${this.formatCurrency(Math.abs(entry.pnlValue))}</span>
                    <button class="hist-delete" onclick="app.confirmDeleteEntry(${entry.timestamp})" aria-label="Hapus transaksi">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    // ============================================
    // RENDER — INVESTMENT (multi-aset, kayak Solana dll)
    // ============================================
    renderInvestmentView() {
        this.setBalance(document.getElementById('inv-total'), this.investmentBalance());
        this.renderInvestmentList();
    },

    renderInvestmentList() {
        const container = document.getElementById('investment-list');
        const assets = state.investment.assets;
        const names = Object.keys(assets);
        container.innerHTML = '';

        if (names.length === 0) {
            container.innerHTML = '<p class="empty-state">Belum ada aset investment. Tambah aset dulu, misal "Solana".</p>';
            return;
        }

        names.forEach(name => {
            const asset = assets[name];
            const safeName = name.replace(/'/g, "\\'");
            const card = document.createElement('div');
            card.className = 'card category-card';
            card.innerHTML = `
                <div class="cat-info" style="cursor:pointer;" onclick="app.openInvestmentAsset('${safeName}')">
                    <div class="cat-icon" style="background: rgba(255, 215, 0, 0.1); color: var(--primary-color);"><i class="fa-solid fa-coins"></i></div>
                    <div>
                        <h3>${name}</h3>
                        <p class="balance-amount">${this.isBalanceHidden ? 'Rp ••••••••' : this.formatCurrency(asset.balance)}</p>
                    </div>
                </div>
                <button class="hist-delete" onclick="app.confirmDeleteAssetFromList('${safeName}')" aria-label="Hapus aset">
                    <i class="fa-solid fa-trash"></i>
                </button>
            `;
            container.appendChild(card);
        });
    },

    handleAddAsset() {
        this.openSheet({
            title: 'Tambah Aset Investment',
            fields: [{ id: 'name', label: 'Nama Aset', type: 'text', placeholder: '' }],
            confirmLabel: 'Tambah',
            onConfirm: (values) => {
                const name = values.name.trim();
                if (!name) return 'Nama aset tidak boleh kosong.';
                if (state.investment.assets[name]) return 'Aset dengan nama ini sudah ada.';

                state.investment.assets[name] = { balance: 0, deposited: 0, history: [] };
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
        this.navigate('investment-asset');
    },

    renderInvestmentAsset() {
        const name = state.investment.currentAsset;
        const asset = state.investment.assets[name];
        if (!asset) { this.navigate('investment'); return; }

        document.getElementById('inv-asset-title').textContent = name;
        this.setBalance(document.getElementById('inv-asset-balance'), asset.balance);
        this.renderInvestmentHistory();
    },

    renderInvestmentHistory() {
        const container = document.getElementById('investment-history-container');
        const asset = state.investment.assets[state.investment.currentAsset];
        container.innerHTML = '';
        if (!asset || asset.history.length === 0) {
            container.innerHTML = '<p class="empty-state">Belum ada transaksi.</p>';
            return;
        }
        const sorted = [...asset.history].sort((a, b) => b.timestamp - a.timestamp);
        sorted.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'history-card';
            const pnlClass = entry.pnlValue >= 0 ? 'text-profit' : 'text-loss';
            card.innerHTML = `
                <div class="hist-left">
                    <span class="hist-pair">${entry.label} <span class="hist-badge ${entry.badgeClass}">${entry.badgeText}</span></span>
                    <span class="hist-time">${entry.date}, ${entry.time}</span>
                </div>
                <div class="hist-actions">
                    <span class="hist-pnl ${pnlClass}">${entry.pnlValue >= 0 ? '+ ' : '- '}${this.formatCurrency(Math.abs(entry.pnlValue))}</span>
                    <button class="hist-delete" onclick="app.confirmDeleteInvestmentEntry(${entry.timestamp})" aria-label="Hapus transaksi">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    },

    handleInvestmentDeposit() {
        this.openSheet({
            title: 'Deposit',
            fields: [{ id: 'amount', label: 'Jumlah (Rp)', type: 'text', inputmode: 'numeric', placeholder: '' }],
            confirmLabel: 'Deposit',
            onConfirm: (values) => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return 'Masukkan jumlah yang valid.';

                const asset = state.investment.assets[state.investment.currentAsset];
                asset.balance += amount;
                asset.deposited += amount;
                asset.history.push(this.makeEntry('deposit', 'Deposit', 'DEPOSIT', 'badge-buy', amount));

                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast('Deposit berhasil ditambahkan 🚀');
                return null;
            }
        });
    },

    handleInvestmentWithdraw() {
        this.openSheet({
            title: 'Withdraw',
            fields: [{ id: 'amount', label: 'Jumlah (Rp)', type: 'text', inputmode: 'numeric', placeholder: '' }],
            confirmLabel: 'Withdraw',
            onConfirm: (values) => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return 'Masukkan jumlah yang valid.';

                const asset = state.investment.assets[state.investment.currentAsset];
                if (amount > asset.balance) return 'Saldo aset tidak cukup.';

                asset.balance -= amount;
                asset.history.push(this.makeEntry('withdraw', 'Withdraw', 'WITHDRAW', 'badge-sell', -amount));

                this.saveState();
                this.renderInvestmentAsset();
                this.renderInvestmentView();
                this.renderHome();
                this.toast('Penarikan berhasil diproses 💸');
                return null;
            }
        });
    },

    confirmDeleteInvestmentEntry(timestamp) {
        this.openSheet({
            title: 'Hapus Transaksi?',
            message: 'Transaksi ini akan dihapus permanen dan saldo aset akan disesuaikan.',
            confirmLabel: 'Hapus',
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
        if (entry.kind === 'deposit') {
            asset.balance -= entry.pnlValue;
            asset.deposited -= entry.pnlValue;
        } else if (entry.kind === 'withdraw') {
            asset.balance -= entry.pnlValue;
        }

        asset.history.splice(idx, 1);
        this.saveState();
        this.renderInvestmentAsset();
        this.renderInvestmentView();
        this.renderHome();
        this.toast('Transaksi dihapus.');
    },

    confirmDeleteAsset() {
        const name = state.investment.currentAsset;
        this.openSheet({
            title: `Hapus Aset "${name}"?`,
            message: 'Aset ini beserta seluruh riwayat transaksinya akan dihapus permanen.',
            confirmLabel: 'Hapus',
            danger: true,
            onConfirm: () => {
                delete state.investment.assets[name];
                state.investment.currentAsset = null;
                this.saveState();
                this.renderInvestmentView();
                this.renderHome();
                this.navigate('investment');
                this.toast('Aset dihapus.');
                return null;
            }
        });
    },

    confirmDeleteAssetFromList(name) {
        this.openSheet({
            title: `Hapus Aset "${name}"?`,
            message: 'Aset ini beserta seluruh riwayat transaksinya akan dihapus permanen.',
            confirmLabel: 'Hapus',
            danger: true,
            onConfirm: () => {
                delete state.investment.assets[name];
                this.saveState();
                this.renderInvestmentView();
                this.renderHome();
                this.toast('Aset dihapus.');
                return null;
            }
        });
    },

    // ============================================
    // THEME
    // ============================================
    toggleTheme() {
        const html = document.documentElement;
        if (this.currentTheme === 'dark') {
            html.removeAttribute('data-theme');
            this.currentTheme = 'light';
        } else {
            html.setAttribute('data-theme', 'dark');
            this.currentTheme = 'dark';
        }
        const settingToggle = document.getElementById('setting-theme');
        if (settingToggle) settingToggle.checked = this.currentTheme === 'dark';
    },

    // ============================================
    // TOAST
    // ============================================
    toast(message) {
        const toastEl = document.getElementById('toast');
        toastEl.textContent = message;
        toastEl.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
    },

    // ============================================
    // BOTTOM SHEET
    // ============================================
    openSheet({ title, message, fields = [], confirmLabel = 'Konfirmasi', danger = false, onConfirm }) {
        document.getElementById('sheet-title').textContent = title;
        document.getElementById('sheet-error').textContent = '';

        const body = document.getElementById('sheet-body');
        body.innerHTML = '';

        if (message) {
            const p = document.createElement('p');
            p.className = 'sheet-message';
            p.textContent = message;
            body.appendChild(p);
        }

        fields.forEach(field => {
            const wrap = document.createElement('div');
            wrap.className = 'sheet-field';
            const label = document.createElement('label');
            label.textContent = field.label;
            wrap.appendChild(label);

            if (field.type === 'segmented') {
                const seg = document.createElement('div');
                seg.className = 'segmented';
                seg.id = `sheet-input-${field.id}`;
                seg.dataset.value = field.default || field.options[0];
                field.options.forEach(opt => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'segmented-option' + (opt === seg.dataset.value ? ' active' : '');
                    btn.textContent = opt;
                    btn.addEventListener('click', () => {
                        seg.dataset.value = opt;
                        seg.querySelectorAll('.segmented-option').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                    });
                    seg.appendChild(btn);
                });
                wrap.appendChild(seg);
            } else {
                const input = document.createElement('input');
                input.className = 'sheet-input';
                input.id = `sheet-input-${field.id}`;
                input.type = field.type || 'text';
                if (field.placeholder) input.placeholder = field.placeholder;
                if (field.inputmode) input.inputMode = field.inputmode;
                wrap.appendChild(input);
            }
            body.appendChild(wrap);
        });

        const confirmBtn = document.getElementById('sheet-confirm-btn');
        confirmBtn.textContent = confirmLabel;
        confirmBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

        const newBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
        newBtn.addEventListener('click', () => {
            const values = {};
            fields.forEach(field => {
                const el = document.getElementById(`sheet-input-${field.id}`);
                values[field.id] = field.type === 'segmented' ? el.dataset.value : el.value;
            });
            const error = onConfirm(values);
            if (error) {
                document.getElementById('sheet-error').textContent = error;
            } else {
                this.closeSheet();
            }
        });

        document.getElementById('sheet-overlay').classList.add('active');
        document.getElementById('bottom-sheet').classList.add('open');

        setTimeout(() => {
            const first = body.querySelector('input.sheet-input');
            if (first) first.focus();
        }, 300);
    },

    closeSheet() {
        document.getElementById('sheet-overlay').classList.remove('active');
        document.getElementById('bottom-sheet').classList.remove('open');
    },

    parseAmount(raw) {
        if (raw === null || raw === undefined) return null;
        const cleaned = String(raw).trim().replace(/[.\s]/g, '').replace(/,/g, '.');
        if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
        const num = Number(cleaned);
        if (!Number.isF(init)(num)) return null;
        return Math.round(num);
    },

    // ============================================
    // TRADING — DEPOSIT / WITHDRAW / ADD TRADE
    // ============================================
    handleDeposit() {
        this.openSheet({
            title: 'Deposit',
            fields: [{ id: 'amount', label: 'Jumlah (Rp)', type: 'text', inputmode: 'numeric', placeholder: '' }],
            confirmLabel: 'Deposit',
            onConfirm: (values) => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return 'Masukkan jumlah yang valid.';

                const cat = state.categories[state.currentCategory];
                cat.balance += amount;
                cat.deposited += amount;
                cat.history.push(this.makeEntry('deposit', 'Deposit', 'DEPOSIT', 'badge-buy', amount));

                this.saveState();
                this.renderCategory();
                this.renderTradingHub();
                this.renderHome();
                this.toast('Deposit berhasil ditambahkan 🚀');
                return null;
            }
        });
    },

    handleWithdraw() {
        this.openSheet({
            title: 'Withdraw',
            fields: [{ id: 'amount', label: 'Jumlah (Rp)', type: 'text', inputmode: 'numeric', placeholder: '' }],
            confirmLabel: 'Withdraw',
            onConfirm: (values) => {
                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return 'Masukkan jumlah yang valid.';

                const cat = state.categories[state.currentCategory];
                if (amount > cat.balance) return 'Saldo kamu tidak cukup.';

                cat.balance -= amount;
                cat.history.push(this.makeEntry('withdraw', 'Withdraw', 'WITHDRAW', 'badge-sell', -amount));

                this.saveState();
                this.renderCategory();
                this.renderTradingHub();
                this.renderHome();
                this.toast('Penarikan berhasil diproses 💸');
                return null;
            }
        });
    },

    makeEntry(kind, label, badgeText, badgeClass, pnlValue) {
        const now = new Date();
        return {
            kind, label, badgeText, badgeClass, pnlValue,
            date: this.todayKey(),
            time: now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0'),
            timestamp: now.getTime()
        };
    },

    handleAddTrade() {
        this.openSheet({
            title: 'Tambah Posisi Trade',
            fields: [
                { id: 'pair', label: 'Pair', type: 'text', placeholder: '' },
                { id: 'type', label: 'Jenis Trade', type: 'segmented', options: ['BUY', 'SELL'], default: 'BUY' },
                { id: 'sign', label: 'Hasil', type: 'segmented', options: ['Profit', 'Loss'], default: 'Profit' },
                { id: 'amount', label: 'Jumlah (Rp)', type: 'text', inputmode: 'numeric', placeholder: '' }
            ],
            confirmLabel: 'Tambah',
            onConfirm: (values) => {
                const pair = values.pair.trim();
                if (!pair) return 'Pair tidak boleh kosong.';

                const amount = this.parseAmount(values.amount);
                if (amount === null || amount <= 0) return 'Jumlah harus berupa angka positif, contoh: 150000.';

                const pnlValue = values.sign === 'Loss' ? -amount : amount;
                const badgeClass = values.type === 'BUY' ? 'badge-buy' : 'badge-sell';
                const entry = this.makeEntry('trade', pair.toUpperCase(), values.type, badgeClass, pnlValue);

                const cat = state.categories[state.currentCategory];
                cat.history.push(entry);
                cat.balance += pnlValue;
                cat.pnlTotal += pnlValue;

                this.saveState();
                this.renderCategory();
                this.renderTradingHub();
                this.renderHome();
                this.renderStats();
                this.toast('Posisi baru berhasil ditambahkan 🔥');
                return null;
            }
        });
    },

    confirmDeleteEntry(timestamp) {
        this.openSheet({
            title: 'Hapus Transaksi?',
            message: 'Transaksi ini akan dihapus permanen dan saldo kategori akan disesuaikan.',
            confirmLabel: 'Hapus',
            danger: true,
            onConfirm: () => {
                this.removeHistoryEntry(timestamp);
                return null;
            }
        });
    },

    removeHistoryEntry(timestamp) {
        const cat = state.categories[state.currentCategory];
        const idx = cat.history.findIndex(e => e.timestamp === timestamp);
        if (idx === -1) return;

        const entry = cat.history[idx];
        if (entry.kind === 'deposit') {
            cat.balance -= entry.pnlValue;
            cat.deposited -= entry.pnlValue;
        } else if (entry.kind === 'withdraw') {
            cat.balance -= entry.pnlValue;
        } else if (entry.kind === 'trade') {
            cat.balance -= entry.pnlValue;
            cat.pnlTotal -= entry.pnlValue;
        }

        cat.history.splice(idx, 1);
        this.saveState();
        this.renderCategory();
        this.renderTradingHub();
        this.renderHome();
        this.renderStats();
        this.toast('Transaksi dihapus.');
    },

    confirmResetAll() {
        this.openSheet({
            title: 'Reset Semua Data?',
            message: 'Semua saldo, deposit, withdraw, aset investment, dan riwayat trading akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.',
            confirmLabel: 'Reset Semua',
            danger: true,
            onConfirm: () => {
                this.resetAllData();
                return null;
            }
        });
    },

    resetAllData() {
        state.investment = { assets: {}, currentAsset: null };
        Object.keys(state.categories).forEach(name => {
            state.categories[name] = { balance: 0, deposited: 0, pnlTotal: 0, history: [] };
        });
        state.currentCategory = null;

        this.saveState();
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('overlay').classList.remove('active');

        this.renderHome();
        this.renderTradingHub();
        this.renderStats();
        this.renderInvestmentView();
        this.navigate('home');
        this.toast('Semua data berhasil direset.');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    app.init();
});