/* ============================================================
   app.js — Workbench ERP
   Views: Dashboard · Inventory (Stock / Incoming purchases)
          Orders · Customers
   ============================================================ */

const STATUSES = ['In production', 'Ready for shipping', 'Completed'];
const fmtMoney = n => '฿' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
const $ = sel => document.querySelector(sel);

const state = {
  view: 'dashboard',
  invTab: 'stock',
  stockFilter: 'all',
  statusFilter: 'all',
  search: { product: '', order: '', customer: '' }
};

/* ---------------- Navigation ---------------- */
const VIEW_TITLES = { dashboard: 'Dashboard', inventory: 'Inventory', orders: 'Orders', customers: 'Customers' };
const FAB_CONFIG = {
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
  $('#sheet').hidden = false;
  $('#scrim').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeSheet);

let snackTimer = null;
function snack(msg) {
  const el = $('#snackbar');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.hidden = true; }, 2800);
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
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  // Payment is taken before shipping, so every order placed counts as revenue.
  const monthOrders = orders.filter(o => o.createdAt >= monthStart);
  const revenue = monthOrders.reduce((s, o) => s + o.total, 0);
  const monthPurchases = purchases.filter(pu => pu.receivedAt >= monthStart);
  const costs = monthPurchases.reduce((s, pu) => s + (pu.amount || 0), 0);

  const inProduction = orders.filter(o => o.status === STATUSES[0]).length;
  const readyToShip = orders.filter(o => o.status === STATUSES[1]).length;
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
    <div class="stat-grid">
      <div class="stat-card hero">
        <div class="label">Revenue · ${now.toLocaleDateString(undefined, { month: 'long' })}</div>
        <div class="value">${fmtMoney(revenue)}</div>
        <div class="hint">${monthOrders.length} order${monthOrders.length === 1 ? '' : 's'} this month</div>
      </div>
      <div class="stat-card">
        <div class="label">In production</div>
        <div class="value">${inProduction}</div>
      </div>
      <div class="stat-card">
        <div class="label">Ready for shipping</div>
        <div class="value">${readyToShip}</div>
      </div>
      <div class="stat-card">
        <div class="label">Costs · ${now.toLocaleDateString(undefined, { month: 'long' })}</div>
        <div class="value">${fmtMoney(costs)}</div>
        <div class="hint">${monthPurchases.length} purchase${monthPurchases.length === 1 ? '' : 's'} logged</div>
      </div>
      ${(lowStock + outOfStock) ? `
      <div class="stat-card warn" style="grid-column:1/-1" id="lowStockCard" role="button" tabindex="0">
        <div class="label">Stock alerts</div>
        <div class="value">${lowStock + outOfStock}</div>
        <div class="hint">${lowStock} low · ${outOfStock} out of stock — tap to review</div>
      </div>` : ''}
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
}

