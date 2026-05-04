/**
 * Alpha argentino:
 *  1. Merval en USD (proxy con panel líder ÷ CCL)
 *  2. Análisis de brecha cambiaria
 *  3. Performance feedback — qué señales ganaron y perdieron
 */

// Stocks del panel líder BCBA usados como proxy del Merval
const MERVAL_PROXY = ['GGAL', 'YPFD', 'PAMP', 'BMA', 'ALUA', 'CEPU', 'TXAR', 'EDN'];

// ── 1. Merval en USD ──────────────────────────────────────────────────────────
export function getMervalUSD(technicals, dolar) {
  if (!dolar?.ccl || dolar.ccl <= 0) return null;

  const items = [];
  for (const sym of MERVAL_PROXY) {
    const t = technicals.find(x => x.sym === sym);
    if (!t?.ultimo) continue;
    items.push({
      sym,
      ars:      t.ultimo,
      usd:      t.ultimo / dolar.ccl,
      usdMA20:  t.ma20   ? t.ma20  / dolar.ccl : null,
      usdMA50:  t.ma50   ? t.ma50  / dolar.ccl : null,
      weeklyRsi: t.weeklyRsi ?? null,
    });
  }

  if (items.length === 0) return null;

  const avgUSD    = items.reduce((s, x) => s + x.usd, 0) / items.length;
  const ma20Items = items.filter(x => x.usdMA20 != null);
  const avgMA20   = ma20Items.length > 0
    ? ma20Items.reduce((s, x) => s + x.usdMA20, 0) / ma20Items.length
    : null;

  const vsMA20Pct = avgMA20 > 0 ? (avgUSD - avgMA20) / avgMA20 * 100 : null;

  // Cuántas acciones están sobre su VWAP en USD (tendencia de fondo)
  const sobreVwap = items.filter(x => x.usdMA20 && x.usd > x.usdMA20).length;

  return { items, avgUSD, avgMA20, vsMA20Pct, sobreVwap, total: items.length };
}

// ── 2. Análisis de brecha ─────────────────────────────────────────────────────
export function getBrechaAnalysis(dolar) {
  const brecha = dolar?.brechaCCL;
  if (brecha == null) return null;

  let nivel, sesgo, recomendacion;

  if (brecha >= 80) {
    nivel = 'EXTREMA';
    sesgo = 'bearish_cedears';
    recomendacion = 'Brecha extrema: CEDEARs muy caros en ARS. Favorecé acciones locales. Evitá nuevas posiciones en CEDEARs salvo señal técnica muy fuerte.';
  } else if (brecha >= 50) {
    nivel = 'ALTA';
    sesgo = 'bearish_cedears';
    recomendacion = 'Brecha alta: CEDEARs con prima en ARS. Priorizá panel BCBA. Un cierre de brecha puede licuar posiciones en CEDEARs.';
  } else if (brecha >= 25) {
    nivel = 'MODERADA';
    sesgo = 'neutral';
    recomendacion = 'Brecha moderada: equilibrio entre locales y CEDEARs. Seguí momentum.';
  } else if (brecha >= 10) {
    nivel = 'BAJA';
    sesgo = 'bullish_dolar';
    recomendacion = 'Brecha baja: buena ventana para dolarizar via MEP/CCL. Considerar posiciones en USD.';
  } else {
    nivel = 'MUY BAJA';
    sesgo = 'bullish_dolar';
    recomendacion = 'Brecha mínima: oportunidad de dolarización barata. Reducí exposición ARS.';
  }

  return { brecha, nivel, sesgo, recomendacion };
}

