/* ============================================================
   app.js — Workbench ERP
   Views: Dashboard · Inventory (Stock / Incoming purchases)
          Orders · Customers
   ============================================================ */

const STATUSES = ['In production', 'Ready for shipping', 'Completed', 'Delivered'];
const fmtMoney = n => '฿' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtDate = ts => {
  const d = new Date(ts);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
};
const timeAgo = ts => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtGrams = g => g >= 1000
  ? (g / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 }) + ' kg'
  : g + ' g';
// How an order line reads: "2 × Oak shelf" for pieces, "1.104 kg Sea salt" for weight.
const itemLabel = (i, qty = i.qty) => i.unitType === 'weight'
  ? `${fmtGrams(qty)} ${esc(i.name)}`
  : `${qty} × ${esc(i.name)}`;
// Line price: weight items are priced per kg on actual grams, always rounded DOWN.
const lineTotal = l => l.unitType === 'weight' || l.weightBased
  ? Math.floor((l.qty || 0) / 1000 * (l.unitPrice || 0))
  : (l.qty || 0) * (l.unitPrice || 0);
const $ = sel => document.querySelector(sel);

/* Date-input helpers: today keeps the exact current time (natural activity
   ordering); a backdated day is stored at noon local time. */
const tsToDateInput = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateInputToTs = str => {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  const t = new Date();
  const isToday = y === t.getFullYear() && m === t.getMonth() + 1 && d === t.getDate();
  return isToday ? Date.now() : new Date(y, m - 1, d, 12).getTime();
};

const state = {
  view: 'dashboard',
  invTab: 'stock',
  stockFilter: 'all',
  statusFilter: 'all',
  period: 'month', // dashboard stats: 'month' | 'quarter' | 'year'
  periodOffset: 0, // 0 = current period, -1 = previous, etc.
  search: { product: '', order: '', customer: '' }
};

/* ---------------- Theme (auto / light / dark) ---------------- */
function applyTheme(pref) {
  localStorage.setItem('erp_theme', pref);
  document.documentElement.dataset.theme = pref === 'auto' ? '' : pref;
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#121318' : '#FBF8FF';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem('erp_theme') || 'auto') === 'auto') applyTheme('auto');
});
$('#themeBtn').addEventListener('click', () => {
  const cur = localStorage.getItem('erp_theme') || 'auto';
  openSheet(`
    <h2>Theme</h2>
    <div class="chip-row">
      <button class="chip ${cur === 'auto' ? 'is-selected' : ''}" data-theme-pick="auto">System (auto)</button>
      <button class="chip ${cur === 'light' ? 'is-selected' : ''}" data-theme-pick="light">Light</button>
      <button class="chip ${cur === 'dark' ? 'is-selected' : ''}" data-theme-pick="dark">Dark</button>
    </div>`);
  document.querySelectorAll('[data-theme-pick]').forEach(c =>
    c.addEventListener('click', () => { applyTheme(c.dataset.themePick); closeSheet(); }));
});
applyTheme(localStorage.getItem('erp_theme') || 'auto');

/* ---------------- Navigation ---------------- */
const VIEW_TITLES = { dashboard: 'Dashboard', inventory: 'Inventory', orders: 'Orders', customers: 'Customers' };
const FAB_CONFIG = {
  dashboard: { label: 'Order',   action: () => openOrderForm() },
  inventory: { label: 'Product', action: () => openProductForm() },
  orders:    { label: 'Order',   action: () => openOrderForm() },
  customers: { label: 'Customer',action: () => openCustomerForm() }
};

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  $('#view-' + view).hidden = false;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $('#viewTitle').textContent = VIEW_TITLES[view];

  const fab = $('#fab');
  const cfg = FAB_CONFIG[view];
  fab.hidden = !cfg || (view === 'inventory' && state.invTab === 'purchases');
  if (cfg) { $('#fabLabel').textContent = cfg.label; fab.onclick = cfg.action; }

  render();
}

document.querySelectorAll('.nav-item').forEach(b =>
  b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------------- Sheet (modal) ---------------- */
function openSheet(html) {
  $('#sheetContent').innerHTML = html;
  const sheet = $('#sheet');
  sheet.style.transform = '';
  sheet.hidden = false;
  $('#scrim').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#scrim').hidden = true;
  $('#sheet').style.transform = '';
}
$('#scrim').addEventListener('click', closeSheet);

/* Swipe down to dismiss the sheet. Non-passive touchmove lets us take over
   from native scrolling; drag only engages when content is at the top. */
(function enableSheetDrag() {
  const sheet = $('#sheet');
  let startY = 0, dy = 0, active = false, engaged = false;

  sheet.addEventListener('touchstart', e => {
    active = sheet.scrollTop <= 0;
    engaged = false;
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', e => {
    if (!active) return;
    dy = e.touches[0].clientY - startY;
    if (!engaged) {
      if (dy > 8) {           // clearly downward: take over the gesture
        engaged = true;
        sheet.style.transition = 'none';
      } else if (dy < -8) {   // upward: this is a scroll, leave it alone
        active = false;
        return;
      } else return;
    }
    e.preventDefault();       // stop native scroll / pull-to-refresh
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });

  const end = () => {
    if (!engaged) { active = false; return; }
    active = false; engaged = false;
    sheet.style.transition = 'transform .2s ease';
    if (dy > 110) closeSheet();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
})();

/* Long-press helper: fires after 550 ms of holding still; the click that
   follows a long-press is swallowed so it doesn't also open the item. */
function attachLongPress(el, fn) {
  let timer = null, fired = false;
  const start = () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(30);
      fn();
    }, 550);
  };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);   // desktop testing
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
  }, true);
}

/* Confirm dialog for destructive actions. */
function showConfirm(message, onConfirm) {
  $('#confirmText').textContent = message;
  $('#confirmDialog').hidden = false;
  $('#confirmScrim').hidden = false;
  const close = () => { $('#confirmDialog').hidden = true; $('#confirmScrim').hidden = true; };
  $('#confirmCancel').onclick = close;
  $('#confirmScrim').onclick = close;
  $('#confirmOk').onclick = () => { close(); onConfirm(); };
}

/* Swipeable card: drag right → edit (left pane), drag left → delete (right
   pane). Locks to horizontal or vertical after the first ~12px so list
   scrolling keeps working; a completed swipe swallows the follow-up click. */