/* ----- Inventory: products ----- */
// Weight-type products store stock in grams internally; show it humanized.
function fmtStock(p) {
  if (p.unit === 'weight') {
    return p.stock >= 1000
      ? (p.stock / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' kg'
      : p.stock + ' g';
  }
  return String(p.stock);
}

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
    <div class="card is-tappable" data-pid="${p.id}" role="button" tabindex="0">
      <div class="row">
        <div class="row-main">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${esc(p.sku || 'No SKU')} · ${fmtMoney(p.price)} / ${p.unit === 'weight' ? 'g' : 'unit'}</div>
          ${stockBadge(p)}
        </div>
        <div class="row-end">
          ${p.trackStock === false
            ? '<div class="big">—</div><div class="sub">service</div>'
            : `<div class="big">${fmtStock(p)}</div><div class="sub">in stock</div>`}
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><div class="title">No products found</div><div>${products.length ? 'Try a different search or filter.' : 'Add your first product with the button below.'}</div></div>`;

  document.querySelectorAll('#productList [data-pid]').forEach(el =>
    el.addEventListener('click', () => openProductForm(Number(el.dataset.pid))));
}

/* ----- Inventory: incoming purchases (a pure expense log — no stock effect) ----- */
async function renderPurchases() {
  const purchases = await DB.getAll('purchases');
  purchases.sort((a, b) => b.receivedAt - a.receivedAt);
  $('#purchaseList').innerHTML = purchases.slice(0, 30).map(p => `
    <div class="card">
      <div class="row">
        <div class="row-main">
          <div class="name">${esc(p.description)}</div>
          <div class="sub">${p.supplier ? esc(p.supplier) + ' · ' : ''}${fmtDate(p.receivedAt)}</div>
        </div>
        <div class="row-end"><div class="big">${fmtMoney(p.amount)}</div></div>
      </div>
    </div>`).join('') || '<div class="empty"><div class="title">No purchases yet</div><div>Money spent on stock or materials will appear here.</div></div>';
}

$('#poReceive').addEventListener('click', async () => {
  const description = $('#poDescription').value.trim();
  const amount = Number($('#poAmount').value);
  if (!description) return snack('Enter what you bought');
  if (!(amount > 0)) return snack('Enter an amount greater than 0');

  await DB.add('purchases', {
    description, amount,
    supplier: $('#poSupplier').value.trim(),
    receivedAt: Date.now()
  });
  $('#poDescription').value = ''; $('#poAmount').value = ''; $('#poSupplier').value = '';
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
        <label class="field"><span>Unit price (฿)</span><input id="pfPrice" type="number" min="0" step="1" inputmode="numeric" value="${p.price}"></label>
      </div>
      <label class="field"><span>Unit type</span>
        <select id="pfUnitType">
          <option value="pcs" ${unitType === 'pcs' ? 'selected' : ''}>Pieces</option>
          <option value="weight" ${unitType === 'weight' ? 'selected' : ''}>Weight (grams / kilograms)</option>
        </select>
      </label>
      <label class="field-checkbox">
        <input type="checkbox" id="pfTrackStock" ${tracked ? 'checked' : ''}>
        <span>Track stock for this item — uncheck for services like Delivery</span>
      </label>
      <div id="pfStockFields">${stockFieldsHTML(unitType, tracked)}</div>
      <button class="btn-filled" id="pfSave">${id ? 'Save changes' : 'Add product'}</button>
      ${id ? '<button class="btn-text danger" id="pfDelete">Delete product</button>' : ''}
    </div>`);

  function redraw() {
    $('#pfStockFields').innerHTML = stockFieldsHTML($('#pfUnitType').value, $('#pfTrackStock').checked);
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
  $('#pfTrackStock').onchange = redraw;

  $('#pfSave').onclick = async () => {
    const name = $('#pfName').value.trim();
    const price = Number($('#pfPrice').value);
    if (!name) return snack('Give the product a name');
    if (!(price >= 0)) return snack('Enter a valid unit price');

    const finalUnitType = $('#pfUnitType').value;
    const trackStock = $('#pfTrackStock').checked;
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
      name, sku: $('#pfSku').value.trim(), price, trackStock,
      unit: finalUnitType, stock, lowStock,
      isDelivery: p.isDelivery || false
    };
    await DB.put('products', record);
    closeSheet(); snack(id ? 'Product saved' : 'Product added'); render();
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
  return `
    <div class="rail">
      ${STATUSES.map((s, i) => `<div class="rail-seg ${i < idx ? 'is-done' : i === idx ? (idx === 2 ? 'is-done' : 'is-current') : ''}"></div>`).join('')}
    </div>
    <div class="rail-labels"><span>Production</span><span>Ready</span><span>Shipped</span></div>
    <div class="rail-status ${idx === 2 ? 'is-completed' : ''}">${order.status}</div>
    ${idx < 2 ? `<button class="advance-btn" data-advance="${order.id}">Mark as “${STATUSES[idx + 1]}”</button>` : ''}`;
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

  $('#orderList').innerHTML = list.map(o => `
    <div class="card">
      <div class="row">
        <div class="row-main">
          <div class="name">#${o.id} · ${esc(o.customerName)}</div>
          <div class="sub">${esc(o.address)}</div>
          <div class="sub">${o.items.map(i => `${i.qty} × ${esc(i.name)}`).join(', ')}</div>
        </div>
        <div class="row-end">
          <div class="big">${fmtMoney(o.total)}</div>
          <div class="sub">${fmtDate(o.createdAt)}</div>
        </div>
      </div>
      ${railHTML(o)}
    </div>`).join('') || `<div class="empty"><div class="title">No orders found</div><div>${orders.length ? 'Try a different search or status filter.' : 'Create your first order with the button below.'}</div></div>`;

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

/* ----- Order form ----- */
async function openOrderForm() {
  const [products, customers] = await Promise.all([DB.getAll('products'), DB.getAll('customers')]);
  if (!products.length) return snack('Add products in Inventory before creating orders');
  products.sort((a, b) => a.name.localeCompare(b.name));

  let lines = [{ productId: products[0].id, qty: 1, unitPrice: products[0].price }];

  const productOptions = sel => products.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${p.stock} left)</option>`).join('');
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
      <h2 class="section-label" style="margin:8px 0 0">Items</h2>
      <div id="ofLines"></div>
      <button class="btn-tonal" id="ofAddLine">＋ Add item</button>
      <div class="order-total"><span>Total</span><span id="ofTotal">$0.00</span></div>
      <button class="btn-filled" id="ofCreate">Create order</button>
    </div>`);

  const linesEl = $('#ofLines');

  function drawLines() {
    linesEl.innerHTML = lines.map((l, i) => `
      <div class="line-item" style="margin-bottom:10px">
        <label class="field"><span>Product</span><select data-li="${i}" data-k="productId">${productOptions(l.productId)}</select></label>
        <label class="field"><span>Qty</span><input data-li="${i}" data-k="qty" type="number" min="1" inputmode="numeric" value="${l.qty}"></label>
        <label class="field"><span>Unit price (฿)</span><input data-li="${i}" data-k="unitPrice" type="number" min="0" step="1" inputmode="numeric" value="${l.unitPrice}"></label>
        <button class="remove" data-rm="${i}" title="Remove item">✕</button>
      </div>`).join('');

    linesEl.querySelectorAll('[data-li]').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.li), k = el.dataset.k;
      lines[i][k] = Number(el.value);
      if (k === 'productId') {           // refill price from the product card
        const p = products.find(p => p.id === lines[i].productId);
        lines[i].unitPrice = p.price;
        drawLines();
      }
      updateTotal();
    }));
    linesEl.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
      lines.splice(Number(el.dataset.rm), 1);
      if (!lines.length) lines = [{ productId: products[0].id, qty: 1, unitPrice: products[0].price }];
      drawLines(); updateTotal();
    }));
    updateTotal();
  }
  function updateTotal() {
    const t = lines.reduce((s, l) => s + (l.qty || 0) * (l.unitPrice || 0), 0);
    $('#ofTotal').textContent = fmtMoney(t);
  }

  $('#ofAddLine').onclick = () => { lines.push({ productId: products[0].id, qty: 1, unitPrice: products[0].price }); drawLines(); };
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
        return { productId: p.id, name: p.name, qty: l.qty, unitPrice: l.unitPrice };
      });
    if (!items.length) return snack('Add at least one item');

    const order = {
      customerId, customerName, address, items,
      total: items.reduce((s, i) => s + i.qty * i.unitPrice, 0),
      status: STATUSES[0], createdAt: Date.now(), statusChangedAt: null
    };

    try {
      const orderId = await DB.createOrderWithStock(order);
      closeSheet(); snack(`Order #${orderId} created — in production`);
      render();
    } catch (err) {
      snack(err.message); // e.g. "Not enough stock for Oak shelf"
    }
  };

  drawLines();
}

