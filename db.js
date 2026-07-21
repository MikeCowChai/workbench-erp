/* ============================================================
   db.js — IndexedDB data layer (no dependencies, fully local)
   Stores: products, customers, orders, purchases
   ============================================================ */
const DB = (() => {
  const NAME = 'workbench-erp';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          const s = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
          s.createIndex('name', 'name');
        }
        if (!db.objectStoreNames.contains('customers')) {
          const s = db.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
          s.createIndex('name', 'name');
        }
        if (!db.objectStoreNames.contains('orders')) {
          const s = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
          s.createIndex('customerId', 'customerId');
          s.createIndex('status', 'status');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('purchases')) {
          const s = db.createObjectStore('purchases', { keyPath: 'id', autoIncrement: true });
          s.createIndex('productId', 'productId');
          s.createIndex('receivedAt', 'receivedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store), t);
      t.oncomplete = () => resolve(result && result._val !== undefined ? result._val : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    }));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const api = {
    async getAll(store) {
      const db = await open();
      return reqToPromise(db.transaction(store).objectStore(store).getAll());
    },
    async get(store, id) {
      const db = await open();
      return reqToPromise(db.transaction(store).objectStore(store).get(id));
    },
    async add(store, value) {
      const db = await open();
      return reqToPromise(db.transaction(store, 'readwrite').objectStore(store).add(value));
    },
    async put(store, value) {
      const db = await open();
      return reqToPromise(db.transaction(store, 'readwrite').objectStore(store).put(value));
    },
    async delete(store, id) {
      const db = await open();
      return reqToPromise(db.transaction(store, 'readwrite').objectStore(store).delete(id));
    },

    /* Atomic: create an order and reserve stock in ONE transaction.
       - deduct=false: past orders that were already fulfilled — stock untouched.
       - deduct=true: take what's available; any shortfall is stored on the
         item as pendingQty ("awaiting stock") instead of failing the order. */
    async createOrderWithStock(order, deduct = true) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['orders', 'products'], 'readwrite');
        const products = t.objectStore('products');
        let orderId = null;

        const finish = () => {
          const addReq = t.objectStore('orders').add(order);
          addReq.onsuccess = () => { orderId = addReq.result; };
        };

        if (!deduct) {
          order.items.forEach(i => { i.pendingQty = 0; });
          order.skipStock = true;
          finish();
        } else {
          let pending = order.items.length;
          order.items.forEach(item => {
            const getReq = products.get(item.productId);
            getReq.onsuccess = () => {
              const p = getReq.result;
              if (!p) {
                t.abort();
                reject(new Error(`Product not found: ${item.name}`));
                return;
              }
              if (p.trackStock === false) {
                item.pendingQty = 0; // services (Delivery) never wait for stock
              } else {
                const take = Math.min(p.stock, item.qty);
                p.stock -= take;
                item.pendingQty = item.qty - take;
                products.put(p);
              }
              if (--pending === 0) finish();
            };
          });
        }

        t.oncomplete = () => resolve(orderId);
        t.onerror = () => reject(t.error);
      });
    },

    /* Atomic: after a product's stock is raised, hand the new stock to
       orders still awaiting it (oldest order first). Returns what was
       allocated so the UI can report it. */
    async allocatePending(productId) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['orders', 'products'], 'readwrite');
        const pStore = t.objectStore('products');
        const oStore = t.objectStore('orders');
        const allocations = [];

        pStore.get(productId).onsuccess = e => {
          const p = e.target.result;
          if (!p || p.trackStock === false || p.stock <= 0) return;
          oStore.getAll().onsuccess = ev => {
            const waiting = ev.target.result
              .filter(o => o.items.some(i => i.productId === productId && i.pendingQty > 0))
              .sort((a, b) => a.createdAt - b.createdAt);
            for (const o of waiting) {
              let changed = false;
              for (const i of o.items) {
                if (i.productId !== productId || !(i.pendingQty > 0)) continue;
                const take = Math.min(p.stock, i.pendingQty);
                if (take > 0) {
                  p.stock -= take;
                  i.pendingQty -= take;
                  changed = true;
                  allocations.push({ orderId: o.id, name: i.name, qty: take });
                }
              }
              if (changed) oStore.put(o);
              if (p.stock === 0) break;
            }
            pStore.put(p);
          };
        };

        t.oncomplete = () => resolve(allocations);
        t.onerror = () => reject(t.error);
      });
    },

    /* Purchases are a pure expense log — they record money spent, not stock.
       No cross-store transaction needed since nothing else is touched. */
    async receivePurchase(purchase) {
      return api.add('purchases', purchase);
    },

    /* Full backup: every store in one JSON-able object. */
    async exportAll() {
      const [products, customers, orders, purchases] = await Promise.all([
        api.getAll('products'), api.getAll('customers'),
        api.getAll('orders'), api.getAll('purchases')
      ]);
      return { app: 'buddyboard', version: 1, exportedAt: Date.now(), products, customers, orders, purchases };
    },

    /* Restore a backup: atomically REPLACES all data in every store. */
    async importAll(data) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const stores = ['products', 'customers', 'orders', 'purchases'];
        const t = db.transaction(stores, 'readwrite');
        stores.forEach(name => {
          const s = t.objectStore(name);
          s.clear();
          (data[name] || []).forEach(r => s.put(r));
        });
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },

    /* Atomic: give an order a different number. Fails if the number is taken. */
    async changeOrderId(oldId, newId) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('orders', 'readwrite');
        const s = t.objectStore('orders');
        s.get(newId).onsuccess = e => {
          if (e.target.result) { t.abort(); reject(new Error(`Order #${newId} already exists`)); return; }
          s.get(oldId).onsuccess = e2 => {
            const o = e2.target.result;
            if (!o) { t.abort(); reject(new Error('Order not found')); return; }
            o.id = newId;
            s.add(o);
            s.delete(oldId);
          };
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },

    /* Atomic: update the actual sold grams of weight items on an order.
       newQtys: { itemIndex: grams }. Recomputes line and order totals and
       moves the stock difference for tracked products (unless the order
       skipped stock). */
    async updateOrderWeights(orderId, newQtys) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['orders', 'products'], 'readwrite');
        const oStore = t.objectStore('orders');
        const pStore = t.objectStore('products');
        oStore.get(orderId).onsuccess = e => {
          const o = e.target.result;
          if (!o) { t.abort(); reject(new Error('Order not found')); return; }
          const deltas = new Map(); // productId -> grams delta
          Object.entries(newQtys).forEach(([idx, grams]) => {
            const item = o.items[Number(idx)];
            if (!item || item.unitType !== 'weight' || !(grams > 0)) return;
            const delta = grams - item.qty;
            if (delta !== 0 && !o.skipStock) {
              deltas.set(item.productId, (deltas.get(item.productId) || 0) + delta);
            }
            item.qty = grams;
            item.lineTotal = Math.floor(grams / 1000 * item.unitPrice);
          });
          const subtotal = o.items.reduce((s, i) => s + (i.lineTotal !== undefined ? i.lineTotal : i.qty * i.unitPrice), 0);
          o.subtotal = subtotal;
          const pct = o.discountPct || 0;
          o.total = subtotal - Math.ceil(subtotal * pct / 100);
          oStore.put(o);
          deltas.forEach((delta, productId) => {
            pStore.get(productId).onsuccess = ev => {
              const p = ev.target.result;
              if (!p || p.trackStock === false) return;
              p.stock = Math.max(0, p.stock - delta);
              pStore.put(p);
            };
          });
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    }
  };

  return api;
})();
