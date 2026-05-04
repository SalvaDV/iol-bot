function sbFetch(path, opts = {}) {
  return fetch(`${process.env.SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: process.env.SB_KEY,
      Authorization: `Bearer ${process.env.SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

export async function savePendingSignal(signal) {
  const res = await sbFetch('/pending_signals', {
    method: 'POST',
    body: JSON.stringify(signal),
  });
  if (!res.ok) throw new Error(`savePendingSignal failed: ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

export async function updateSignalStatus(id, status) {
  const res = await sbFetch(`/pending_signals?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`updateSignalStatus failed: ${res.status}`);
}

export async function getPendingSignals() {
  const res = await sbFetch('/pending_signals?status=eq.pending&order=created_at.asc');
  if (!res.ok) throw new Error(`getPendingSignals failed: ${res.status}`);
  return await res.json();
}

export async function cancelAllPending() {
  const res = await sbFetch('/pending_signals?status=eq.pending', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelado' }),
  });
  if (!res.ok) throw new Error(`cancelAllPending failed: ${res.status}`);
}

export async function logTrade(entry) {
  const res = await sbFetch('/trading_log', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`logTrade failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function updateTrade(id, fields) {
  const res = await sbFetch(`/trading_log?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateTrade failed: ${res.status}`);
}

export async function getRecentTrades(n = 10) {
  const res = await sbFetch(`/trading_log?order=created_at.desc&limit=${n}`);
  if (!res.ok) return [];
  return await res.json();
}

export async function getLastEfectivoPost() {
  // Busca el último trade con efectivo_post registrado (máximo 3 días atrás)
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `/trading_log?efectivo_post=not.is.null&created_at=gt.${cutoff}&order=created_at.desc&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function getRecentProposals(n = 9) {
  const res = await sbFetch(`/pending_signals?order=created_at.desc&limit=${n}`);
  if (!res.ok) return [];
  return await res.json();
}

export async function saveProposal({ simbolo, dir, precio_prop, pct_efectivo, signals }) {
  const res = await sbFetch('/propuestas_log', {
    method: 'POST',
    body: JSON.stringify({ simbolo, dir, precio_prop, pct_efectivo, signals }),
  });
  if (!res.ok) throw new Error(`saveProposal failed: ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

export async function markProposalExecuted(id, precio_ejec) {
  const res = await sbFetch(`/propuestas_log?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ executed: true, precio_ejec }),
  });
  if (!res.ok) throw new Error(`markProposalExecuted failed: ${res.status}`);
}

export async function getPendingOutcomes7d() {
  // Proposals older than 7 days not yet evaluated at 7d
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `/propuestas_log?evaluated_7d=eq.false&dir=neq.dolar&created_at=lt.${cutoff}&order=created_at.asc&limit=50`
  );
  if (!res.ok) return [];
  return await res.json();
}

export async function getPendingOutcomes30d() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `/propuestas_log?evaluated_30d=eq.false&dir=neq.dolar&created_at=lt.${cutoff}&order=created_at.asc&limit=50`
  );
  if (!res.ok) return [];
  return await res.json();
}

export async function updateOutcome7d(id, precio_7d, retorno_7d) {
  const res = await sbFetch(`/propuestas_log?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ precio_7d, retorno_7d, evaluated_7d: true }),
  });
  if (!res.ok) throw new Error(`updateOutcome7d failed: ${res.status}`);
}

export async function updateOutcome30d(id, precio_30d, retorno_30d) {
  const res = await sbFetch(`/propuestas_log?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ precio_30d, retorno_30d, evaluated_30d: true }),
  });
  if (!res.ok) throw new Error(`updateOutcome30d failed: ${res.status}`);
}

// ─── Estado conversacional por usuario ───────────────────────────────────────
export async function getUserState(userId) {
  const res = await sbFetch(`/user_state?user_id=eq.${userId}&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function setUserState(userId, action, data = {}) {
  const res = await sbFetch('/user_state', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ user_id: userId, action, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setUserState failed: ${res.status}`);
}

export async function clearUserState(userId) {
  await sbFetch(`/user_state?user_id=eq.${userId}`, { method: 'DELETE' });
}

// ─── Watchlist personalizada ──────────────────────────────────────────────────
export async function getCustomWatchlist() {
  const res = await sbFetch('/custom_watchlist?order=created_at.asc');
  if (!res.ok) return [];
  return await res.json();
}

export async function addToWatchlist(simbolo, nombre, mercado = 'bcba') {
  const sym = simbolo.toUpperCase();
  const res = await sbFetch('/custom_watchlist', {
    method: 'POST',
    body: JSON.stringify({ simbolo: sym, nombre, mercado }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 409 || body.includes('unique')) throw new Error(`${sym} ya está en tu watchlist`);
    throw new Error(`addToWatchlist failed: ${res.status}`);
  }
  const rows = await res.json();
  return rows[0];
}

export async function removeFromWatchlist(simbolo) {
  const res = await sbFetch(`/custom_watchlist?simbolo=eq.${simbolo.toUpperCase()}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`removeFromWatchlist failed: ${res.status}`);
}

export async function getPerformanceStats() {
  // Last 30 evaluated proposals (7d) for hit rate
  const res = await sbFetch(
    `/propuestas_log?evaluated_7d=eq.true&order=created_at.desc&limit=30`
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (rows.length === 0) return null;

  const compras = rows.filter(r => r.dir === 'compra' && r.retorno_7d != null);
  const ventas  = rows.filter(r => r.dir === 'venta'  && r.retorno_7d != null);

  const hitRate = (arr, positive) => {
    if (!arr.length) return null;
    const hits = arr.filter(r => positive ? r.retorno_7d > 0 : r.retorno_7d < 0).length;
    const avg = arr.reduce((s, r) => s + r.retorno_7d, 0) / arr.length;
    return { n: arr.length, hits, rate: (hits / arr.length * 100).toFixed(0), avg: avg.toFixed(1) };
  };

  return {
    compras: hitRate(compras, true),
    ventas: hitRate(ventas, false),
    total: rows.length,
  };
}