function attachSwipe(wrap, { onEdit, onDelete }) {
  const card = wrap.querySelector('.card');
  let sx = 0, sy = 0, dx = 0, mode = null, actionFired = false;

  card.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    dx = 0; mode = null;
    card.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    const x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
    if (mode === null) {
      if (Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.5) mode = 'swipe';
      else if (Math.abs(y) > 12) mode = 'scroll';
      else return;
    }
    if (mode !== 'swipe') return;
    e.preventDefault();
    dx = x;
    card.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle('show-left', dx > 0);
    wrap.classList.toggle('show-right', dx < 0);
  }, { passive: false });

  const end = () => {
    const wasSwipe = mode === 'swipe';
    const t = dx;
    mode = null; dx = 0;
    card.style.transition = 'transform .18s ease';
    card.style.transform = '';
    setTimeout(() => wrap.classList.remove('show-left', 'show-right'), 180);
    if (!wasSwipe) return;
    actionFired = true;
    setTimeout(() => { actionFired = false; }, 400);
    if (t < -80) onDelete();
    else if (t > 80) onEdit();
  };
  card.addEventListener('touchend', end);
  card.addEventListener('touchcancel', end);
  card.addEventListener('click', e => {
    if (actionFired) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}
const SWIPE_PANES = `
  <div class="swipe-bg left"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>Edit</div>
  <div class="swipe-bg right">Delete<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg></div>`;

let snackTimer = null;
function snack(msg) {
  const el = $('#snackbar');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.hidden = true; }, Math.min(6000, 2800 + msg.length * 25));
}

/* ---------------- Rendering ---------------- */
async function render() {
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'inventory') { renderProducts(); renderPurchases(); }
  if (state.view === 'orders') renderOrders();
  if (state.view === 'customers') renderCustomers();
}

