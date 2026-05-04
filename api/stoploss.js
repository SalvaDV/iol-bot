import { getToken, getPortfolio, normalizePortfolio, crearOrden, roundToTick } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { logTrade, getPositionHighs, upsertPositionHigh, deletePositionHigh } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const STOP_PCT    = 0.08;  // -8%  desde PPC → stop-loss fijo
const PROFIT_PCT  = 0.30;  // +30% desde PPC → take-profit
const TRAIL_PCT   = 0.08;  // -8%  desde el máximo histórico → trailing stop

export default async function handler(req, res) {
  res.status(200).end('ok');
  try {
    await checkPositions();
  } catch (err) {
    console.error('[monitor]', err.message);
  }
}

async function autoVender(token, pos, motivo) {
  const precioLimite = roundToTick(pos.ultimoPrecio * 0.99, 'venta');
  try {
    await crearOrden(token, {
      simbolo:   pos.simbolo,
      cantidad:  pos.cantidad,
      precio:    precioLimite,
      operacion: 'venta',
    });
    await logTrade({
      fecha:        new Date().toISOString().slice(0, 10),
      hora:         new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      simbolo:      pos.simbolo,
      accion:       `venta_auto_${motivo}`,
      precio:       precioLimite,
      cantidad:     pos.cantidad,
      monto:        Math.round(precioLimite * pos.cantidad),
      senales:      [`auto:${motivo}`],
      efectivo_pre: 0,
    }).catch(() => {});
    return { ok: true, precio: precioLimite };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkPositions() {
  const token     = await getToken();
  const portfolio = await getPortfolio(token);
  const posiciones = normalizePortfolio(portfolio);

  // Máximos históricos persistidos (para trailing stop)
  const highs = await getPositionHighs().catch(() => ({}));

  const stopMsgs   = [];
  const profitMsgs = [];
  const trailMsgs  = [];

  const activeSymbols = new Set();

  for (const pos of posiciones) {
    if (!pos.ppc || pos.ppc <= 0)                  continue;
    if (!pos.ultimoPrecio || pos.ultimoPrecio <= 0) continue;
    if (!pos.cantidad || pos.cantidad <= 0)         continue;

    const sym      = pos.simbolo;
    const precio   = pos.ultimoPrecio;
    const pnlPct   = (precio - pos.ppc) / pos.ppc;
    const pnlMonto = ((precio - pos.ppc) * pos.cantidad)
                       .toLocaleString('es-AR', { maximumFractionDigits: 0 });

    activeSymbols.add(sym);

    // ── Actualizar máximo histórico ─────────────────────────────────────────
    const prevHigh = highs[sym] ?? precio;
    const newHigh  = Math.max(prevHigh, precio);
    if (newHigh > (highs[sym] ?? 0)) {
      await upsertPositionHigh(sym, newHigh).catch(() => {});
      highs[sym] = newHigh;
    }

    // ── 1. Stop-loss fijo: -8% desde PPC ───────────────────────────────────
    if (pnlPct <= -STOP_PCT) {
      const result = await autoVender(token, pos, 'stoploss');
      await deletePositionHigh(sym).catch(() => {});
      if (result.ok) {
        stopMsgs.push(
          `🔴 *${sym}* — VENTA AUTO (stop-loss)\n` +
          `PPC $${pos.ppc.toLocaleString('es-AR')} → $${precio.toLocaleString('es-AR')} ` +
          `(${(pnlPct * 100).toFixed(1)}%)\n` +
          `P&L: $${pnlMonto} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
        );
      } else {
        stopMsgs.push(
          `🔴 *${sym}* cayó *${(pnlPct * 100).toFixed(1)}%* desde compra\n` +
          `⚠️ No se pudo auto-vender: ${result.error}\n` +
          `Vendé manualmente en IOL.`
        );
      }
      continue; // ya procesada
    }

    // ── 2. Take-profit: +30% desde PPC ─────────────────────────────────────
    if (pnlPct >= PROFIT_PCT) {
      const result = await autoVender(token, pos, 'takeprofit');
      await deletePositionHigh(sym).catch(() => {});
      if (result.ok) {
        profitMsgs.push(
          `🟢 *${sym}* — VENTA AUTO (take-profit +${(pnlPct * 100).toFixed(1)}%)\n` +
          `PPC $${pos.ppc.toLocaleString('es-AR')} → $${precio.toLocaleString('es-AR')}\n` +
          `Ganancia: $${pnlMonto} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
        );
      } else {
        profitMsgs.push(
          `🟢 *${sym}* +${(pnlPct * 100).toFixed(1)}% — TAKE-PROFIT\n` +
          `⚠️ No se pudo auto-vender: ${result.error}`
        );
      }
      continue;
    }

    // ── 3. Trailing stop: -8% desde máximo histórico (solo si está en ganancia) ──
    // Solo activamos trailing stop si la posición llegó a tener al menos +5% de ganancia
    if (pnlPct > 0 && highs[sym] && highs[sym] > pos.ppc * 1.05) {
      const trailTrigger = highs[sym] * (1 - TRAIL_PCT);
      if (precio <= trailTrigger) {
        const retrocesoPct = ((highs[sym] - precio) / highs[sym]) * 100;
        const result = await autoVender(token, pos, 'trailing');
        await deletePositionHigh(sym).catch(() => {});
        if (result.ok) {
          trailMsgs.push(
            `🟡 *${sym}* — VENTA AUTO (trailing stop)\n` +
            `Máximo: $${highs[sym].toLocaleString('es-AR')} → Actual: $${precio.toLocaleString('es-AR')} ` +
            `(-${retrocesoPct.toFixed(1)}% desde el pico)\n` +
            `P&L total: $${pnlMonto} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
          );
        } else {
          trailMsgs.push(
            `🟡 *${sym}* retrocedió ${retrocesoPct.toFixed(1)}% desde su máximo\n` +
            `⚠️ No se pudo auto-vender: ${result.error}`
          );
        }
      }
    }
  }

  // Limpiar máximos de posiciones que ya no están en cartera
  for (const sym of Object.keys(highs)) {
    if (!activeSymbols.has(sym)) {
      await deletePositionHigh(sym).catch(() => {});
    }
  }

  if (stopMsgs.length > 0)
    await sendMessage(`🚨 *AUTO STOP-LOSS*\n\n${stopMsgs.join('\n\n')}`);
  if (profitMsgs.length > 0)
    await sendMessage(`💰 *AUTO TAKE-PROFIT*\n\n${profitMsgs.join('\n\n')}`);
  if (trailMsgs.length > 0)
    await sendMessage(`🟡 *AUTO TRAILING STOP*\n\n${trailMsgs.join('\n\n')}`);
}
