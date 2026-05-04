import { getToken, getPortfolio, getCuenta, normalizePortfolio } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { getRecentTrades } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.status(200).end('ok');

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  if (now.getDay() === 0 || now.getDay() === 6) return;

  try {
    await runDailySummary();
  } catch (err) {
    console.error('[summary]', err.message);
    await sendMessage(`❌ Error en resumen diario: ${err.message}`).catch(() => {});
  }
}

async function runDailySummary() {
  const token = await getToken();

  const [portfolio, cuenta, trades] = await Promise.all([
    getPortfolio(token),
    getCuenta(token),
    getRecentTrades(50),
  ]);

  const c0 = cuenta.cuentas?.[0];
  const c1 = cuenta.cuentas?.[1];
  const cuentaPesos = [c0, c1].find(c => c?.moneda?.toLowerCase?.().includes('peso')) ??
                      [c0, c1].sort((a, b) => (b?.disponible ?? 0) - (a?.disponible ?? 0))[0];
  const efectivo = cuentaPesos?.disponible ?? cuentaPesos?.saldo ?? cuenta.disponible ?? 0;

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
          ? (parseFloat(pnlPct) >= 0 ? ` | P&L +${pnlPct}%` : ` | P&L ${pnlPct}%`)
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

  // ── Emoji P&L ─────────────────────────────────────────────────────────────
  const pnlEmoji  = pnlDia >= 0 ? '🟢' : '🔴';
  const pnlStr    = `${pnlDia >= 0 ? '+' : ''}$${pnlDia.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS`;

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
    `*Operaciones de hoy (${todayTrades.length}):*\n${tradeLines}`;

  await sendMessage(msg);
}