/* ----- Dashboard ----- */
async function renderDashboard() {
  const [orders, products, purchases] = await Promise.all([
    DB.getAll('orders'), DB.getAll('products'), DB.getAll('purchases')
  ]);

  const now = new Date();
  const off = state.periodOffset;
  let pStart, pEnd, periodLabel;
  if (state.period === 'month') {
    pStart = new Date(now.getFullYear(), now.getMonth() + off, 1);
    pEnd = new Date(now.getFullYear(), now.getMonth() + off + 1, 1);
    periodLabel = pStart.toLocaleDateString(undefined, { month: 'long', ...(pStart.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  } else if (state.period === 'quarter') {
    const qBase = Math.floor(now.getMonth() / 3) * 3 + off * 3;
    pStart = new Date(now.getFullYear(), qBase, 1);
    pEnd = new Date(now.getFullYear(), qBase + 3, 1);
    periodLabel = 'Q' + (Math.floor(pStart.getMonth() / 3) + 1) + ' ' + pStart.getFullYear();
  } else {
    pStart = new Date(now.getFullYear() + off, 0, 1);
    pEnd = new Date(now.getFullYear() + off + 1, 0, 1);
    periodLabel = String(pStart.getFullYear());
  }
  const periodStart = pStart.getTime(), periodEnd = pEnd.getTime();

  // Payment is taken before shipping, so every order placed counts as revenue.
  const periodOrders = orders.filter(o => o.createdAt >= periodStart && o.createdAt < periodEnd);
  const revenue = periodOrders.reduce((s, o) => s + o.total, 0);
  const periodPurchases = purchases.filter(pu => pu.receivedAt >= periodStart && pu.receivedAt < periodEnd);
  const costs = periodPurchases.reduce((s, pu) => s + (pu.amount || 0), 0);
  const profit = revenue - costs;

  // Month-on-month revenue vs costs, last 6 months (independent of the selector).
  const monthly = [...Array(6)].map((_, k) => {
    const s = new Date(now.getFullYear(), now.getMonth() - 5 + k, 1).getTime();
    const e = new Date(now.getFullYear(), now.getMonth() - 4 + k, 1).getTime();
    const rev = orders.filter(o => o.createdAt >= s && o.createdAt < e).reduce((sum, o) => sum + o.total, 0);
    const cost = purchases.filter(pu => pu.receivedAt >= s && pu.receivedAt < e).reduce((sum, pu) => sum + (pu.amount || 0), 0);
    return { label: new Date(s).toLocaleDateString(undefined, { month: 'short' }), rev, cost, current: k === 5 };
  });
  const maxRev = Math.max(1, ...monthly.map(m => Math.max(m.rev, m.cost)));
  const fmtCompact = n => n >= 10000 ? '฿' + Math.round(n / 1000) + 'k' : n >= 1000 ? '฿' + (n / 1000).toFixed(1) + 'k' : '฿' + n;

  const inProduction = orders.filter(o => o.status === STATUSES[0]).length;
  const readyToShip = orders.filter(o => o.status === STATUSES[1]).length;
  // Current stock value at selling price; weight stock is in grams, priced per kg.
  const stockValue = products.reduce((s, p) => {
    if (p.trackStock === false) return s;
    return s + (p.unit === 'weight' ? Math.floor(p.stock / 1000 * (p.price || 0)) : p.stock * (p.price || 0));
  }, 0);
  const lowStock = products.filter(p => p.trackStock !== false && p.stock > 0 && p.stock <= p.lowStock).length;
  const outOfStock = products.filter(p => p.trackStock !== false && p.stock === 0).length;

  // Activity feed: newest order events + stock receipts, merged.
  const events = [];
  orders.forEach(o => {
    events.push({ ts: o.createdAt, type: 'sale', text: `Order #${o.id} — ${esc(o.customerName)}, ${fmtMoney(o.total)}` });
    if (o.statusChangedAt && o.status !== STATUSES[0])
      events.push({ ts: o.statusChangedAt, type: 'status', text: `Order #${o.id} moved to “${o.status}”` });
  });
  purchases.forEach(p => events.push({ ts: p.receivedAt, type: 'stock', text: `Spent ${fmtMoney(p.amount)} on ${esc(p.description)}${p.supplier ? ' — ' + esc(p.supplier) : ''}` }));
  events.sort((a, b) => b.ts - a.ts);

  const empty = !orders.length && !products.length;
  $('#view-dashboard').innerHTML = empty ? `
    <div class="empty">
      <div class="title">Your workbench is empty</div>
      <div>Add products and orders, or start with sample data to explore the app.</div>
      <button class="btn-tonal" id="seedBtn">Load sample data</button>
    </div>` : `
    <div class="chip-row" id="periodChips">
      <button class="chip ${state.period === 'month' ? 'is-selected' : ''}" data-period="month">Month</button>
      <button class="chip ${state.period === 'quarter' ? 'is-selected' : ''}" data-period="quarter">Quarter</button>
      <button class="chip ${state.period === 'year' ? 'is-selected' : ''}" data-period="year">Year</button>
    </div>
    <div class="period-nav">
      <button id="periodPrev" title="Previous">‹</button>
      <span class="label">${periodLabel}</span>
      <button id="periodNext" title="Next" ${off >= 0 ? 'disabled' : ''}>›</button>
    </div>
    <div class="stat-grid">
      <div class="stat-card hero">
        <div class="label">Revenue · ${periodLabel}</div>
        <div class="value">${fmtMoney(revenue)}</div>
        <div class="hint">${periodOrders.length} order${periodOrders.length === 1 ? '' : 's'}</div>
      </div>
      <div class="stat-card">
        <div class="label">Costs · ${periodLabel}</div>
        <div class="value">${fmtMoney(costs)}</div>
        <div class="hint">${periodPurchases.length} purchase${periodPurchases.length === 1 ? '' : 's'}</div>
      </div>
      <div class="stat-card ${profit < 0 ? 'warn' : ''}">
        <div class="label">Profit · ${periodLabel}</div>
        <div class="value">${profit < 0 ? '−' + fmtMoney(-profit) : fmtMoney(profit)}</div>
        <div class="hint">revenue − costs</div>
      </div>
      <div class="stat-card">
        <div class="label">In production</div>
        <div class="value">${inProduction}</div>
      </div>
      <div class="stat-card">
        <div class="label">Ready for shipping</div>
        <div class="value">${readyToShip}</div>
      </div>
      <div class="stat-card" style="grid-column:1/-1">
        <div class="label">Stock value</div>
        <div class="value">${fmtMoney(stockValue)}</div>
        <div class="hint">current stock × selling price</div>
      </div>
      ${(lowStock + outOfStock) ? `
      <div class="stat-card warn" style="grid-column:1/-1" id="lowStockCard" role="button" tabindex="0">
        <div class="label">Stock alerts</div>
        <div class="value">${lowStock + outOfStock}</div>
        <div class="hint">${lowStock} low · ${outOfStock} out of stock — tap to review</div>
      </div>` : ''}
    </div>
    <h2 class="section-label">Revenue vs costs · last 6 months</h2>
    <div class="card">
      <div class="chart">
        ${monthly.map(m => `
          <div class="chart-col ${m.current ? 'is-current' : ''}">
            <span class="chart-val">${m.rev ? fmtCompact(m.rev) : ''}</span>
            <div class="chart-bars">
              <div class="chart-bar" style="height:${Math.round(m.rev / maxRev * 100)}%" title="Revenue ${fmtMoney(m.rev)}"></div>
              <div class="chart-bar cost" style="height:${Math.round(m.cost / maxRev * 100)}%" title="Costs ${fmtMoney(m.cost)}"></div>
            </div>
            <span class="chart-label">${m.label}</span>
          </div>`).join('')}
      </div>
      <div class="chart-legend">
        <span><span class="legend-dot rev"></span>Revenue</span>
        <span><span class="legend-dot cost"></span>Costs</span>
      </div>
    </div>
    <h2 class="section-label">Recent activity</h2>
    <div class="card">
      ${events.slice(0, 8).map(e => `
        <div class="activity-item">
          <span class="activity-ico ${e.type === 'sale' ? 'sale' : ''}">
            ${e.type === 'stock'
              ? '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.3 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.4 1-1 1-1.7V4c0-1.1-1-2-2-2m-5 12H9v-2h6zm5-7H4V4h16z"/></svg>'
              : e.type === 'status'
              ? '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
              : '<svg viewBox="0 0 24 24"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1H6.32c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4"/></svg>'}
          </span>
          <div class="activity-body">
            <div>${e.text}</div>
            <div class="when">${timeAgo(e.ts)}</div>
          </div>
        </div>`).join('') || '<div class="empty">No activity yet.</div>'}
    </div>`;

  const seed = $('#seedBtn');
  if (seed) seed.onclick = seedSampleData;
  const lowCard = $('#lowStockCard');
  if (lowCard) lowCard.onclick = () => { state.stockFilter = 'low'; switchView('inventory'); syncStockChips(); };
  document.querySelectorAll('#periodChips [data-period]').forEach(chip =>
    chip.addEventListener('click', () => { state.period = chip.dataset.period; state.periodOffset = 0; renderDashboard(); }));
  const prev = $('#periodPrev'), next = $('#periodNext');
  if (prev) prev.onclick = () => { state.periodOffset--; renderDashboard(); };
  if (next) next.onclick = () => { if (state.periodOffset < 0) { state.periodOffset++; renderDashboard(); } };
}

/* ----- Inventory: products ----- */
// Weight-type products store stock in grams internally; show it humanized.
function fmtStock(p) {
  if (p.unit === 'weight') return fmtGrams(p.stock);
  return String(p.stock);
}

// 'tracked' | 'made' (made to order, never stocked) | 'service' (e.g. Delivery)
const stockMode = p => p.stockMode || (p.trackStock === false ? 'service' : 'tracked');
const MODE_TAGS = { made: 'made to order', service: 'service' };

function stockBadge(p) {
  if (p.trackStock === false) return '';
  if (p.stock === 0) return '<span class="badge badge-out"><span class="dot"></span>Out of stock</span>';
  if (p.stock <= p.lowStock) return `<span class="badge badge-low"><span class="dot"></span>Low stock — ${fmtStock(p)} left</span>`;
  return '';
}

async function renderProducts() {
  const products = await DB.getAll('products');
  const q = state.search.product.toLowerCase();
  let list = products.filter(p =>
    p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q));
  if (state.stockFilter === 'low') list = list.filter(p => p.trackStock !== false && p.stock > 0 && p.stock <= p.lowStock);
  if (state.stockFilter === 'out') list = list.filter(p => p.trackStock !== false && p.stock === 0);
  list.sort((a, b) => a.name.localeCompare(b.name));

  $('#productList').innerHTML = list.map(p => `
    <div class="swipe" data-pid="${p.id}">
      ${SWIPE_PANES}
      <div class="card is-tappable" role="button" tabindex="0">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(p.name)}</div>
            <div class="sub">${esc(p.sku || 'No SKU')} · ${fmtMoney(p.price)} / ${p.unit === 'weight' ? 'kg' : 'unit'}</div>
            ${stockBadge(p)}
          </div>
          <div class="row-end">
            ${p.trackStock === false
              ? `<div class="big">∞</div><div class="sub">${MODE_TAGS[stockMode(p)]}</div>`
              : `<div class="big">${fmtStock(p)}</div><div class="sub">in stock</div>`}
          </div>
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><div class="title">No products found</div><div>${products.length ? 'Try a different search or filter.' : 'Add your first product with the button below.'}</div></div>`;

  document.querySelectorAll('#productList .swipe[data-pid]').forEach(wrap => {
    const p = list.find(x => x.id === Number(wrap.dataset.pid));
    const card = wrap.querySelector('.card');
    card.addEventListener('click', () => openProductForm(p.id));
    const confirmDelete = () => showConfirm(`Delete “${p.name}”?`, async () => {
      await DB.delete('products', p.id);
      snack('Product deleted'); render();
    });
    attachSwipe(wrap, { onEdit: () => openProductForm(p.id), onDelete: confirmDelete });
    attachLongPress(card, () => confirmDelete());
  });
}

/* ----- Inventory: incoming purchases (a pure expense log — no stock effect) ----- */
async function renderPurchases() {
  const purchases = await DB.getAll('purchases');
  purchases.sort((a, b) => b.receivedAt - a.receivedAt);
  $('#purchaseList').innerHTML = purchases.slice(0, 30).map(p => `
    <div class="swipe" data-puid="${p.id}">
      ${SWIPE_PANES}
      <div class="card">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(p.description)}</div>
            <div class="sub">${p.supplier ? esc(p.supplier) + ' · ' : ''}${fmtDate(p.receivedAt)}</div>
          </div>
          <div class="row-end"><div class="big">${fmtMoney(p.amount)}</div></div>
        </div>
      </div>
    </div>`).join('') || '<div class="empty"><div class="title">No purchases yet</div><div>Money spent on stock or materials will appear here.</div></div>';

  document.querySelectorAll('#purchaseList .swipe[data-puid]').forEach(wrap => {
    const p = purchases.find(x => x.id === Number(wrap.dataset.puid));
    const confirmDelete = () => showConfirm(`Delete purchase “${p.description}” (${fmtMoney(p.amount)})?`, async () => {
      await DB.delete('purchases', p.id);
      snack('Purchase deleted'); render();
    });
    attachSwipe(wrap, { onEdit: () => openPurchaseForm(p), onDelete: confirmDelete });
    attachLongPress(wrap.querySelector('.card'), () => confirmDelete());
  });

  // Prefill the log form's date with today
  if (!$('#poDate').value) $('#poDate').value = tsToDateInput(Date.now());
}

/* Edit an existing expense entry. */
function openPurchaseForm(p) {
  openSheet(`
    <h2>Edit purchase</h2>
    <div class="form-card">
      <label class="field"><span>What did you buy</span><input id="peDescription" value="${esc(p.description)}"></label>
      <div class="field-row">
        <label class="field"><span>Amount spent (฿)</span><input id="peAmount" type="number" min="0" step="1" inputmode="numeric" value="${p.amount}"></label>
        <label class="field"><span>Date</span><input type="date" id="peDate" value="${tsToDateInput(p.receivedAt)}"></label>
      </div>
      <label class="field"><span>Supplier (optional)</span><input id="peSupplier" value="${esc(p.supplier || '')}"></label>
      <button class="btn-filled" id="peSave">Save changes</button>
    </div>`);
  $('#peSave').onclick = async () => {
    const description = $('#peDescription').value.trim();
    const amount = Number($('#peAmount').value);
    const ts = dateInputToTs($('#peDate').value);
    if (!description) return snack('Enter what you bought');
    if (!(amount > 0)) return snack('Enter an amount greater than 0');
    if (!ts) return snack('Pick a date');
    await DB.put('purchases', { ...p, description, amount, supplier: $('#peSupplier').value.trim(), receivedAt: ts });
    closeSheet(); snack('Purchase updated'); render();
  };
}

$('#poReceive').addEventListener('click', async () => {
  const description = $('#poDescription').value.trim();
  const amount = Number($('#poAmount').value);
  const ts = dateInputToTs($('#poDate').value);
  if (!description) return snack('Enter what you bought');
  if (!(amount > 0)) return snack('Enter an amount greater than 0');
  if (!ts) return snack('Pick a date');

  await DB.add('purchases', {
    description, amount,
    supplier: $('#poSupplier').value.trim(),
    receivedAt: ts
  });
  $('#poDescription').value = ''; $('#poAmount').value = ''; $('#poSupplier').value = '';
  $('#poDate').value = tsToDateInput(Date.now());
  snack(`Logged ${fmtMoney(amount)} — ${description}`);
  render();
});

/* ----- Product form ----- */
async function openProductForm(id) {
  const p = id ? await DB.get('products', id) : { name: '', sku: '', price: '', unit: 'pcs', stock: 0, lowStock: 5, trackStock: true };
  const tracked = p.trackStock !== false;
  const unitType = p.unit === 'weight' ? 'weight' : 'pcs';
  let weightUnit = p.stock >= 1000 || p.lowStock >= 1000 || !p.stock ? 'kg' : 'g'; // display preference

  function stockFieldsHTML(ut, isTracked) {
    if (!isTracked) return '';
    if (ut === 'weight') {
      const div = weightUnit === 'kg' ? 1000 : 1;
      return `
        <div class="field-row">
          <label class="field"><span>Stock on hand</span><input id="pfStock" type="number" min="0" step="0.001" inputmode="decimal" value="${(p.stock || 0) / div}"></label>
          <label class="field"><span>Low-stock at</span><input id="pfLow" type="number" min="0" step="0.001" inputmode="decimal" value="${(p.lowStock || 0) / div}"></label>
        </div>
        <label class="field"><span>Entered in</span>
          <select id="pfWeightUnit"><option value="kg" ${weightUnit === 'kg' ? 'selected' : ''}>kg</option><option value="g" ${weightUnit === 'g' ? 'selected' : ''}>g</option></select>
        </label>`;
    }
    return `
      <div class="field-row">
        <label class="field"><span>Stock on hand</span><input id="pfStock" type="number" min="0" inputmode="numeric" value="${p.stock}"></label>
        <label class="field"><span>Low-stock alert at</span><input id="pfLow" type="number" min="0" inputmode="numeric" value="${p.lowStock}"></label>
      </div>`;
  }

  openSheet(`
    <h2>${id ? 'Edit product' : 'New product'}</h2>
    <div class="form-card">
      <label class="field"><span>Name</span><input id="pfName" value="${esc(p.name)}" placeholder="e.g. Oak shelf 80 cm"></label>
      <div class="field-row">
        <label class="field"><span>SKU (optional)</span><input id="pfSku" value="${esc(p.sku || '')}" placeholder="OAK-80"></label>
        <label class="field"><span id="pfPriceLabel">${unitType === 'weight' ? 'Price per kg (฿)' : 'Unit price (฿)'}</span><input id="pfPrice" type="number" min="0" step="1" inputmode="numeric" value="${p.price}"></label>
      </div>
      <label class="field"><span>Unit type</span>
        <select id="pfUnitType">
          <option value="pcs" ${unitType === 'pcs' ? 'selected' : ''}>Pieces</option>
          <option value="weight" ${unitType === 'weight' ? 'selected' : ''}>Weight (grams / kilograms)</option>
        </select>
      </label>
      <label class="field"><span>Stock handling</span>
        <select id="pfStockMode">
          <option value="tracked" ${stockMode(p) === 'tracked' ? 'selected' : ''}>Track stock</option>
          <option value="made" ${stockMode(p) === 'made' ? 'selected' : ''}>Made to order — never stocked</option>
          <option value="service" ${stockMode(p) === 'service' ? 'selected' : ''}>Service / fee — e.g. Delivery</option>
        </select>
      </label>
      <div id="pfStockFields">${stockFieldsHTML(unitType, tracked)}</div>
      <button class="btn-filled" id="pfSave">${id ? 'Save changes' : 'Add product'}</button>
      ${id ? '<button class="btn-text danger" id="pfDelete">Delete product</button>' : ''}
    </div>`);

  function redraw() {
    $('#pfStockFields').innerHTML = stockFieldsHTML($('#pfUnitType').value, $('#pfStockMode').value === 'tracked');
    $('#pfPriceLabel').textContent = $('#pfUnitType').value === 'weight' ? 'Price per kg (฿)' : 'Unit price (฿)';
    bindWeightUnitToggle();
  }
  function bindWeightUnitToggle() {
    const sel = $('#pfWeightUnit');
    if (!sel) return;
    sel.onchange = e => {
      const newUnit = e.target.value;
      ['pfStock', 'pfLow'].forEach(id => {
        const el = $('#' + id);
        const grams = weightUnit === 'kg' ? Number(el.value || 0) * 1000 : Number(el.value || 0);
        el.value = newUnit === 'kg' ? grams / 1000 : grams;
      });
      weightUnit = newUnit;
    };
  }
  bindWeightUnitToggle();
  $('#pfUnitType').onchange = redraw;
  $('#pfStockMode').onchange = redraw;

  $('#pfSave').onclick = async () => {
    const name = $('#pfName').value.trim();
    const price = Number($('#pfPrice').value);
    if (!name) return snack('Give the product a name');
    if (!(price >= 0)) return snack('Enter a valid unit price');

    const finalUnitType = $('#pfUnitType').value;
    const mode = $('#pfStockMode').value;
    const trackStock = mode === 'tracked';
    let stock = 0, lowStock = 0;
    if (trackStock) {
      if (finalUnitType === 'weight') {
        const factor = weightUnit === 'kg' ? 1000 : 1;
        stock = Math.max(0, Math.round((Number($('#pfStock').value) || 0) * factor));
        lowStock = Math.max(0, Math.round((Number($('#pfLow').value) || 0) * factor));
      } else {
        stock = Math.max(0, Number($('#pfStock').value) || 0);
        lowStock = Math.max(0, Number($('#pfLow').value) || 0);
      }
    }

    const record = {
      ...(id ? { id } : {}),
      name, sku: $('#pfSku').value.trim(), price, trackStock, stockMode: mode,
      unit: finalUnitType, stock, lowStock,
      isDelivery: p.isDelivery || false
    };
    const savedId = await DB.put('products', record);
    // New stock first goes to orders that were waiting for it (oldest first).
    let allocMsg = '';
    if (record.trackStock && record.stock > 0) {
      const allocations = await DB.allocatePending(id || savedId);
      if (allocations.length) {
        const total = allocations.reduce((s, a) => s + a.qty, 0);
        const orderIds = [...new Set(allocations.map(a => '#' + a.orderId))].join(', ');
        allocMsg = ` — ${total} unit${total === 1 ? '' : 's'} assigned to waiting order${orderIds.includes(',') ? 's' : ''} ${orderIds}`;
      }
    }
    closeSheet(); snack((id ? 'Product saved' : 'Product added') + allocMsg); render();
  };
  const del = $('#pfDelete');
  if (del) del.onclick = async () => {
    await DB.delete('products', id);
    closeSheet(); snack('Product deleted'); render();
  };
}

/* ----- Orders ----- */
function railHTML(order) {
  const idx = STATUSES.indexOf(order.status);
  const last = STATUSES.length - 1;
  return `
    <div class="rail">
      ${STATUSES.map((s, i) => `<div class="rail-seg ${i < idx ? 'is-done' : i === idx ? (idx === last ? 'is-done' : 'is-current') : ''}"></div>`).join('')}
    </div>
    <div class="rail-labels"><span>Production</span><span>Ready</span><span>Completed</span><span>Delivered</span></div>
    <div class="rail-status ${idx === last ? 'is-completed' : ''}">${order.status}</div>
    ${idx < last ? `<button class="advance-btn" data-advance="${order.id}">Mark as “${STATUSES[idx + 1]}”</button>` : ''}`;
}

async function renderOrders() {
  const orders = await DB.getAll('orders');
  const q = state.search.order.toLowerCase();
  let list = orders.filter(o =>
    o.customerName.toLowerCase().includes(q) ||
    String(o.id).includes(q) ||
    o.items.some(i => i.name.toLowerCase().includes(q)));
  if (state.statusFilter !== 'all') list = list.filter(o => o.status === state.statusFilter);
  list.sort((a, b) => b.createdAt - a.createdAt);

  $('#orderList').innerHTML = list.map(o => {
    const waiting = o.items.filter(i => i.pendingQty > 0);
    return `
    <div class="swipe" data-oid="${o.id}">
      ${SWIPE_PANES}
      <div class="card">
      <div class="row">
        <div class="row-main">
          <div class="name">#${o.id} · ${esc(o.customerName)}</div>
          <div class="sub">${esc(o.address)}</div>
          <div class="sub">${o.items.map(i => itemLabel(i)).join(', ')}</div>
          ${waiting.length ? `<span class="badge badge-low"><span class="dot"></span>Awaiting stock: ${waiting.map(i => itemLabel(i, i.pendingQty)).join(', ')}</span>` : ''}
        </div>
        <div class="row-end">
          <div class="big">${fmtMoney(o.total)}</div>
          <div class="sub">${fmtDate(o.createdAt)}</div>
          ${o.discountPct > 0 ? `<div class="sub">${o.discountPct}% discount</div>` : ''}
        </div>
      </div>
      ${railHTML(o)}
      </div>
    </div>`;
  }).join('') || `<div class="empty"><div class="title">No orders found</div><div>${orders.length ? 'Try a different search or status filter.' : 'Create your first order with the button below.'}</div></div>`;

  document.querySelectorAll('#orderList .swipe[data-oid]').forEach(wrap => {
    const o = list.find(x => x.id === Number(wrap.dataset.oid));
    const confirmDelete = () => showConfirm(`Delete order #${o.id} (${o.customerName}, ${fmtMoney(o.total)})? Stock is not restored.`, async () => {
      await DB.delete('orders', o.id);
      snack(`Order #${o.id} deleted`); render();
    });
    attachSwipe(wrap, { onEdit: () => openOrderOptions(o), onDelete: confirmDelete });
    attachLongPress(wrap.querySelector('.card'), () => openOrderOptions(o));
  });

  document.querySelectorAll('[data-advance]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const o = await DB.get('orders', Number(btn.dataset.advance));
      const next = STATUSES[STATUSES.indexOf(o.status) + 1];
      o.status = next; o.statusChangedAt = Date.now();
      await DB.put('orders', o);
      snack(`Order #${o.id} → ${next}`);
      render();
    }));
}

/* ----- Order options (long-press) ----- */
function openOrderOptions(o) {
  const hasWeight = o.items.some(i => i.unitType === 'weight');
  openSheet(`
    <h2>Order #${o.id} · ${esc(o.customerName)}</h2>
    <div class="form-card">
      <button class="btn-tonal" id="ooNumber">Change order number</button>
      ${hasWeight ? '<button class="btn-tonal" id="ooWeights">Adjust sold weights</button>' : ''}
      <button class="btn-text danger" id="ooDelete">Delete order</button>
    </div>`);

  $('#ooNumber').onclick = () => {
    openSheet(`
      <h2>Change order number</h2>
      <div class="form-card">
        <label class="field"><span>New number for order #${o.id}</span>
          <input type="number" id="onNew" min="1" inputmode="numeric" value="${o.id}">
        </label>
        <button class="btn-filled" id="onSave">Save</button>
      </div>`);
    $('#onSave').onclick = async () => {
      const newId = Number($('#onNew').value);
      if (!(newId >= 1)) return snack('Enter a number of 1 or higher');
      if (newId === o.id) return closeSheet();
      try {
        await DB.changeOrderId(o.id, newId);
        closeSheet(); snack(`Order #${o.id} is now #${newId}`); render();
      } catch (err) { snack(err.message); }
    };
  };

  const w = $('#ooWeights');
  if (w) w.onclick = () => {
    const weightItems = o.items
      .map((item, idx) => ({ item, idx }))
      .filter(x => x.item.unitType === 'weight');
    openSheet(`
      <h2>Adjust sold weights</h2>
      <div class="form-card">
        ${weightItems.map(x => `
          <label class="field">
            <span>${esc(x.item.name)} — actual weight (g), was ${fmtGrams(x.item.qty)} at ${fmtMoney(x.item.unitPrice)}/kg</span>
            <input type="number" min="1" inputmode="numeric" data-widx="${x.idx}" value="${x.item.qty}">
          </label>`).join('')}
        <button class="btn-filled" id="owSave">Save weights</button>
      </div>`);
    $('#owSave').onclick = async () => {
      const newQtys = {};
      let bad = false;
      document.querySelectorAll('[data-widx]').forEach(inp => {
        const grams = Number(inp.value);
        if (!(grams > 0)) bad = true;
        newQtys[inp.dataset.widx] = grams;
      });
      if (bad) return snack('Weights must be greater than 0');
      await DB.updateOrderWeights(o.id, newQtys);
      closeSheet(); snack(`Order #${o.id} updated — totals and stock adjusted`); render();
    };
  };

  $('#ooDelete').onclick = () => {
    closeSheet();
    showConfirm(`Delete order #${o.id} (${o.customerName}, ${fmtMoney(o.total)})? Stock is not restored.`, async () => {
      await DB.delete('orders', o.id);
      snack(`Order #${o.id} deleted`); render();
    });
  };
}

/* ----- Order form ----- */
async function openOrderForm() {
  const [products, customers] = await Promise.all([DB.getAll('products'), DB.getAll('customers')]);
  if (!products.length) return snack('Add products in Inventory before creating orders');
  products.sort((a, b) => a.name.localeCompare(b.name));

  const isWeight = p => p.unit === 'weight';
  const newLine = (p = products[0]) => ({
    productId: p.id,
    qty: isWeight(p) ? 1000 : 1,          // grams for weight products, pieces otherwise
    unitPrice: p.price,                   // per kg for weight products, per piece otherwise
    weightBased: isWeight(p)
  });
  let lines = [newLine()];

  const productOptions = sel => products.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${p.trackStock === false ? MODE_TAGS[stockMode(p)] : fmtStock(p) + ' left'})</option>`).join('');
  const customerOptions = customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  openSheet(`
    <h2>New order</h2>
    <div class="form-card">
      <label class="field"><span>Customer</span>
        <select id="ofCustomer"><option value="">＋ New customer</option>${customerOptions}</select>
      </label>
      <div id="ofNewCustomer">
        <div class="field-row">
          <label class="field"><span>Customer name</span><input id="ofName" placeholder="Full name"></label>
          <label class="field"><span>Phone number</span><input id="ofPhone" type="tel" inputmode="tel" placeholder="08x-xxx-xxxx"></label>
        </div>
        <label class="field"><span>Email (optional)</span><input id="ofEmail" type="email" inputmode="email" placeholder="name@example.com"></label>
      </div>
      <label class="field"><span>Delivery address</span><input id="ofAddress" placeholder="Street, city"></label>
      <label class="field"><span>Order date</span><input type="date" id="ofDate"></label>
      <h2 class="section-label" style="margin:8px 0 0">Items</h2>
      <div id="ofLines"></div>
      <button class="btn-tonal" id="ofAddLine">＋ Add item</button>
      <label class="field" style="margin-top:4px"><span>Discount (%)</span>
        <input id="ofDiscount" type="number" min="0" max="100" step="1" inputmode="numeric" value="0" placeholder="0">
      </label>
      <div id="ofTotals"></div>
      <label class="field-checkbox">
        <input type="checkbox" id="ofDeduct" checked>
        <span>Deduct items from stock — uncheck for past orders that were already fulfilled</span>
      </label>
      <button class="btn-filled" id="ofCreate">Create order</button>
    </div>`);

  const linesEl = $('#ofLines');

  function drawLines() {
    linesEl.innerHTML = lines.map((l, i) => l.weightBased ? `
      <div class="line-item" style="margin-bottom:2px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Weight (g)</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>฿ / kg</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="1" inputmode="numeric" value="${l.unitPrice}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>
      <div class="line-hint" style="margin-bottom:10px">= ${fmtMoney(lineTotal(l))} (${fmtGrams(l.qty || 0)} at ${fmtMoney(l.unitPrice || 0)}/kg, rounded down)</div>` : `
      <div class="line-item" style="margin-bottom:10px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Qty</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>Unit price (฿)</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="1" inputmode="numeric" value="${l.unitPrice}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>`).join('');

    linesEl.querySelectorAll('[data-li]').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.li), k = el.dataset.k;
      lines[i][k] = Number(el.value);
      if (k === 'productId') {           // product switched: refill price/qty/type from the product card
        const p = products.find(p => p.id === lines[i].productId);
        lines[i] = newLine(p);
        drawLines();
      } else if (lines[i].weightBased) {
        // live-update the computed line price under the row
        const hint = el.closest('.line-item').nextElementSibling;
        if (hint) hint.textContent = `= ${fmtMoney(lineTotal(lines[i]))} (${fmtGrams(lines[i].qty || 0)} at ${fmtMoney(lines[i].unitPrice || 0)}/kg, rounded down)`;
      }
      updateTotal();
    }));
    linesEl.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
      lines.splice(Number(el.dataset.rm), 1);
      if (!lines.length) lines = [newLine()];
      drawLines(); updateTotal();
    }));
    updateTotal();
  }
  function updateTotal() {
    const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
    const pct = Math.min(100, Math.max(0, Number($('#ofDiscount').value) || 0));
    const discount = Math.ceil(subtotal * pct / 100); // discount rounds UP → total rounds down
    const total = subtotal - discount;
    $('#ofTotals').innerHTML = pct > 0 ? `
      <div class="order-total" style="font-weight:400;font-size:14px;color:var(--md-on-surface-variant)"><span>Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
      <div class="order-total" style="font-weight:400;font-size:14px;color:var(--md-on-surface-variant)"><span>Discount ${pct}%</span><span>−${fmtMoney(discount)}</span></div>
      <div class="order-total"><span>Total</span><span>${fmtMoney(total)}</span></div>` : `
      <div class="order-total"><span>Total</span><span>${fmtMoney(total)}</span></div>`;
  }

  $('#ofAddLine').onclick = () => { lines.push(newLine()); drawLines(); };
  $('#ofDiscount').addEventListener('input', updateTotal);
  // Prefill order date with today (local time)
  $('#ofDate').value = tsToDateInput(Date.now());
  $('#ofCustomer').onchange = async e => {
    const id = Number(e.target.value);
    $('#ofNewCustomer').hidden = !!id;
    if (id) {
      const c = customers.find(c => c.id === id);
      $('#ofAddress').value = c.address || '';
    } else $('#ofAddress').value = '';
  };

  $('#ofCreate').onclick = async () => {
    let customerId = Number($('#ofCustomer').value) || null;
    let customerName;
    const address = $('#ofAddress').value.trim();
    if (!address) return snack('Enter a delivery address');

    if (customerId) {
      customerName = customers.find(c => c.id === customerId).name;
    } else {
      customerName = $('#ofName').value.trim();
      const phone = $('#ofPhone').value.trim();
      if (!customerName) return snack('Enter the customer name');
      if (!phone) return snack('Enter a phone number');
      customerId = await DB.add('customers', {
        name: customerName, phone, email: $('#ofEmail').value.trim(),
        address, createdAt: Date.now()
      });
    }

    const items = lines
      .filter(l => l.qty > 0)
      .map(l => {
        const p = products.find(p => p.id === l.productId);
        return {
          productId: p.id, name: p.name,
          qty: l.qty,                                   // grams for weight items, pieces otherwise
          unitPrice: l.unitPrice,                       // per kg for weight items
          unitType: l.weightBased ? 'weight' : 'pcs',
          lineTotal: lineTotal(l)
        };
      });
    if (!items.length) return snack('Add at least one item');

    // Order date: today keeps the exact current time (so activity ordering
    // stays natural); a backdated order is stored at noon local time.
    const createdAt = dateInputToTs($('#ofDate').value);
    if (!createdAt) return snack('Pick an order date');

    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    const discountPct = Math.min(100, Math.max(0, Number($('#ofDiscount').value) || 0));
    const discount = Math.ceil(subtotal * discountPct / 100);
    const order = {
      customerId, customerName, address, items,
      subtotal, discountPct,
      total: subtotal - discount,
      status: STATUSES[0], createdAt, statusChangedAt: null
    };

    try {
      const deduct = $('#ofDeduct').checked;
      const orderId = await DB.createOrderWithStock(order, deduct);
      closeSheet();
      const waiting = order.items.filter(i => i.pendingQty > 0);
      if (waiting.length) {
        snack(`Order #${orderId} created — awaiting stock: ${waiting.map(i => itemLabel(i, i.pendingQty)).join(', ')}`);
      } else {
        snack(`Order #${orderId} created — in production`);
      }
      render();
    } catch (err) {
      snack(err.message);
    }
  };

  drawLines();
}

