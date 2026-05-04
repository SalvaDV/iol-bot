import { getCotizacion, getHistorial, extractPrecio } from './iol.js';
import { calcRSI, calcMA, getSignals, decideDirection } from './indicators.js';

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

    const signals = getSignals({ rsi, ma20, ma50, volRatio, intraDayPct, prevMA20, prevMA50 });
    const dir = decideDirection(signals);

    return { sym, ultimo, rsi, ma20, ma50, intraDayPct, volRatio, signals, dir };
  } catch {
    return null;
  }
}

// Retorna todos los resultados técnicos sin enviar mensaje — usado por advisor.js
// extraSymbols: símbolos del portafolio actual para incluir aunque no estén en el WATCHLIST
export async function fetchAllTechnicals(token, extraSymbols = []) {
  const fullList = [...new Set([...WATCHLIST, ...extraSymbols.map(s => s.toUpperCase())])];
  const results = await withTimeout(
    Promise.all(fullList.map(sym => fetchTicker(token, sym))),
    ANALYSIS_TIMEOUT_MS
  );
  return results.filter(Boolean);
}