// ── 3. Performance feedback ───────────────────────────────────────────────────
// Analiza el trading_log para encontrar patrones ganadores/perdedores
// y darle feedback a Claude sobre qué funcionó
export function buildPerformanceFeedback(trades) {
  if (!trades || trades.length === 0) return null;

  // Parear compras con la siguiente venta del mismo símbolo
  const bySymbol = {};
  for (const t of trades) {
    if (!t.simbolo) continue;
    if (!bySymbol[t.simbolo]) bySymbol[t.simbolo] = [];
    bySymbol[t.simbolo].push(t);
  }

  const ciclos = []; // { sym, pnlPct, signals, motivo }

  for (const [sym, symTrades] of Object.entries(bySymbol)) {
    const sorted = symTrades.sort((a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0));
    const buys   = sorted.filter(t => t.accion?.includes('compra'));
    const sells  = sorted.filter(t => t.accion?.includes('venta'));

    for (const buy of buys) {
      if (!buy.precio || buy.precio <= 0) continue;
      const buyTime = new Date(buy.created_at ?? 0);
      const sell    = sells.find(s => new Date(s.created_at ?? 0) > buyTime && s.precio > 0);
      if (!sell) continue; // posición aún abierta

      const pnlPct = (sell.precio - buy.precio) / buy.precio * 100;
      ciclos.push({
        sym,
        pnlPct,
        won:     pnlPct > 0,
        signals: buy.senales ?? [],
        motivo:  sell.accion,
      });
    }
  }

  if (ciclos.length === 0) return null;

  const winCount = ciclos.filter(c => c.won).length;
  const winRate  = (winCount / ciclos.length * 100).toFixed(0);
  const avgReturn = (ciclos.reduce((s, c) => s + c.pnlPct, 0) / ciclos.length).toFixed(1);

  const winners = ciclos.filter(c => c.won).sort((a, b) => b.pnlPct - a.pnlPct);
  const losers  = ciclos.filter(c => !c.won).sort((a, b) => a.pnlPct - b.pnlPct);

  // Top señales ganadoras
  const sigScore = {}; // señal → { wins, total }
  for (const c of ciclos) {
    for (const sig of c.signals) {
      const key = normalizeSignal(sig);
      if (!key) continue;
      if (!sigScore[key]) sigScore[key] = { wins: 0, total: 0 };
      sigScore[key].total++;
      if (c.won) sigScore[key].wins++;
    }
  }

  const topSignals = Object.entries(sigScore)
    .filter(([, v]) => v.total >= 2)
    .map(([sig, v]) => ({ sig, winRate: v.wins / v.total * 100, total: v.total }))
    .sort((a, b) => b.winRate - a.winRate);

  return {
    total:       ciclos.length,
    winRate,
    avgReturn,
    bestTrade:   winners[0] ?? null,
    worstTrade:  losers[0]  ?? null,
    topSignals:  topSignals.slice(0, 5),
    weakSignals: [...topSignals].reverse().slice(0, 3),
  };
}

// Normaliza el texto de una señal a un identificador corto
function normalizeSignal(sig) {
  if (!sig || typeof sig !== 'string') return null;
  if (sig.includes('MACD') && sig.includes('alza'))  return 'MACD_BULLISH';
  if (sig.includes('MACD') && sig.includes('baja'))  return 'MACD_BEARISH';
  if (sig.includes('RSI') && sig.includes('sobreventa')) return 'RSI_OVERSOLD';
  if (sig.includes('RSI') && sig.includes('sobrecompra')) return 'RSI_OVERBOUGHT';
  if (sig.includes('Golden') || sig.includes('cruzó sobre')) return 'GOLDEN_CROSS';
  if (sig.includes('Death')  || sig.includes('cruzó bajo'))  return 'DEATH_CROSS';
  if (sig.includes('Ruptura') && sig.includes('máximo'))     return 'BREAKOUT_HIGH';
  if (sig.includes('Ruptura') && sig.includes('mínimo'))     return 'BREAKOUT_LOW';
  if (sig.includes('soporte'))     return 'NEAR_SUPPORT';
  if (sig.includes('resistencia')) return 'NEAR_RESISTANCE';
  if (sig.includes('VWAP') && sig.includes('alza')) return 'VWAP_BULLISH';
  if (sig.includes('VWAP') && sig.includes('baja')) return 'VWAP_BEARISH';
  if (sig.includes('banda inferior')) return 'BB_OVERSOLD';
  if (sig.includes('banda superior')) return 'BB_OVERBOUGHT';
  if (sig.includes('squeeze'))        return 'BB_SQUEEZE';
  if (sig.includes('Volumen'))        return 'HIGH_VOLUME';
  if (sig.startsWith('+') && sig.includes('%')) return 'INTRADAY_UP';
  if (sig.includes('%') && sig.startsWith('-')) return 'INTRADAY_DOWN';
  if (sig.includes('RSI semanal') && sig.includes('sobreventa')) return 'WEEKLY_OVERSOLD';
  if (sig.includes('RSI semanal') && sig.includes('sobrecompra')) return 'WEEKLY_OVERBOUGHT';
  return null;
}