/* ----- Customers ----- */
async function renderCustomers() {
  const [customers, orders] = await Promise.all([DB.getAll('customers'), DB.getAll('orders')]);
  const q = state.search.customer.toLowerCase();
  // Spending overview: top 5 customers as horizontal bars (clearer than a
  // pie on a narrow screen), based on all customers, not the search filter.
  const all = customers.map(c => {
    const theirOrders = orders.filter(o => o.customerId === c.id);
    return { ...c, orderCount: theirOrders.length, spent: theirOrders.reduce((s, o) => s + o.total, 0) };
  });
  const top = [...all].sort((a, b) => b.spent - a.spent).filter(c => c.spent > 0).slice(0, 5);
  const grand = all.reduce((s, c) => s + c.spent, 0);
  $('#customerChart').innerHTML = top.length >= 2 ? `
    <div class="card" style="margin-bottom:12px">
      <h2 class="card-title" style="margin-bottom:4px">Top customers</h2>
      ${top.map(c => `
        <div class="tc-row">
          <div class="tc-name">${esc(c.name)}</div>
          <div class="tc-track"><div class="tc-fill" style="width:${Math.max(4, Math.round(c.spent / top[0].spent * 100))}%"></div></div>
          <div class="tc-amount">${fmtMoney(c.spent)}</div>
        </div>`).join('')}
      <div class="sub" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:6px">${Math.round(top.reduce((s, c) => s + c.spent, 0) / grand * 100)}% of all revenue comes from these ${top.length}</div>
    </div>` : '';

  const list = all
    .filter(c => c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q) || (c.phone || '').includes(q))
    .sort((a, b) => b.spent - a.spent);

  $('#customerList').innerHTML = list.map(c => `
    <div class="swipe" data-cid="${c.id}">
      ${SWIPE_PANES}
      <div class="card is-tappable" role="button" tabindex="0">
        <div class="row">
          <div class="row-main">
            <div class="name">${esc(c.name)}</div>
            <div class="sub">${esc(c.phone || 'No phone on file')}</div>
          </div>
          <div class="row-end">
            <div class="big">${fmtMoney(c.spent)}</div>
            <div class="sub">${c.orderCount} order${c.orderCount === 1 ? '' : 's'}</div>
          </div>
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><div class="title">No customers found</div><div>${customers.length ? 'Try a different search.' : 'Customers are added here or when you create an order.'}</div></div>`;

  document.querySelectorAll('#customerList .swipe[data-cid]').forEach(wrap => {
    const c = list.find(x => x.id === Number(wrap.dataset.cid));
    const card = wrap.querySelector('.card');
    card.addEventListener('click', () => openCustomerDetail(c.id));
    const confirmDelete = () => showConfirm(`Delete customer “${c.name}”? Their past orders stay in the order list.`, async () => {
      await DB.delete('customers', c.id);
      snack('Customer deleted'); render();
    });
    attachSwipe(wrap, { onEdit: () => openCustomerForm(c.id), onDelete: confirmDelete });
    attachLongPress(card, () => confirmDelete());
  });
}

