import { getToken, getPortfolio, getCuenta, getCotizacion, getHistorial } from './iol.js';
import { calcRSI, calcMA, getSignals, decideDirection } from './indicators.js';
import { sendMessage } from './telegram.js';

const WATCHLIST = [
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','MELI','AVGO',
  'NOKA','GLD','PAAS','NKE','YPFD','BABA','AMD','PYPL','INTC',
  'GOLD','SLV','WMT','JPM',
];

const MAX_ARS = 50_000;

async function fetchTicker(token, sym) {
  try {
    const [cot, hist] = await Promise.all([
      getCotizacion(token, sym),
      getHistorial(token, sym),
    ]);
    const bars = (hist.historico || hist.items || [])
      .slice()
      .sort((a, b) => new Date(a.fechaHora) - new Date(b.fechaHora));
    const closes = bars.map(b => b.ultimo || b.cierre).filter(Boolean);
    const vols = bars.map(b => b.cantidadOperaciones || b.volumen || 0);

    const ultimo = cot.ultimo || cot.precio || closes.at(-1);
    const apertura = cot.apertura || ultimo;
    const volHoy = cot.cantidadOperaciones || vols.at(-1) || 0;
    const vol5avg = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5 || 1;

    const rsi = calcRSI(closes);
    const ma20 = calcMA(closes, 20);
    const ma50 = calcMA(closes, 50);
    const prevCloses = closes.slice(0, -1);
    const prevMA20 = calcMA(prevCloses, 20);
    const prevMA50 = calcMA(prevCloses, 50);
    const intraDayPct = apertura ? ((ultimo - apertura) / apertura) * 100 : null;
    const volRatio = vol5avg > 0 ? volHoy / vol5avg : null;

    const signals = getSignals({ rsi, ma20, ma50, volRatio, intraDayPct, prevMA20, prevMA50 });
    const dir = decideDirection(signals);

    return { sym, ultimo, rsi, ma20, ma50, intraDayPct, volRatio, signals, dir };
  } catch {
    return null;
  }
}

export async function runAnalysis() {
  const token = await getToken();
  const [cuenta] = await Promise.all([getCuenta(token), getPortfolio(token)]);

  let efectivo = 0;
  try {
    const saldos = cuenta.cuentas?.[0]?.saldos || cuenta.saldos || [];
    const s = saldos.find(x => x.llave === 'Dinero' || x.descripcion?.toLowerCase().includes('dinero'));
    efectivo = s?.valor || s?.monto || 0;
  } catch { /* keep 0 */ }

  const results = await Promise.all(WATCHLIST.map(sym => fetchTicker(token, sym)));
  const operable = results.filter(r => r?.dir !== null && r !== null);

  if (operable.length === 0) {
    await sendMessage(
      `📊 *Sin señales — mejor no operar*\n\n` +
      `💰 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS\n` +
      `🕐 ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`
    );
    return null;
  }

  const best = operable.sort((a, b) => {
    const score = r => r.signals.filter(s => s.dir === r.dir).length;
    return score(b) - score(a);
  })[0];

  const precio = best.ultimo;
  const cantidad = best.dir === 'compra'
    ? Math.floor(Math.min(MAX_ARS, efectivo * 0.95) / precio)
    : null;

  if (best.dir === 'compra' && (!cantidad || cantidad < 1)) {
    await sendMessage(
      `📊 *Señal detectada pero efectivo insuficiente*\n\n` +
      `📈 ${best.sym} — COMPRA a $${precio}\n` +
      `💰 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS — no alcanza para 1 acción.`
    );
    return null;
  }

  const signalLines = best.signals.map(s => `  • ${s.detail}`).join('\n');
  const cantidadStr = best.dir === 'compra'
    ? `${cantidad} acciones ($${(cantidad * precio).toLocaleString('es-AR')} ARS)`
    : `toda la posición`;

  await sendMessage(
    `🚨 *SEÑAL DE TRADING*\n\n` +
    `*${best.sym}* — ${best.dir === 'compra' ? '📈 COMPRA' : '📉 VENTA'}\n` +
    `💵 Precio actual: $${precio}\n` +
    `📊 Indicadores:\n${signalLines}\n\n` +
    `📦 Cantidad: ${cantidadStr}\n` +
    `💰 Efectivo disponible: $${efectivo.toLocaleString('es-AR')} ARS\n\n` +
    `¿Confirmar operación?\n*Respondé: si / no*`
  );

  return {
    simbolo: best.sym,
    dir: best.dir,
    precio,
    cantidad: best.dir === 'compra' ? cantidad : null,
    ef_pre: efectivo,
    signals: best.signals.map(s => s.detail),
  };
}
