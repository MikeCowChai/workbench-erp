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

    /* Atomic: create an order and decrement stock in ONE transaction,
       so a crash can never leave stock and orders out of sync. */
    async createOrderWithStock(order) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['orders', 'products'], 'readwrite');
        const products = t.objectStore('products');
        let orderId = null;

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
            // Service items (e.g. Delivery) carry no stock — skip the check entirely.
            if (p.trackStock !== false) {
              if (p.stock < item.qty) {
                t.abort();
                reject(new Error(`Not enough stock for ${item.name}`));
                return;
              }
              p.stock -= item.qty;
              products.put(p);
            }
            if (--pending === 0) {
              const addReq = t.objectStore('orders').add(order);
              addReq.onsuccess = () => { orderId = addReq.result; };
            }
          };
        });

        t.oncomplete = () => resolve(orderId);
        t.onerror = () => reject(t.error);
      });
    },

    /* Atomic: record a purchase and increment the product's stock. */
    async receivePurchase(purchase) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['purchases', 'products'], 'readwrite');
        const products = t.objectStore('products');
        const getReq = products.get(purchase.productId);
        getReq.onsuccess = () => {
          const p = getReq.result;
          if (!p) { t.abort(); reject(new Error('Product not found')); return; }
          if (p.trackStock === false) { t.abort(); reject(new Error('This item has no stock to receive')); return; }
          p.stock += purchase.qty;
          products.put(p);
          t.objectStore('purchases').add(purchase);
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    }
  };

  return api;
})();