async function openCustomerDetail(id) {
  const [c, orders] = await Promise.all([DB.get('customers', id), DB.getAll('orders')]);
  const theirs = orders.filter(o => o.customerId === id).sort((a, b) => b.createdAt - a.createdAt);
  const spent = theirs.reduce((s, o) => s + o.total, 0);
  openSheet(`
    <h2>${esc(c.name)}</h2>
    <div class="sub" style="color:var(--md-on-surface-variant);margin:-8px 0 2px">${esc(c.phone || 'No phone on file')}${c.email ? ' · ' + esc(c.email) : ''}</div>
    <div class="sub" style="color:var(--md-on-surface-variant);margin:0 0 16px">${esc(c.address || 'No address on file')}</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Total spent</div><div class="value" style="font-size:24px">${fmtMoney(spent)}</div></div>
      <div class="stat-card"><div class="label">Orders</div><div class="value" style="font-size:24px">${theirs.length}</div></div>
    </div>
    <h2 class="section-label">Order history</h2>
    <div class="card-list">
      ${theirs.map(o => `
        <div class="card">
          <div class="row">
            <div class="row-main">
              <div class="name">#${o.id} · ${fmtDate(o.createdAt)}</div>
              <div class="sub">${o.items.map(i => itemLabel(i)).join(', ')}</div>
              <div class="sub" style="font-weight:600;color:var(--md-primary)">${o.status}</div>
            </div>
            <div class="row-end"><div class="big">${fmtMoney(o.total)}</div>${o.discountPct > 0 ? `<div class="sub">${o.discountPct}% discount</div>` : ''}</div>
          </div>
        </div>`).join('') || '<div class="empty">No orders yet.</div>'}
    </div>
    <button class="btn-text" id="cdEdit" style="margin-top:12px">Edit customer</button>`);

  $('#cdEdit').onclick = () => openCustomerForm(id);
}

