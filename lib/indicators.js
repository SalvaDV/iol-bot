export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function calcMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── EMA (array completo, uso interno) ────────────────────────────────────────
function calcEMAArray(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  const result = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ── MACD (12/26/9 por defecto) ────────────────────────────────────────────────
// Retorna: { macd, signal, histogram, prev_macd, prev_signal } o null
export function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod + 1) return null;
  const emaFast = calcEMAArray(closes, fast);
  const emaSlow = calcEMAArray(closes, slow);
  if (!emaFast || !emaSlow) return null;

  // Alinear: emaFast tiene más valores, recortar para que empiecen juntos
  const offset = emaFast.length - emaSlow.length;
  const macdLine = emaSlow.map((s, i) => emaFast[i + offset] - s);

  if (macdLine.length < signalPeriod + 1) return null;
  const signalLine = calcEMAArray(macdLine, signalPeriod);
  if (!signalLine || signalLine.length < 2) return null;

  return {
    macd:        macdLine.at(-1),
    signal:      signalLine.at(-1),
    histogram:   macdLine.at(-1) - signalLine.at(-1),
    prev_macd:   macdLine.at(-2),
    prev_signal: signalLine.at(-2),
  };
}

// ── Bollinger Bands (20/2 por defecto) ───────────────────────────────────────
// Retorna: { upper, middle, lower, bandwidth, pct_b } o null
// pct_b: 0 = en banda inferior, 1 = en banda superior
export function calcBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const stddev = Math.sqrt(variance);
  const upper = middle + mult * stddev;
  const lower = middle - mult * stddev;
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0;
  const last = closes.at(-1);
  const pct_b = (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5;
  return { upper, middle, lower, bandwidth, pct_b };
}

// ── Señales ───────────────────────────────────────────────────────────────────
export function getSignals({ rsi, ma20, ma50, volRatio, intraDayPct, prevMA20, prevMA50, macd, bb }) {
  const signals = [];

  // RSI
  if (rsi !== null) {
    if (rsi < 30) signals.push({ type: 'RSI_OVERSOLD',   dir: 'compra', detail: `RSI ${rsi.toFixed(1)}` });
    else if (rsi > 70) signals.push({ type: 'RSI_OVERBOUGHT', dir: 'venta', detail: `RSI ${rsi.toFixed(1)}` });
  }

  // Golden/Death Cross (MA20 vs MA50)
  if (ma20 !== null && ma50 !== null && prevMA20 !== null && prevMA50 !== null) {
    if (prevMA20 <= prevMA50 && ma20 > ma50)
      signals.push({ type: 'GOLDEN_CROSS', dir: 'compra', detail: `Golden Cross MA20>${ma20.toFixed(2)} MA50>${ma50.toFixed(2)}` });
    else if (prevMA20 >= prevMA50 && ma20 < ma50)
      signals.push({ type: 'DEATH_CROSS',  dir: 'venta',  detail: `Death Cross MA20<${ma20.toFixed(2)} MA50<${ma50.toFixed(2)}` });
  }

  // Volumen anómalo
  if (volRatio !== null && volRatio > 2)
    signals.push({ type: 'HIGH_VOLUME', dir: 'neutral', detail: `Volumen ${volRatio.toFixed(1)}x promedio` });

  // Movimiento intradiario
  if (intraDayPct !== null) {
    if (intraDayPct >  3) signals.push({ type: 'INTRADAY_UP',   dir: 'compra', detail: `+${intraDayPct.toFixed(1)}% hoy` });
    else if (intraDayPct < -3) signals.push({ type: 'INTRADAY_DOWN', dir: 'venta',  detail: `${intraDayPct.toFixed(1)}% hoy` });
  }

  // MACD crossover
  if (macd) {
    if (macd.prev_macd <= macd.prev_signal && macd.macd > macd.signal)
      signals.push({ type: 'MACD_BULLISH', dir: 'compra', detail: `MACD cruza al alza (hist ${macd.histogram > 0 ? '+' : ''}${macd.histogram.toFixed(3)})` });
    else if (macd.prev_macd >= macd.prev_signal && macd.macd < macd.signal)
      signals.push({ type: 'MACD_BEARISH', dir: 'venta',  detail: `MACD cruza a la baja (hist ${macd.histogram.toFixed(3)})` });
  }

  // Bollinger Bands
  if (bb) {
    if (bb.pct_b <= 0.05)
      signals.push({ type: 'BB_OVERSOLD',   dir: 'compra',  detail: `Precio en banda inferior BB (${(bb.pct_b * 100).toFixed(0)}%)` });
    else if (bb.pct_b >= 0.95)
      signals.push({ type: 'BB_OVERBOUGHT', dir: 'venta',   detail: `Precio en banda superior BB (${(bb.pct_b * 100).toFixed(0)}%)` });
    else if (bb.bandwidth < 0.06)
      signals.push({ type: 'BB_SQUEEZE',    dir: 'neutral', detail: `BB squeeze BW ${(bb.bandwidth * 100).toFixed(1)}%` });
  }

  return signals;
}

export function decideDirection(signals) {
  const compra  = signals.filter(s => s.dir === 'compra').length;
  const venta   = signals.filter(s => s.dir === 'venta').length;
  const neutral = signals.filter(s => s.dir === 'neutral').length;
  if (compra >= 2 || (compra >= 1 && neutral >= 1 && venta === 0)) return 'compra';
  if (venta  >= 2 || (venta  >= 1 && neutral >= 1 && compra === 0)) return 'venta';
  return null;
}
