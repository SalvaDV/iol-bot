import { getToken, getPortfolio, getCuenta, getCotizacion, extractPrecio, normalizePortfolio, extractEfectivo } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { getRecentTrades, getPendingOutcomes7d, getPendingOutcomes30d, updateOutcome7d, updateOutcome30d, getPerformanceStats } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  res.status(200).end('ok');

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  if (now.getDay() === 0 || now.getDay() === 6) return;

  try {
    await evaluateOutcomes();
    await runDailySummary();
  } catch (err) {
    console.error('[summary]', err.message);
    await sendMessage(`❌ Error en resumen diario: ${err.message}`).catch(() => {});
  }
}

/**
 * Evalúa propuestas pasadas vs precio actual:
 * - Propuestas de hace 7+ días → guarda retorno_7d
 * - Propuestas de hace 30+ días → guarda retorno_30d
 */
async function evaluateOutcomes() {
  const token = await getToken();

  const [pending7d, pending30d] = await Promise.all([
    getPendingOutcomes7d().catch(() => []),
    getPendingOutcomes30d().catch(() => []),
  ]);

  // Evaluar a 7 días
  for (const p of pending7d) {
    try {
      const cot  = await getCotizacion(token, p.simbolo);
      const now  = extractPrecio(cot);
      if (!now || !p.precio_prop || p.precio_prop <= 0) continue;
      const retorno = ((now - p.precio_prop) / p.precio_prop) * 100;
      await updateOutcome7d(p.id, now, parseFloat(retorno.toFixed(2)));
      console.log(`[summary] outcome 7d ${p.simbolo} ${p.dir}: ${retorno.toFixed(1)}%`);
    } catch (e) {
      console.log(`[summary] outcome 7d ${p.simbolo} error:`, e.message);
    }
  }

  // Evaluar a 30 días
  for (const p of pending30d) {
    try {
      const cot  = await getCotizacion(token, p.simbolo);
      const now  = extractPrecio(cot);
      if (!now || !p.precio_prop || p.precio_prop <= 0) continue;
      const retorno = ((now - p.precio_prop) / p.precio_prop) * 100;
      await updateOutcome30d(p.id, now, parseFloat(retorno.toFixed(2)));
      console.log(`[summary] outcome 30d ${p.simbolo} ${p.dir}: ${retorno.toFixed(1)}%`);
    } catch (e) {
      console.log(`[summary] outcome 30d ${p.simbolo} error:`, e.message);
    }
  }
}

async function runDailySummary() {
  const token = await getToken();

  const [portfolio, cuenta, trades, perfStats] = await Promise.all([
    getPortfolio(token),
    getCuenta(token),
    getRecentTrades(50),
    getPerformanceStats().catch(() => null),
  ]);

  // Efectivo correcto: hrs24.disponibleOperar incluye T+0 + T+1
  const efectivo = extractEfectivo(cuenta);

  const titulos   = normalizePortfolio(portfolio);
  const today     = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const todayTrades = trades.filter(t => t.fecha === today);

  // ── P&L del día (trades de hoy) ───────────────────────────────────────────
  let pnlDia = 0;
  for (const t of todayTrades) {
    if (!t.monto) continue;
    if (t.accion?.includes('venta'))  pnlDia += t.monto;
    if (t.accion?.includes('compra')) pnlDia -= t.monto;
  }

  // ── Valor total del portafolio ────────────────────────────────────────────
  const valorCartera = titulos.reduce((s, t) => {
    return s + (t.cantidad && t.ultimoPrecio ? t.cantidad * t.ultimoPrecio : 0);
  }, 0);
  const totalNeto = valorCartera + efectivo;

  // ── Resumen de posiciones ─────────────────────────────────────────────────
  const posLines = titulos.length > 0
    ? titulos.map(t => {
        const valor  = t.cantidad && t.ultimoPrecio ? t.cantidad * t.ultimoPrecio : 0;
        const pnlPct = t.ppc && t.ppc > 0 && t.ultimoPrecio
          ? ((t.ultimoPrecio - t.ppc) / t.ppc * 100).toFixed(1)
          : null;
        const pnlTag = pnlPct != null
          ? (parseFloat(pnlPct) >= 0 ? ` | P&L *+${pnlPct}%*` : ` | P&L *${pnlPct}%*`)
          : '';
        return `• *${t.simbolo}*: ${t.cantidad} u. @ $${(t.ultimoPrecio ?? 0).toLocaleString('es-AR')} — $${valor.toLocaleString('es-AR', { maximumFractionDigits: 0 })}${pnlTag}`;
      }).join('\n')
    : '_Sin posiciones abiertas_';

  // ── Operaciones del día ───────────────────────────────────────────────────
  const tradeLines = todayTrades.length > 0
    ? todayTrades.map(t =>
        `• ${t.accion?.toUpperCase()} *${t.simbolo}* x${t.cantidad} @ $${t.precio} — $${t.monto?.toLocaleString('es-AR')}`
      ).join('\n')
    : '_Ninguna_';

  // ── Accuracy del advisor (últimas 30 propuestas evaluadas a 7d) ───────────
  let accuracyBlock = '';
  if (perfStats) {
    const c = perfStats.compras;
    const v = perfStats.ventas;
    const lines = [];
    if (c?.n) lines.push(`📈 Compras: *${c.rate}%* acierto (${c.hits}/${c.n}) | avg *${c.avg}%* a 7d`);
    if (v?.n) lines.push(`📉 Ventas:  *${v.rate}%* acierto (${v.hits}/${v.n}) | avg *${v.avg}%* a 7d`);
    if (lines.length) {
      accuracyBlock = `\n\n🎯 *Accuracy del advisor (últimas ${perfStats.total} props):*\n${lines.join('\n')}`;
    }
  }

  // ── Emoji P&L ─────────────────────────────────────────────────────────────
  const pnlEmoji = pnlDia >= 0 ? '🟢' : '🔴';
  const pnlStr   = `${pnlDia >= 0 ? '+' : ''}$${pnlDia.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS`;

  const hora = new Date().toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit',
  });

  const msg =
    `📊 *RESUMEN DE CIERRE — ${today}* (${hora})\n\n` +
    `${pnlEmoji} *P&L del día:* ${pnlStr}\n` +
    `💼 *Cartera:* $${valorCartera.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS\n` +
    `💵 *Efectivo:* $${efectivo.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS\n` +
    `🏦 *Total neto:* $${totalNeto.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS\n\n` +
    `*Posiciones:*\n${posLines}\n\n` +
    `*Operaciones de hoy (${todayTrades.length}):*\n${tradeLines}` +
    accuracyBlock;

  await sendMessage(msg);
}
