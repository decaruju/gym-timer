// ====== Supabase cloud sync ======
// Public anon key + project URL live in window.SUPABASE_CONFIG (set in index.html).
// The anon key is not a secret; RLS policies are what protect data.
//
// Strategy: auto-push every local mutation; pull-all on sign-in (with a prompt
// when local data exists). Cross-device conflicts resolve last-write-wins on
// updated_at — fine for single-user multi-device, which is the supported case.

(function () {
  const CONFIG = window.SUPABASE_CONFIG || {};
  const STORE_TABLE = { trainings: 'trainings', schedule: 'schedule', history: 'history' };

  let client = null;
  let currentUser = null;
  const listeners = new Set();
  const pendingQueue = [];   // [{kind:'put'|'del', store, value|id}] flushed on reconnect
  let flushing = false;

  function configured() { return !!CONFIG.url && !!CONFIG.anonKey; }
  function emit() { listeners.forEach((fn) => { try { fn(currentUser); } catch (e) { console.warn(e); } }); }

  function init() {
    if (!configured()) { console.info('[sync] Supabase not configured — running offline-only.'); return; }
    if (!window.supabase) { console.warn('[sync] supabase-js not loaded'); return; }
    client = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    client.auth.getSession().then(({ data }) => {
      currentUser = data?.session?.user || null;
      emit();
      if (currentUser) onSignIn().catch((e) => console.warn('[sync] initial sync failed', e));
    });
    client.auth.onAuthStateChange((event, session) => {
      const prev = currentUser;
      currentUser = session?.user || null;
      emit();
      if (!prev && currentUser && event === 'SIGNED_IN') {
        onSignIn().catch((e) => { console.warn('[sync] sign-in sync failed', e); window.toast?.('Sync failed: ' + (e.message || e)); });
      }
    });
    window.addEventListener('online', flushQueue);
  }

  async function signInWithEmail(email) {
    if (!client) throw new Error('Supabase not configured');
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    });
    if (error) throw error;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
  }

  // Wrap an upsert/delete so a failure is captured and retried on reconnect
  // rather than lost. Best-effort; not a durable queue across reloads.
  async function safe(op, payload) {
    try { await op(); } catch (e) {
      console.warn('[sync] queued (will retry on reconnect):', e?.message || e);
      pendingQueue.push(payload);
    }
  }

  function flushQueue() {
    if (flushing || !currentUser) return;
    flushing = true;
    (async () => {
      while (pendingQueue.length) {
        const item = pendingQueue.shift();
        try {
          if (item.kind === 'put') await rawPush(item.store, item.value);
          else if (item.kind === 'del') await rawDelete(item.store, item.id);
        } catch (e) {
          // Put it back and stop; we'll retry next time.
          pendingQueue.unshift(item);
          console.warn('[sync] flush stalled', e);
          break;
        }
      }
    })().finally(() => { flushing = false; });
  }

  async function rawPush(store, value) {
    if (store === 'meta') {
      if (value?.key !== 'settings') return;
      const { key, ...rest } = value;
      const { error } = await client.from('settings').upsert({
        user_id: currentUser.id,
        data: rest,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return;
    }
    const table = STORE_TABLE[store];
    if (!table || !value?.id) return;
    const { error } = await client.from(table).upsert({
      id: String(value.id),
      user_id: currentUser.id,
      data: value,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    if (error) throw error;
  }

  async function rawDelete(store, id) {
    if (store === 'meta' || !id) return;
    const table = STORE_TABLE[store];
    if (!table) return;
    const { error } = await client.from(table).upsert({
      id: String(id),
      user_id: currentUser.id,
      data: { id },
      updated_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  function pushRow(store, value) {
    if (!client || !currentUser) return;
    safe(() => rawPush(store, value), { kind: 'put', store, value });
  }

  function deleteRow(store, id) {
    if (!client || !currentUser) return;
    safe(() => rawDelete(store, id), { kind: 'del', store, id });
  }

  // Replace local IDB contents with cloud rows. Soft-deleted rows are removed locally.
  async function pullAll() {
    if (!client || !currentUser) return;
    const db = await window.openDB();
    for (const t of ['trainings', 'schedule', 'history']) {
      const { data, error } = await client.from(t).select('*').eq('user_id', currentUser.id);
      if (error) throw error;
      await new Promise((res, rej) => {
        const tx = db.transaction(t, 'readwrite');
        const store = tx.objectStore(t);
        store.clear();
        for (const row of data || []) {
          if (!row.deleted_at) store.put(row.data);
        }
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    }
    const { data: s, error: sErr } = await client.from('settings').select('*').eq('user_id', currentUser.id).maybeSingle();
    if (sErr) throw sErr;
    if (s?.data) {
      await new Promise((res, rej) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'settings', ...s.data });
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    }
  }

  // Upload everything in IDB to cloud. Used after a "keep local" merge choice.
  async function pushAll() {
    if (!client || !currentUser) return;
    for (const store of ['trainings', 'schedule', 'history']) {
      const rows = await window.idbAll(store);
      for (const r of rows) await rawPush(store, r);
    }
    const m = await window.idbGet('meta', 'settings');
    if (m) await rawPush('meta', m);
  }

  async function hasAnyCloudData() {
    for (const t of ['trainings', 'schedule', 'history']) {
      const { count, error } = await client.from(t).select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id);
      if (error) throw error;
      if ((count || 0) > 0) return true;
    }
    return false;
  }

  async function hasAnyLocalData() {
    for (const t of ['trainings', 'schedule', 'history']) {
      const rows = await window.idbAll(t);
      if (rows && rows.length) return true;
    }
    return false;
  }

  // Called once after sign-in. Reconciles local IDB with cloud:
  //   - cloud empty & local empty  → nothing to do
  //   - cloud empty & local has    → push local up
  //   - cloud has   & local empty  → pull cloud down
  //   - both have data             → ask user which side wins
  async function onSignIn() {
    const [cloudHas, localHas] = await Promise.all([hasAnyCloudData(), hasAnyLocalData()]);
    if (!cloudHas && !localHas) return;
    if (!cloudHas && localHas) {
      await pushAll();
      window.toast?.('Local data uploaded to cloud');
    } else if (cloudHas && !localHas) {
      await pullAll();
      window.toast?.('Cloud data downloaded');
      await window.reloadAllFromIdb?.();
    } else {
      const keepCloud = confirm(
        'You have data on this device AND in the cloud.\n\n' +
        'OK = use CLOUD data (replace local).\n' +
        'Cancel = use LOCAL data (overwrite cloud).'
      );
      if (keepCloud) {
        await pullAll();
        window.toast?.('Replaced local data with cloud');
      } else {
        await pushAll();
        window.toast?.('Uploaded local data to cloud');
      }
      await window.reloadAllFromIdb?.();
    }
  }

  async function syncNow() {
    if (!client || !currentUser) throw new Error('Not signed in');
    await pullAll();
    await window.reloadAllFromIdb?.();
  }

  window.Sync = {
    init,
    signInWithEmail,
    signOut,
    syncNow,
    pushRow,
    deleteRow,
    isConfigured: configured,
    get user() { return currentUser; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
