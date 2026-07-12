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
    }
  };

  return api;
})();
