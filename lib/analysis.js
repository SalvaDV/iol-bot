import { getToken, getPortfolio, getCuenta, getCotizacion, getHistorial } from './iol.js';
import { calcRSI, calcMA, getSignals, decideDirection } from './indicators.js';
import { sendMessage } from './telegram.js';

// Acciones BCBA panel general + CEDEARs populares + bonos soberanos
const WATCHLIST = [
  // Acciones BCBA
  'GGAL', 'YPFD', 'BMA', 'PAMP', 'TXAR', 'ALUA', 'COME', 'CRES',
  'CEPU', 'EDN', 'SUPV', 'TECO2', 'TGNO4', 'TGSU2', 'VALO', 'BYMA',
  'LOMA', 'METR', 'MIRG', 'BOLT', 'IRSA', 'AGRO',
  // CEDEARs
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'MELI',
  'AVGO', 'AMD', 'JPM', 'PYPL', 'BABA', 'WMT', 'NKE', 'INTC',
  // Commodities / ETFs
  'GLD', 'SLV', 'GOLD', 'PAAS',
  // Bonos soberanos en ARS
  'AL30', 'GD30', 'AL35', 'GD35',
];

// Asignación proporcional según cantidad de señales confirmadas
function allocationPct(matchingSignals) {
  if (matchingSignals >= 4) return 0.30;
  if (matchingSignals >= 3) return 0.20;
  return 0.12;
}

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

    if (closes.length < 50) return null;

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
  const [cuenta, portfolio] = await Promise.all([getCuenta(token), getPortfolio(token)]);

  let efectivo = 0;
  try {
    const saldos = cuenta.cuentas?.[0]?.saldos || cuenta.saldos || [];
    const s = saldos.find(x => x.llave === 'Dinero' || x.descripcion?.toLowerCase().includes('dinero'));
    efectivo = s?.valor || s?.monto || 0;
  } catch { /* keep 0 */ }

  // Siempre incluir posiciones del portafolio + watchlist fijo
  const portfolioSyms = (portfolio.titulos || [])
    .map(t => t.simbolo?.toUpperCase())
    .filter(Boolean);
  const fullList = [...new Set([...portfolioSyms, ...WATCHLIST])];

  const results = await Promise.all(fullList.map(sym => fetchTicker(token, sym)));
  const operable = results.filter(r => r?.dir !== null && r !== null);

  if (operable.length === 0) {
    await sendMessage(
      `📊 *Sin señales — mejor no operar*\n\n` +
      `💰 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS\n` +
      `🕐 ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`
    );
    return null;
  }

  // Ordenar por cantidad de señales que coinciden con la dirección
  const scored = operable.map(r => ({
    ...r,
    score: r.signals.filter(s => s.dir === r.dir).length,
  }));
  const best = scored.sort((a, b) => b.score - a.score)[0];

  const precio = best.ultimo;
  const pct = allocationPct(best.score);
  const cantidad = best.dir === 'compra'
    ? Math.floor(efectivo * pct / precio)
    : null;

  if (best.dir === 'compra' && (!cantidad || cantidad < 1)) {
    await sendMessage(
      `📊 *Señal detectada pero efectivo insuficiente*\n\n` +
      `📈 ${best.sym} — COMPRA a $${precio}\n` +
      `💰 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS — no alcanza para 1 unidad.`
    );
    return null;
  }

  const signalLines = best.signals.map(s => `  • ${s.detail}`).join('\n');
  const montoARS = best.dir === 'compra'
    ? `$${(cantidad * precio).toLocaleString('es-AR')} ARS (${(pct * 100).toFixed(0)}% del efectivo)`
    : `posición completa`;

  await sendMessage(
    `⚡ *OPORTUNIDAD DETECTADA*\n\n` +
    `📌 Instrumento: *${best.sym}*\n` +
    `💰 Precio actual: $${precio}\n` +
    `${best.dir === 'compra' ? '📈' : '📉'} Operación: ${best.dir.toUpperCase()} de ${best.dir === 'compra' ? cantidad : 'toda la posición'} unidades\n` +
    `💵 Monto total aprox: ${montoARS}\n\n` +
    `📊 Análisis:\n${signalLines}\n\n` +
    `⚠️ Señales confirmadas: ${best.score}/4\n\n` +
    `Respondé *si* para ejecutar o *no* para cancelar.\n` +
    `⏳ Timeout en 10 minutos.`
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