/* ----- Customers ----- */
async function renderCustomers() {
  const [customers, orders] = await Promise.all([DB.getAll('customers'), DB.getAll('orders')]);
  const q = state.search.customer.toLowerCase();
  const list = customers
    .filter(c => c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q) || (c.phone || '').includes(q))
    .map(c => {
      const theirOrders = orders.filter(o => o.customerId === c.id);
      return { ...c, orderCount: theirOrders.length, spent: theirOrders.reduce((s, o) => s + o.total, 0) };
    })
    .sort((a, b) => b.spent - a.spent);

  $('#customerList').innerHTML = list.map(c => `
    <div class="card is-tappable" data-cid="${c.id}" role="button" tabindex="0">
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
    </div>`).join('') || `<div class="empty"><div class="title">No customers found</div><div>${customers.length ? 'Try a different search.' : 'Customers are added here or when you create an order.'}</div></div>`;

  document.querySelectorAll('#customerList [data-cid]').forEach(el =>
    el.addEventListener('click', () => openCustomerDetail(Number(el.dataset.cid))));
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
              <div class="sub">${o.items.map(i => `${i.qty} × ${esc(i.name)}`).join(', ')}</div>
              <div class="sub" style="font-weight:600;color:var(--md-primary)">${o.status}</div>
            </div>
            <div class="row-end"><div class="big">${fmtMoney(o.total)}</div></div>
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