async function openCustomerForm(id) {
  const c = id ? await DB.get('customers', id) : { name: '', phone: '', email: '', address: '' };
  openSheet(`
    <h2>${id ? 'Edit customer' : 'New customer'}</h2>
    <div class="form-card">
      <label class="field"><span>Name</span><input id="cfName" value="${esc(c.name)}"></label>
      <label class="field"><span>Phone number</span><input id="cfPhone" type="tel" inputmode="tel" value="${esc(c.phone || '')}" placeholder="08x-xxx-xxxx"></label>
      <label class="field"><span>Email (optional)</span><input id="cfEmail" type="email" inputmode="email" value="${esc(c.email || '')}" placeholder="name@example.com"></label>
      <label class="field"><span>Address</span><input id="cfAddress" value="${esc(c.address || '')}"></label>
      <button class="btn-filled" id="cfSave">${id ? 'Save changes' : 'Add customer'}</button>
    </div>`);
  $('#cfSave').onclick = async () => {
    const name = $('#cfName').value.trim();
    const phone = $('#cfPhone').value.trim();
    if (!name) return snack('Enter the customer name');
    if (!phone) return snack('Enter a phone number');
    await DB.put('customers', {
      ...(id ? { id } : {}), name, phone,
      email: $('#cfEmail').value.trim(),
      address: $('#cfAddress').value.trim(),
      createdAt: c.createdAt || Date.now()
    });
    closeSheet(); snack(id ? 'Customer saved' : 'Customer added'); render();
  };
}

