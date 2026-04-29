import { createHmac } from 'crypto';

const BASE = 'https://api.binance.com';

function sign(qs) {
  return createHmac('sha256', process.env.BINANCE_SECRET ?? '')
    .update(qs).digest('hex');
}

async function bFetch(path, params = {}, method = 'GET') {
  const ts = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp: ts }).toString();
  const sig = sign(qs);
  const url = `${BASE}${path}?${qs}&signature=${sig}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': process.env.BINANCE_KEY ?? '' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Binance ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export const isBinanceConfigured = () =>
  !!(process.env.BINANCE_KEY && process.env.BINANCE_SECRET);

export async function getBinanceBalance(asset) {
  const data = await bFetch('/api/v3/account');
  const bal = (data.balances ?? []).find(b => b.asset === asset.toUpperCase());
  return parseFloat(bal?.free ?? 0);
}

export async function getBinancePrice(symbol) {
  try {
    const res = await fetch(`${BASE}/api/v3/ticker/price?symbol=${symbol.toUpperCase()}USDT`);
    if (!res.ok) return null;
    const d = await res.json();
    return parseFloat(d.price) || null;
  } catch {
    return null;
  }
}

// Compra gastando quoteOrderQty USDT → devuelve { precio, cantidad, total }
export async function binanceBuy(symbol, quoteOrderQty) {
  const order = await bFetch('/api/v3/order', {
    symbol: `${symbol.toUpperCase()}USDT`,
    side: 'BUY',
    type: 'MARKET',
    quoteOrderQty: quoteOrderQty.toFixed(2),
  }, 'POST');

  const ejecutado = parseFloat(order.executedQty ?? 0);
  const gastado   = parseFloat(order.cummulativeQuoteQty ?? quoteOrderQty);
  const precio    = ejecutado > 0 ? gastado / ejecutado : null;
  return { order, cantidad: ejecutado, costoUsdt: gastado, precioUsd: precio };
}

// Vende quantity del símbolo → devuelve { precio, ingresoUsdt }
export async function binanceSell(symbol, quantity) {
  const order = await bFetch('/api/v3/order', {
    symbol: `${symbol.toUpperCase()}USDT`,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(quantity),
  }, 'POST');

  const ingreso = parseFloat(order.cummulativeQuoteQty ?? 0);
  const qty     = parseFloat(order.executedQty ?? quantity);
  const precio  = qty > 0 ? ingreso / qty : null;
  return { order, cantidad: qty, ingresoUsdt: ingreso, precioUsd: precio };
}
