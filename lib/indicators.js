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

export function getSignals({ rsi, ma20, ma50, volRatio, intraDayPct, prevMA20, prevMA50 }) {
  const signals = [];
  if (rsi !== null) {
    if (rsi < 30) signals.push({ type: 'RSI_OVERSOLD', dir: 'compra', detail: `RSI ${rsi.toFixed(1)}` });
    else if (rsi > 70) signals.push({ type: 'RSI_OVERBOUGHT', dir: 'venta', detail: `RSI ${rsi.toFixed(1)}` });
  }
  if (ma20 !== null && ma50 !== null && prevMA20 !== null && prevMA50 !== null) {
    if (prevMA20 <= prevMA50 && ma20 > ma50)
      signals.push({ type: 'GOLDEN_CROSS', dir: 'compra', detail: `MA20 ${ma20.toFixed(2)} cruzó sobre MA50 ${ma50.toFixed(2)}` });
    else if (prevMA20 >= prevMA50 && ma20 < ma50)
      signals.push({ type: 'DEATH_CROSS', dir: 'venta', detail: `MA20 ${ma20.toFixed(2)} cruzó bajo MA50 ${ma50.toFixed(2)}` });
  }
  if (volRatio !== null && volRatio > 2)
    signals.push({ type: 'HIGH_VOLUME', dir: 'neutral', detail: `Volumen ${volRatio.toFixed(1)}x promedio` });
  if (intraDayPct !== null) {
    if (intraDayPct > 3) signals.push({ type: 'INTRADAY_UP', dir: 'compra', detail: `+${intraDayPct.toFixed(1)}% hoy` });
    else if (intraDayPct < -3) signals.push({ type: 'INTRADAY_DOWN', dir: 'venta', detail: `${intraDayPct.toFixed(1)}% hoy` });
  }
  return signals;
}

export function decideDirection(signals) {
  const compra = signals.filter(s => s.dir === 'compra').length;
  const venta = signals.filter(s => s.dir === 'venta').length;
  const neutral = signals.filter(s => s.dir === 'neutral').length;
  if (compra >= 2 || (compra >= 1 && neutral >= 1 && venta === 0)) return 'compra';
  if (venta >= 2 || (venta >= 1 && neutral >= 1 && compra === 0)) return 'venta';
  return null;
}
