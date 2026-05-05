import { getCotizacion, getHistorial, extractPrecio } from './iol.js';
import { calcRSI, calcMA, calcMACD, calcBollinger, calcVWAP, calcDonchian, buildWeeklyCloses, getSignals, decideDirection } from './indicators.js';

// Acciones BCBA del panel líder — benchmark de fuerza relativa
const MERVAL_PROXY_SYMS = new Set(['GGAL', 'YPFD', 'PAMP', 'BMA', 'ALUA', 'CEPU', 'TXAR', 'EDN']);

// CEDEARs y bonos — no se comparan vs Merval (tienen benchmark distinto)
const NON_BCBA = new Set([
  'AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','MELI','META',
  'COIN','MSTR','MARA','RIOT','HOOD','AMD','INTC','JPM','KO',
  'WMT','XOM','BABA','PYPL','DIS','SPOT','UBER','GS','CVX',
  'BA','PFE','NFLX','CRM',
  'AL30','GD30','GD35','GD38','AE38','AL35',
]);

export const WATCHLIST = [
  // Acciones BCBA más líquidas
  'GGAL', 'YPFD', 'BMA', 'PAMP', 'TXAR', 'ALUA', 'CEPU', 'EDN', 'SUPV', 'TECO2',
  // CEDEARs tech/growth
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'MELI', 'META',
  // CEDEARs con exposición crypto (proxy de BTC/ETH via IOL)
  'COIN', 'MSTR', 'MARA', 'RIOT', 'HOOD',
  // Bonos soberanos
  'AL30', 'GD30',
];

const TICKER_TIMEOUT_MS = 5_000;   // por ticker individual
const ANALYSIS_TIMEOUT_MS = 35_000; // total del análisis, deja ~25s para Anthropic
const QUOTE_TIMEOUT_MS = 3_000;    // para market movers scan (solo cotizacion, sin historial)

// Lista extendida para el scan de mayores movimientos del día
// (adicional al WATCHLIST fijo)
const EXTRA_MARKET = [
  // BCBA - panel general adicionales
  'LOMA', 'BYMA', 'CRES', 'SEMI', 'MIRG', 'IRSA', 'COME', 'HARG',
  'METR', 'TGNO4', 'TGSU2', 'VALO', 'AGRO', 'CAPX', 'MOLI', 'POLL',
  // CEDEARs adicionales
  'AMD', 'INTC', 'JPM', 'KO', 'WMT', 'XOM', 'BABA', 'PYPL', 'DIS',
  'SPOT', 'UBER', 'GS', 'CVX', 'BA', 'PFE', 'NFLX', 'CRM',
  // Bonos soberanos adicionales
  'GD35', 'GD38', 'AE38', 'AL35',
];

// Asignación proporcional según cantidad de señales confirmadas
function allocationPct(matchingSignals) {
  if (matchingSignals >= 4) return 0.30;
  if (matchingSignals >= 3) return 0.20;
  return 0.12;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function fetchTicker(token, sym) {
  try {
    const cot = await withTimeout(getCotizacion(token, sym), TICKER_TIMEOUT_MS);
    const mercado = cot._mercado || 'bcba';
    const hist = await withTimeout(getHistorial(token, sym, mercado), TICKER_TIMEOUT_MS);
    const bars = (hist.historico || hist.items || [])
      .slice()
      .sort((a, b) => new Date(a.fechaHora) - new Date(b.fechaHora));
    const closes = bars.map(b => b.ultimo ?? b.cierre ?? null).filter(v => v !== null && v > 0);
    const vols = bars.map(b => b.cantidadOperaciones || b.volumen || 0);

    if (closes.length < 5) return null;

    const ultimo = extractPrecio(cot) || closes.at(-1);
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
    const macd     = calcMACD(closes);
    const bb       = calcBollinger(closes);
    const vwap     = calcVWAP(closes, vols);
    const donchian = calcDonchian(closes);

    // Multi-timeframe: RSI semanal como filtro de tendencia de fondo
    const weeklyCloses = buildWeeklyCloses(closes);
    const weeklyRsi    = weeklyCloses.length >= 15 ? calcRSI(weeklyCloses) : null;

    const signals = getSignals({ rsi, ma20, ma50, volRatio, intraDayPct, prevMA20, prevMA50, macd, bb, vwap, donchian, weeklyRsi });
    const dir     = decideDirection(signals, weeklyRsi);

    return { sym, ultimo, rsi, ma20, ma50, macd, bb, vwap, donchian, weeklyRsi, intraDayPct, volRatio, signals, dir, _mercado: mercado };
  } catch {
    return null;
  }
}

/**
 * Escanea cotizaciones rápidas (sin historial) para encontrar los mayores movimientos del día.
 * Pensado para correr en paralelo junto a getPortfolio/getCuenta — timeout corto.
 * @param {number} topN  Cantidad de ganadores/perdedores a devolver (default: 5)
 * @returns {{ gainers: Array, losers: Array }}
 */
export async function scanMarketMovers(token, topN = 5) {
  const allSyms = [...new Set([...WATCHLIST, ...EXTRA_MARKET])];
  const settled = await Promise.allSettled(
    allSyms.map(async sym => {
      try {
        const cot = await withTimeout(getCotizacion(token, sym), QUOTE_TIMEOUT_MS);
        const variacion = cot.variacionDiaria ?? cot.variacion ?? null;
        if (variacion === null) return null;
        const precio = extractPrecio(cot);
        return { sym, variacion, precio, mercado: cot._mercado || 'bcba' };
      } catch {
        return null;
      }
    })
  );

  const valid = settled
    .map(r => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean)
    .sort((a, b) => b.variacion - a.variacion);

  return {
    gainers: valid.slice(0, topN),
    losers: [...valid].reverse().slice(0, topN),
  };
}

// Retorna todos los resultados técnicos sin enviar mensaje — usado por advisor.js
// extraSymbols: símbolos del portafolio actual para incluir aunque no estén en el WATCHLIST
export async function fetchAllTechnicals(token, extraSymbols = []) {
  const fullList = [...new Set([...WATCHLIST, ...extraSymbols.map(s => s.toUpperCase())])];
  const results = await withTimeout(
    Promise.all(fullList.map(sym => fetchTicker(token, sym))),
    ANALYSIS_TIMEOUT_MS
  );
  const valid = results.filter(Boolean);

  // ── Fuerza relativa vs Merval ────────────────────────────────────────────────
  // Benchmark: promedio del movimiento diario de las acciones del panel líder
  const proxyData = valid.filter(t => MERVAL_PROXY_SYMS.has(t.sym) && t.intraDayPct !== null);
  if (proxyData.length >= 3) {
    const mervalDailyPct = proxyData.reduce((s, t) => s + t.intraDayPct, 0) / proxyData.length;
    for (const t of valid) {
      if (t.intraDayPct === null || NON_BCBA.has(t.sym)) continue;
      const rs = t.intraDayPct - mervalDailyPct;
      t.relStrength = rs;
      if (rs > 2)
        t.signals.push({ type: 'RS_OUTPERFORM', dir: 'compra', detail: `Supera al Merval en +${rs.toFixed(1)}% hoy (fuerza relativa positiva)` });
      else if (rs < -2)
        t.signals.push({ type: 'RS_UNDERPERFORM', dir: 'venta', detail: `Underperform vs Merval ${rs.toFixed(1)}% hoy (debilidad relativa)` });
    }
  }

  return valid;
}
