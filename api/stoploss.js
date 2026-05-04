import { getToken, getPortfolio, normalizePortfolio, crearOrden, roundToTick } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { logTrade, getPositionHighs, upsertPositionHigh, deletePositionHigh, addCooldown } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const STOP_PCT      = 0.08;  // -8%  stop-loss fijo desde PPC
const PARTIAL_1_PCT = 0.15;  // +15% → vender 50%  (recuperar capital)
const PARTIAL_2_PCT = 0.20;  // +20% → vender 25%  (50% del resto)
const TRAIL_PCT     = 0.08;  // -8%  desde el máximo → trailing stop (maneja el 25% restante sin límite)

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
  const highs      = await getPositionHighs().catch(() => ({}));

  const stopMsgs     = [];
  const partialMsgs  = [];
  const trailMsgs    = [];
  const activeSymbols = new Set();

  for (const pos of posiciones) {
    if (!pos.ppc || pos.ppc <= 0)                  continue;
    if (!pos.ultimoPrecio || pos.ultimoPrecio <= 0) continue;
    if (!pos.cantidad || pos.cantidad <= 0)         continue;

    const sym    = pos.simbolo;
    const precio = pos.ultimoPrecio;
    const pnlPct = (precio - pos.ppc) / pos.ppc;
    const state  = highs[sym] ?? {
      high_price: precio, partial_1_taken: false, partial_2_taken: false,
    };

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

    // ── 2. Toma parcial 1: +15% → vender 50% ───────────────────────────────
    // IMPORTANTE: usamos `continue` al final para no procesar parcial_2 en el mismo
    // run — evita doble venta si el precio salta >+20% de golpe.
    if (pnlPct >= PARTIAL_1_PCT && !state.partial_1_taken) {
      const qty1 = Math.floor(pos.cantidad / 2);
      if (qty1 >= 1) {
        const result = await autoVender(token, pos, 'parcial_1', qty1);
        if (result.ok) {
          const newState = { ...state, partial_1_taken: true, partial_1_qty: qty1, partial_1_price: result.precio };
          await upsertPositionHigh(sym, newState).catch(() => {});
          const ganancia = ((result.precio - pos.ppc) * qty1).toLocaleString('es-AR', { maximumFractionDigits: 0 });
          partialMsgs.push(
            `🏦 *${sym}* — 1ª TOMA +${(pnlPct * 100).toFixed(1)}%\n` +
            `Vendí ${qty1} u. (50%) @ $${result.precio.toLocaleString('es-AR')} — +$${ganancia} ARS\n` +
            `Quedan ${pos.cantidad - qty1} u. | Próxima toma a +20%`
          );
        }
      }
      continue; // ← próximo run manejará la parcial_2 con cantidad ya actualizada en IOL
    }

    // ── 3. Toma parcial 2: +20% → vender 50% de lo que queda (25% original) ─
    // Solo llega aquí si partial_1 ya fue tomada en un run anterior (cantidad ya reducida en IOL)
    if (pnlPct >= PARTIAL_2_PCT && state.partial_1_taken && !state.partial_2_taken) {
      const qty2 = Math.floor(pos.cantidad / 2);
      if (qty2 >= 1) {
        const result = await autoVender(token, pos, 'parcial_2', qty2);
        if (result.ok) {
          const newState = { ...state, partial_2_taken: true, partial_2_qty: qty2, partial_2_price: result.precio };
          await upsertPositionHigh(sym, newState).catch(() => {});
          Object.assign(state, newState);
          const ganancia = ((result.precio - pos.ppc) * qty2).toLocaleString('es-AR', { maximumFractionDigits: 0 });
          partialMsgs.push(
            `🏦 *${sym}* — 2ª TOMA +${(pnlPct * 100).toFixed(1)}%\n` +
            `Vendí ${qty2} u. (25% original) @ $${result.precio.toLocaleString('es-AR')} — +$${ganancia} ARS\n` +
            `Quedan ${pos.cantidad - qty2} u. libres 🚀 — trailing stop activo`
          );
        }
      }
      continue; // ← trailing stop se maneja en el próximo run
    }

    // ── 4. Trailing stop: -8% desde máximo (maneja el free runner) ──────────
    // Se activa cuando la posición llegó al menos a +5% en algún momento
    if (pnlPct > 0 && state.high_price > pos.ppc * 1.05) {
      const trailTrigger = state.high_price * (1 - TRAIL_PCT);
      if (precio <= trailTrigger) {
        const retrocesoPct = ((state.high_price - precio) / state.high_price) * 100;
        const result       = await autoVender(token, pos, 'trailing');
        await deletePositionHigh(sym).catch(() => {});
        const pnlStr = ((precio - pos.ppc) * pos.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 0 });
        trailMsgs.push(result.ok
          ? `🟡 *${sym}* — TRAILING STOP (-${retrocesoPct.toFixed(1)}% desde pico $${state.high_price.toLocaleString('es-AR')})\nCierre @ $${result.precio.toLocaleString('es-AR')} | P&L acumulado: +$${pnlStr} ARS`
          : `🟡 *${sym}* retrocedió ${retrocesoPct.toFixed(1)}% desde su máximo — no se pudo vender: ${result.error}`
        );
      }
    }
  }

  // Limpiar registros de símbolos que ya no están en cartera
  for (const sym of Object.keys(highs)) {
    if (!activeSymbols.has(sym)) await deletePositionHigh(sym).catch(() => {});
  }

  if (stopMsgs.length   > 0) await sendMessage(`🚨 *AUTO STOP-LOSS*\n\n${stopMsgs.join('\n\n')}`);
  if (partialMsgs.length > 0) await sendMessage(`🏦 *TOMA PARCIAL DE GANANCIAS*\n\n${partialMsgs.join('\n\n')}`);
  if (trailMsgs.length  > 0) await sendMessage(`🟡 *AUTO TRAILING STOP*\n\n${trailMsgs.join('\n\n')}`);
}