/* ---------------- Search & filter wiring ---------------- */
$('#productSearch').addEventListener('input', e => { state.search.product = e.target.value; renderProducts(); });
$('#orderSearch').addEventListener('input', e => { state.search.order = e.target.value; renderOrders(); });
$('#customerSearch').addEventListener('input', e => { state.search.customer = e.target.value; renderCustomers(); });

function syncStockChips() {
  document.querySelectorAll('[data-stockfilter]').forEach(c =>
    c.classList.toggle('is-selected', c.dataset.stockfilter === state.stockFilter));
}
document.querySelectorAll('[data-stockfilter]').forEach(chip =>
  chip.addEventListener('click', () => { state.stockFilter = chip.dataset.stockfilter; syncStockChips(); renderProducts(); }));

document.querySelectorAll('[data-status]').forEach(chip =>
  chip.addEventListener('click', () => {
    state.statusFilter = chip.dataset.status;
    document.querySelectorAll('[data-status]').forEach(c => c.classList.toggle('is-selected', c === chip));
    renderOrders();
  }));

document.querySelectorAll('[data-invtab]').forEach(tab =>
  tab.addEventListener('click', () => {
    state.invTab = tab.dataset.invtab;
    document.querySelectorAll('[data-invtab]').forEach(t => t.classList.toggle('is-active', t === tab));
    $('#inv-stock').hidden = state.invTab !== 'stock';
    $('#inv-purchases').hidden = state.invTab !== 'purchases';
    $('#fab').hidden = state.invTab === 'purchases';
  }));

