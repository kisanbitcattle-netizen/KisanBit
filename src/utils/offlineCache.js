// src/utils/offlineCache.js
//
// Lightweight IndexedDB wrapper for offline-first caching of map data
// (cattle, fields, likes). No external library — plain indexedDB API.
//
// Pattern used by FullMapModal:
//   1. On load, read whatever's cached and render it immediately
//      (instant open, works with zero network).
//   2. In the background, ask Supabase for only rows changed since the
//      last successful sync (`updated_at >= lastSync`), merge those into
//      the cached set, re-render, and save the merged set back to cache.
//   3. If the network call fails (offline), just keep showing the cache -
//      no error, no blocking.

const DB_NAME = 'kisanbit_cache';
// v3: added 'fieldsPanel', 'cropsMarketplacePanel', 'fieldOwnerSummary'.
// The first two were already being called by FieldInfoPanel.jsx but were
// never actually registered here - every getAll() on them silently
// returned [] and every putAll() silently no-op'd (both swallow errors
// on purpose so a cache failure can't break the app), so that panel's
// "offline cache" never actually cached anything. fieldOwnerSummary is
// new, for FieldDetailModal.jsx's per-field owner/rating summary -
// keyed by field_id, but stored with an `id` field set to that same
// field_id so it fits this file's generic `keyPath: 'id'` scheme below
// without needing a per-store keyPath.
//
// v4: split the single shared 'cattlePanel' store into 'cattlePanelFarmer'
// and 'cattlePanelBuyer'. CONFIRMED LIVE (IndexedDB inspection, this
// session): 'cattlePanel' was written to by BOTH CattleInfoPanel.jsx view
// modes - farmer view (query on `cattle`, owner-scoped) AND buyer/
// marketplace view (query on `cattle_public_view`, correctly NOT owner-
// scoped, since a marketplace must show every farmer's listings). Because
// both modes shared one object store keyed only by cattle `id`, buyer-
// view rows (other farmers' listed cattle) landed in the same store the
// farmer view cache-paints from on mount, filtered only by `!is_archived`
// - never by owner. mergeById() only adds/updates by id and can't remove
// rows a scoped delta doesn't return, so once a foreign row landed in
// 'cattlePanel' it persisted across every future sync. Confirmed live:
// two rows ('Hyd', 'ff') in a farmer's own 'cattlePanel' store were
// missing every farmer-only column (is_listed_for_sale, collar_id,
// local_image_path) - i.e. buyer-shaped rows that don't belong to that
// farmer, sitting in their own "My Cattle" cache. Old 'cattlePanel'
// entries are left in the STORES list below (harmless, unused) purely so
// existing devices don't hit an error opening a DB that already has that
// store from v3 - openDB() only ever creates missing stores, it never
// deletes existing ones. The two new stores start empty for every device
// on upgrade, so this is a clean cut rather than something needing a
// migration/prune step.
const DB_VERSION = 4;
const STORES = [
  'cattle',
  'cattlePanel', // deprecated as of v4 - kept only so old DBs don't error; no longer read or written
  'cattlePanelFarmer',
  'cattlePanelBuyer',
  'fields',
  'likes',
  'meta',
  'fieldsPanel',
  'cropsMarketplacePanel',
  'fieldOwnerSummary',
];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      STORES.forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: storeName === 'meta' ? 'key' : 'id' });
        }
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(storeName) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function putAll(storeName, records) {
  if (!records || records.length === 0) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      records.forEach((r) => store.put(r));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Offline cache is best-effort - never let a cache-write failure
    // break the app.
  }
}

async function getMeta(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function setMeta(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
}

// Purges a single record from a store by id - the missing piece for hard
// deletes. mergeById() below only ever ADDS/UPDATES rows from a delta
// fetch; it has no way to learn that a row disappeared, since a deleted
// row simply isn't returned by any future query at all (there's nothing
// to diff against - it's just absent). That meant a hard-deleted cattle
// (e.g. CattleCard's "Delete Permanently") stayed in the local cache
// forever, on the device that did the delete, until a full app-data/
// storage wipe. Call this right after a successful delete so that
// device's own cache reflects it immediately, instead of waiting on a
// sync mechanism that structurally can't detect deletions.
// NOTE: this only fixes the deleting device's own cache. A DIFFERENT
// device that already cached this row before the delete happened has no
// way to find out via delta sync either - that's a deeper gap (would
// need either periodic full non-delta resyncs, or server-side deleted-ID
// tracking) and isn't addressed by this function.
async function remove(storeName, id) {
  if (id == null) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort, same as putAll/getAll above
  }
}

// Merge freshly-fetched delta rows into the previously cached full list,
// upserting by id (newer row replaces older one with the same id).
function mergeById(cachedList, deltaList) {
  const byId = new Map(cachedList.map((r) => [r.id, r]));
  deltaList.forEach((r) => byId.set(r.id, r));
  return Array.from(byId.values());
}

// Wipes every store completely - call this on logout. Without it, a
// second account logging in on the same device inherits the previous
// account's cached cattle/fields/etc, since nothing here is scoped by
// user id (see DB_NAME/STORES above - one shared cache for the whole
// device, not per-account). This is what was causing every account to
// see the same stale cattle/base data after switching accounts.
async function clearAll() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readwrite');
      STORES.forEach((storeName) => tx.objectStore(storeName).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort, same as the rest of this file
  }
}

export const offlineCache = { getAll, putAll, getMeta, setMeta, remove, mergeById, clearAll };