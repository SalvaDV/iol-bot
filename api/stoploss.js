import { getToken, getPortfolio, normalizePortfolio, crearOrden, roundToTick } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { logTrade, getPositionHighs, upsertPositionHigh, deletePositionHigh, addCooldown } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const STOP_PCT         = 0.08;  // -8%  desde PPC → stop-loss fijo
const PARTIAL_PCT      = 0.15;  // +15% desde PPC → toma parcial (50%)
const PROFIT_PCT       = 0.30;  // +30% desde PPC → take-profit total
const TRAIL_PCT        = 0.08;  // -8%  desde el máximo → trailing stop

export default async function handler(req, res) {
  res.status(200).end('ok');
  try {
    await checkPositions();
  } catch (err) {
    console.error('[monitor]', err.message);
  }
}

async function autoVender(token, pos, motivo, cantidadOverride = null) {
  const cantidad     = cantidadOverride ?? pos.cantidad;
  const precioLimite = roundToTick(pos.ultimoPrecio * 0.99, 'venta');
  try {
    await crearOrden(token, {
      simbolo: pos.simbolo, cantidad, precio: precioLimite, operacion: 'venta',
    });
    await logTrade({
      fecha:        new Date().toISOString().slice(0, 10),
      hora:         new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      simbolo:      pos.simbolo,
      accion:       `venta_auto_${motivo}`,
      precio:       precioLimite,
      cantidad,
      monto:        Math.round(precioLimite * cantidad),
      senales:      [`auto:${motivo}`],
      efectivo_pre: 0,
    }).catch(() => {});
    return { ok: true, precio: precioLimite };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkPositions() {
  const token      = await getToken();
  const portfolio  = await getPortfolio(token);
  const posiciones = normalizePortfolio(portfolio);

  // Estado persistido por símbolo: { high_price, partial_taken, partial_qty, partial_price }
  const highs = await getPositionHighs().catch(() => ({}));

  const stopMsgs    = [];
  const partialMsgs = [];
  const profitMsgs  = [];
  const trailMsgs   = [];
  const activeSymbols = new Set();

  for (const pos of posiciones) {
    if (!pos.ppc || pos.ppc <= 0)                  continue;
    if (!pos.ultimoPrecio || pos.ultimoPrecio <= 0) continue;
    if (!pos.cantidad || pos.cantidad <= 0)         continue;

    const sym    = pos.simbolo;
    const precio = pos.ultimoPrecio;
    const pnlPct = (precio - pos.ppc) / pos.ppc;
    const state  = highs[sym] ?? { high_price: precio, partial_taken: false };

    activeSymbols.add(sym);

    // ── Actualizar máximo histórico ─────────────────────────────────────────
    const newHigh = Math.max(state.high_price ?? precio, precio);
    if (newHigh > (state.high_price ?? 0)) {
      await upsertPositionHigh(sym, { ...state, high_price: newHigh }).catch(() => {});
      state.high_price = newHigh;
    }

    // ── 1. Stop-loss fijo: -8% desde PPC ───────────────────────────────────
    if (pnlPct <= -STOP_PCT) {
      const result = await autoVender(token, pos, 'stoploss');
      await deletePositionHigh(sym).catch(() => {});
      await addCooldown(sym, 24, 'stoploss').catch(() => {});
      const pnlStr = ((precio - pos.ppc) * pos.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 0 });
      stopMsgs.push(result.ok
        ? `🔴 *${sym}* — STOP-LOSS\nPPC $${pos.ppc.toLocaleString('es-AR')} → $${precio.toLocaleString('es-AR')} (${(pnlPct * 100).toFixed(1)}%)\nP&L: $${pnlStr} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
        : `🔴 *${sym}* cayó *${(pnlPct * 100).toFixed(1)}%* — no se pudo vender: ${result.error}`
      );
      continue;
    }

    // ── 2. Take-profit total: +30% desde PPC ───────────────────────────────
    if (pnlPct >= PROFIT_PCT) {
      const result = await autoVender(token, pos, 'takeprofit');
      await deletePositionHigh(sym).catch(() => {});
      const pnlStr = ((precio - pos.ppc) * pos.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 0 });
      profitMsgs.push(result.ok
        ? `🟢 *${sym}* — TAKE-PROFIT +${(pnlPct * 100).toFixed(1)}%\nGanancia: $${pnlStr} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
        : `🟢 *${sym}* +${(pnlPct * 100).toFixed(1)}% — no se pudo vender: ${result.error}`
      );
      continue;
    }

    // ── 3. Toma parcial: +15% → vender 50%, dejar correr el resto ──────────
    if (pnlPct >= PARTIAL_PCT && !state.partial_taken) {
      const parcialQty = Math.floor(pos.cantidad / 2);
      if (parcialQty >= 1) {
        const result = await autoVender(token, pos, 'parcial', parcialQty);
        if (result.ok) {
          await upsertPositionHigh(sym, {
            ...state,
            partial_taken: true,
            partial_qty:   parcialQty,
            partial_price: result.precio,
          }).catch(() => {});
          state.partial_taken = true;
          const ganancia = ((result.precio - pos.ppc) * parcialQty).toLocaleString('es-AR', { maximumFractionDigits: 0 });
          partialMsgs.push(
            `🏦 *${sym}* — TOMA PARCIAL +${(pnlPct * 100).toFixed(1)}%\n` +
            `Vendí ${parcialQty} u. (50%) @ $${result.precio.toLocaleString('es-AR')} — ganancia $${ganancia} ARS\n` +
            `Quedan ${pos.cantidad - parcialQty} u. con trailing stop activo`
          );
        }
      }
      // No hacer continue: el resto de la posición sigue siendo monitoreado
    }

    // ── 4. Trailing stop: -8% desde máximo histórico ────────────────────────
    // Solo si la posición llegó a +5% en algún momento
    if (pnlPct > 0 && state.high_price > pos.ppc * 1.05) {
      const trailTrigger  = state.high_price * (1 - TRAIL_PCT);
      if (precio <= trailTrigger) {
        const retrocesoPct = ((state.high_price - precio) / state.high_price) * 100;
        const result       = await autoVender(token, pos, 'trailing');
        await deletePositionHigh(sym).catch(() => {});
        const pnlStr = ((precio - pos.ppc) * pos.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 0 });
        trailMsgs.push(result.ok
          ? `🟡 *${sym}* — TRAILING STOP (-${retrocesoPct.toFixed(1)}% desde pico)\nMáx: $${state.high_price.toLocaleString('es-AR')} → $${precio.toLocaleString('es-AR')} | P&L: $${pnlStr} ARS`
          : `🟡 *${sym}* retrocedió ${retrocesoPct.toFixed(1)}% desde su máximo — no se pudo vender: ${result.error}`
        );
      }
    }
  }

  // Limpiar registros de símbolos que ya no están en cartera
  for (const sym of Object.keys(highs)) {
    if (!activeSymbols.has(sym)) await deletePositionHigh(sym).catch(() => {});
  }

  if (stopMsgs.length    > 0) await sendMessage(`🚨 *AUTO STOP-LOSS*\n\n${stopMsgs.join('\n\n')}`);
  if (partialMsgs.length > 0) await sendMessage(`🏦 *TOMA PARCIAL DE GANANCIAS*\n\n${partialMsgs.join('\n\n')}`);
  if (profitMsgs.length  > 0) await sendMessage(`💰 *AUTO TAKE-PROFIT*\n\n${profitMsgs.join('\n\n')}`);
  if (trailMsgs.length   > 0) await sendMessage(`🟡 *AUTO TRAILING STOP*\n\n${trailMsgs.join('\n\n')}`);
}
