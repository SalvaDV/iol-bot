import { getToken, getPortfolio, normalizePortfolio, roundToTick } from '../lib/iol.js';
import { fetchAllTechnicals } from '../lib/analysis.js';
import { sendMessage, sendMessageWithButtons } from '../lib/telegram.js';
import { getCustomWatchlist, addCooldown } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 55 };

// Señales que disparan alerta — filtra ruido y prioriza entradas/salidas reales
const STRONG_SIGNALS = new Set([
  'MACD_BULLISH', 'MACD_BEARISH',
  'BB_OVERSOLD', 'BB_OVERBOUGHT',
  'RSI_OVERSOLD', 'RSI_OVERBOUGHT',
  'GOLDEN_CROSS', 'DEATH_CROSS',
]);

function bsAsHour() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })
  ).getHours();
}

export default async function handler(req, res) {
  res.status(200).end('ok');

  // Solo en horario de mercado BCBA: 11-17hs BsAs
  const hour = bsAsHour();
  if (hour < 11 || hour >= 17) {
    console.log('[scan] fuera de horario de mercado, skipping');
    return;
  }

  // Lunes a viernes
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  if (now.getDay() === 0 || now.getDay() === 6) return;

  try {
    await runQuickScan();
  } catch (err) {
    console.error('[scan]', err.message);
  }
}

// Señales que en conjunto invalidan la tesis de una posición → venta automática
const THESIS_INVALIDATED = new Set(['DEATH_CROSS', 'MACD_BEARISH']);

async function runQuickScan() {
  const token = await getToken();

  const [portfolio, customWatchlist] = await Promise.all([
    getPortfolio(token),
    getCustomWatchlist().catch(() => []),
  ]);

  const posiciones   = normalizePortfolio(portfolio);
  const portfolioMap = new Map(posiciones.map(t => [t.simbolo, t]));
  const customSyms   = customWatchlist.map(w => w.simbolo?.toUpperCase()).filter(Boolean);

  // Análisis técnico completo (WATCHLIST + portafolio + watchlist personalizada)
  const technicals = await fetchAllTechnicals(token, [...portfolioMap.keys(), ...customSyms]);

  const compras      = [];
  const ventas       = [];
  const autoVentas   = [];

  for (const t of technicals) {
    if (!t?.signals?.length) continue;

    const pos         = portfolioMap.get(t.sym);
    const isPortfolio = !!pos;

    // ── Alerta urgente por tesis invalidada (solo posiciones en cartera) ──────
    if (isPortfolio && pos.cantidad > 0 && pos.ultimoPrecio > 0) {
      const invalidSignals = t.signals.filter(s => THESIS_INVALIDATED.has(s.type));
      // Necesita 2 señales de invalidación (ej: DEATH_CROSS + MACD_BEARISH) para evitar falsos
      if (invalidSignals.length >= 2) {
        const precioLimite = roundToTick(pos.ultimoPrecio * 0.99, 'venta');
        const montoEstimado = Math.round(pos.cantidad * precioLimite).toLocaleString('es-AR');
        await sendMessageWithButtons(
          `🚨 *ALERTA URGENTE — Tesis invalidada*\n\n` +
          `📉 *${t.sym}* está en tu cartera y sus señales técnicas se deterioraron gravemente:\n` +
          `↳ ${invalidSignals.map(s => s.detail).join(' | ')}\n\n` +
          `Posición: *${pos.cantidad} u. @ $${precioLimite.toLocaleString('es-AR')}* (≈$${montoEstimado} ARS)\n\n` +
          `⚠️ La tesis de compra ya no es válida. Cada hora de demora puede significar mayor pérdida.\n` +
          `¿Vendemos ahora?`,
          [[
            { text: '📉 Sí, vender', callback_data: `scan_sell:${t.sym}:${pos.cantidad}:${precioLimite}` },
            { text: '❌ No, mantener', callback_data: 'scan_ignore' },
          ]],
        );
        await addCooldown(t.sym, 12, 'tesis_invalidada').catch(() => {});
        autoVentas.push(t.sym);
        console.log(`[scan] alerta tesis invalidada: ${t.sym}`);
        continue;
      }
    }

    // ── Alertas informativas ─────────────────────────────────────────────────
    const strongCount = t.signals.filter(s => STRONG_SIGNALS.has(s.type)).length;
    if (strongCount === 0) continue;
    if (!isPortfolio && t.signals.length < 2) continue;

    const tag       = isPortfolio ? ' _(cartera)_' : '';
    const precioStr = t.ultimo != null ? `$${t.ultimo.toLocaleString('es-AR')}` : '?';
    const rsiStr    = t.rsi    != null ? ` | RSI ${t.rsi.toFixed(0)}` : '';
    const line      = `*${t.sym}*${tag} @ ${precioStr}${rsiStr}\n↳ ${t.signals.map(s => s.detail).join(' | ')}`;

    if (t.dir === 'compra') compras.push(line);
    else if (t.dir === 'venta') ventas.push(line);
    else compras.push(line);
  }

  const hora = new Date().toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit',
  });

  // Las alertas de tesis invalidada ya se enviaron con botones inline arriba

  if (compras.length === 0 && ventas.length === 0) {
    console.log('[scan] sin señales relevantes');
    return;
  }

  const partes = [];
  if (compras.length > 0) partes.push(`📈 *OPORTUNIDADES*\n${compras.join('\n\n')}`);
  if (ventas.length  > 0) partes.push(`📉 *SEÑALES DE VENTA*\n${ventas.join('\n\n')}`);

  await sendMessage(`🔍 *SCAN ${hora}*\n\n${partes.join('\n\n')}`);
}