/* ---------------- Sample data ---------------- */
async function seedSampleData() {
  const products = [
    { name: 'Oak shelf 80 cm', sku: 'OAK-80', price: 89, stock: 14, lowStock: 5 },
    { name: 'Walnut side table', sku: 'WAL-ST', price: 210, stock: 3, lowStock: 4 },
    { name: 'Pine bench 120 cm', sku: 'PIN-120', price: 145, stock: 0, lowStock: 3 },
    { name: 'Coat rack, steel', sku: 'CR-STL', price: 55, stock: 22, lowStock: 6 }
  ];
  const pids = [];
  for (const p of products) pids.push(await DB.add('products', p));

  const c1 = await DB.add('customers', { name: 'Maren Holt', phone: '081-234-5678', email: 'maren.holt@example.com', address: '14 Birch Lane, Riverton', createdAt: Date.now() - 86400000 * 20 });
  const c2 = await DB.add('customers', { name: 'Tobias Lind', phone: '089-876-5432', email: '', address: '3 Harbor St, Eastport', createdAt: Date.now() - 86400000 * 9 });

  const day = 86400000;
  await DB.add('orders', {
    customerId: c1, customerName: 'Maren Holt', address: '14 Birch Lane, Riverton',
    items: [{ productId: pids[0], name: 'Oak shelf 80 cm', qty: 2, unitPrice: 89 }],
    total: 178, status: 'Completed', createdAt: Date.now() - day * 12, statusChangedAt: Date.now() - day * 8
  });
  await DB.add('orders', {
    customerId: c2, customerName: 'Tobias Lind', address: '3 Harbor St, Eastport',
    items: [{ productId: pids[1], name: 'Walnut side table', qty: 1, unitPrice: 210 },
            { productId: pids[3], name: 'Coat rack, steel', qty: 2, unitPrice: 55 }],
    total: 320, status: 'Ready for shipping', createdAt: Date.now() - day * 2, statusChangedAt: Date.now() - day
  });
  await DB.add('orders', {
    customerId: c1, customerName: 'Maren Holt', address: '14 Birch Lane, Riverton',
    items: [{ productId: pids[3], name: 'Coat rack, steel', qty: 1, unitPrice: 55 }],
    total: 55, status: 'In production', createdAt: Date.now() - 3600000, statusChangedAt: null
  });
  await DB.add('purchases', { description: 'Oak boards, 10 units', amount: 340, supplier: 'Northline Timber', receivedAt: Date.now() - day * 3 });

  snack('Sample data loaded');
  render();
}

/* ---------------- Bootstrap: default Delivery item ---------------- */
// Runs once ever (tracked via localStorage, not IndexedDB, since it's just
// an app-setup flag). Safe for both brand-new and already-in-use databases.
async function ensureDeliveryProduct() {
  if (localStorage.getItem('erp_delivery_seeded')) return;
  const products = await DB.getAll('products');
  if (!products.some(p => p.isDelivery)) {
    await DB.add('products', {
      name: 'Delivery', sku: 'DELIVERY', price: 99,
      stock: 0, lowStock: 0, trackStock: false, isDelivery: true
    });
  }
  localStorage.setItem('erp_delivery_seeded', '1');
}

/* ---------------- PWA: service worker ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

/* ---------------- Boot ---------------- */
ensureDeliveryProduct().then(() => switchView('dashboard'));