// ── Formateo para el prompt de Claude ────────────────────────────────────────
export function formatAlphaContext(mervalUSD, brechaAnalysis, perfFeedback, dolar) {
  const parts = [];

  // Brecha
  if (brechaAnalysis) {
    parts.push(
      `BRECHA CAMBIARIA: ${brechaAnalysis.brecha.toFixed(1)}% (${brechaAnalysis.nivel})\n` +
      `→ ${brechaAnalysis.recomendacion}`
    );
  }

  // Merval en USD
  if (mervalUSD) {
    const trend = mervalUSD.vsMA20Pct != null
      ? (mervalUSD.vsMA20Pct > 5  ? `📈 +${mervalUSD.vsMA20Pct.toFixed(1)}% sobre MA20 (momentum alcista en USD)`
       : mervalUSD.vsMA20Pct < -5 ? `📉 ${mervalUSD.vsMA20Pct.toFixed(1)}% bajo MA20 (zona de valor en USD)`
       : `↔️ cerca de MA20 (${mervalUSD.vsMA20Pct.toFixed(1)}%)`)
      : '';
    const top4 = mervalUSD.items.slice(0, 4).map(x => `${x.sym} $${x.usd.toFixed(2)}`).join(' | ');
    parts.push(
      `MERVAL EN USD (proxy panel líder, CCL $${dolar?.ccl?.toLocaleString('es-AR') ?? '?'}):\n` +
      `${trend} — ${mervalUSD.sobreVwap}/${mervalUSD.total} acciones sobre MA20 en USD\n` +
      `Precios: ${top4}`
    );
  }

  // Performance feedback
  if (perfFeedback) {
    const best  = perfFeedback.bestTrade  ? `Mejor: ${perfFeedback.bestTrade.sym} +${perfFeedback.bestTrade.pnlPct.toFixed(1)}%` : '';
    const worst = perfFeedback.worstTrade ? `Peor: ${perfFeedback.worstTrade.sym} ${perfFeedback.worstTrade.pnlPct.toFixed(1)}%` : '';
    const topSig = perfFeedback.topSignals.length > 0
      ? `Señales más exitosas: ${perfFeedback.topSignals.map(s => `${s.sig} (${s.winRate.toFixed(0)}% win, n=${s.total})`).join(', ')}`
      : '';
    const weakSig = perfFeedback.weakSignals.length > 0
      ? `Señales débiles: ${perfFeedback.weakSignals.map(s => `${s.sig} (${s.winRate.toFixed(0)}% win)`).join(', ')}`
      : '';

    parts.push(
      `HISTORIAL DE RENDIMIENTO (${perfFeedback.total} operaciones cerradas):\n` +
      `Win rate: ${perfFeedback.winRate}% | Retorno promedio: ${perfFeedback.avgReturn > 0 ? '+' : ''}${perfFeedback.avgReturn}%\n` +
      [best, worst, topSig, weakSig].filter(Boolean).join('\n') +
      `\n→ Priorizá las señales con mejor historial. Desconfiá de las débiles salvo confluencia fuerte.`
    );
  } else {
    parts.push('HISTORIAL: Sin suficientes operaciones cerradas aún para análisis de performance.');
  }

  return parts.join('\n\n');
}
