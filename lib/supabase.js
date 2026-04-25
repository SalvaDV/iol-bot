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

export async function getPendingSignal() {
  const res = await sbFetch('/pending_signals?status=eq.pending&order=created_at.desc&limit=1');
  if (!res.ok) throw new Error(`getPendingSignal failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

export async function updateSignalStatus(id, status) {
  const res = await sbFetch(`/pending_signals?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`updateSignalStatus failed: ${res.status}`);
}

export async function logTrade(entry) {
  const res = await sbFetch('/trading_log', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`logTrade failed: ${res.status}`);
}
