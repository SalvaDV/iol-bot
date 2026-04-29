const BASE = 'https://api.coingecko.com/api/v3';

const COINS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  MATIC: 'matic-network',
  ADA: 'cardano',
  DOGE: 'dogecoin',
};

export async function getCryptoPrices() {
  try {
    const ids = Object.values(COINS).join(',');
    const res = await fetch(
      `${BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_vol_cap=true`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getCryptoTrending() {
  try {
    const res = await fetch(`${BASE}/search/trending`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.coins ?? []).slice(0, 5).map(c => c.item?.symbol?.toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export function formatCryptoContext(prices, trending = []) {
  if (!prices) return 'Sin datos de crypto (CoinGecko no respondió).';

  const lines = Object.entries(COINS).map(([sym, id]) => {
    const d = prices[id];
    if (!d) return null;
    const price = d.usd?.toLocaleString('en-US', { maximumFractionDigits: 2 }) ?? '?';
    const c24 = d.usd_24h_change;
    const arrow = c24 == null ? '' : c24 >= 0 ? '▲' : '▼';
    const pct24 = c24 != null ? `${arrow}${Math.abs(c24).toFixed(1)}%` : '?';
    return `• ${sym}: $${price} USD (24h ${pct24})`;
  }).filter(Boolean);

  let out = lines.join('\n');
  if (trending.length > 0) out += `\nTrending: ${trending.join(', ')}`;
  return out;
}
