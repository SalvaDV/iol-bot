import { getToken, getPortfolio, normalizePortfolio, crearOrden, roundToTick } from '../lib/iol.js';
import { sendMessage, sendMessageWithButtons } from '../lib/telegram.js';
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

    // ── 1. Stop-loss fijo: -8% desde PPC — AUTO (urgente, no preguntar) ───────
    if (pnlPct <= -STOP_PCT) {
      const result = await autoVender(token, pos, 'stoploss');
      await deletePositionHigh(sym).catch(() => {});
      await addCooldown(sym, 24, 'stoploss').catch(() => {});
      const pnlStr = ((precio - pos.ppc) * pos.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 0 });
      stopMsgs.push(result.ok
        ? `🔴 *${sym}* — STOP-LOSS EJECUTADO\n` +
          `PPC $${pos.ppc.toLocaleString('es-AR')} → actual $${precio.toLocaleString('es-AR')} (${(pnlPct * 100).toFixed(1)}%)\n` +
          `Vendí *${pos.cantidad} u.* @ $${result.precio.toLocaleString('es-AR')}\n` +
          `P&L: *$${pnlStr} ARS* | Cooldown 24hs`
        : `🔴 *${sym}* cayó *${(pnlPct * 100).toFixed(1)}%* — ⚠️ ERROR al vender: ${result.error}\n_Revisá IOL manualmente._`
      );
      continue;
    }

    // ── 2. Toma parcial 1: +15% → PREGUNTAR antes de vender ────────────────
    if (pnlPct >= PARTIAL_1_PCT && !state.partial_1_taken && !state.partial_1_alerted) {
      const qty1     = Math.floor(pos.cantidad / 2);
      if (qty1 >= 1) {
        const precioRef = roundToTick(precio * 0.99, 'venta');
        const ganancia  = ((precioRef - pos.ppc) * qty1).toLocaleString('es-AR', { maximumFractionDigits: 0 });
        await sendMessageWithButtons(
          `🎯 *TOMA DE GANANCIAS — ${sym}*\n\n` +
          `📈 *+${(pnlPct * 100).toFixed(1)}%* desde tu entrada\n` +
          `PPC: $${pos.ppc.toLocaleString('es-AR')} → actual $${precio.toLocaleString('es-AR')}\n\n` +
          `Propuesta: vender *${qty1} u.* (50%) @ ~$${precioRef.toLocaleString('es-AR')}\n` +
          `↳ Ganancia estimada: *+$${ganancia} ARS*\n\n` +
          `Las ${pos.cantidad - qty1} u. restantes quedan libres (trailing stop activo a +20%).`,
          [[
            { text: '✅ Sí, vender 50%', callback_data: `tp_sell:${sym}:${qty1}:${precioRef}:1` },
            { text: '⏭️ Dejar correr', callback_data: `tp_ignore:${sym}:1` },
          ]]
        );
        await upsertPositionHigh(sym, { ...state, partial_1_alerted: true }).catch(() => {});
      }
      continue;
    }

    // ── 3. Toma parcial 2: +20% → PREGUNTAR antes de vender ────────────────
    if (pnlPct >= PARTIAL_2_PCT && state.partial_1_taken && !state.partial_2_taken && !state.partial_2_alerted) {
      const qty2     = Math.floor(pos.cantidad / 2);
      if (qty2 >= 1) {
        const precioRef = roundToTick(precio * 0.99, 'venta');
        const ganancia  = ((precioRef - pos.ppc) * qty2).toLocaleString('es-AR', { maximumFractionDigits: 0 });
        await sendMessageWithButtons(
          `🎯 *TOMA DE GANANCIAS 2 — ${sym}*\n\n` +
          `📈 *+${(pnlPct * 100).toFixed(1)}%* desde tu entrada\n` +
          `PPC: $${pos.ppc.toLocaleString('es-AR')} → actual $${precio.toLocaleString('es-AR')}\n\n` +
          `Propuesta: vender *${qty2} u.* (25% original) @ ~$${precioRef.toLocaleString('es-AR')}\n` +
          `↳ Ganancia estimada: *+$${ganancia} ARS*\n\n` +
          `Las unidades restantes siguen libres 🚀 con trailing stop activo.`,
          [[
            { text: '✅ Sí, vender 25%', callback_data: `tp_sell:${sym}:${qty2}:${precioRef}:2` },
            { text: '⏭️ Dejar correr', callback_data: `tp_ignore:${sym}:2` },
          ]]
        );
        await upsertPositionHigh(sym, { ...state, partial_2_alerted: true }).catch(() => {});
      }
      continue;
    }

    // ── 4. Trailing stop: -8% desde máximo — AUTO (proteger ganancias) ──────
    if (pnlPct > 0 && state.high_price > pos.ppc * 1.05) {
      const trailTrigger = state.high_price * (1 - TRAIL_PCT);
      if (precio <= trailTrigger) {
        const retrocesoPct = ((state.high_price - precio) / state.high_price) * 100;
        const result       = await autoVender(token, pos, 'trailing');
        await deletePositionHigh(sym).catch(() => {});
        const pnlStr = ((precio - pos.ppc) * pos.cantidad).toLocaleString('es-AR', { maximumFractionDigits: 0 });
        trailMsgs.push(result.ok
          ? `🟡 *${sym}* — TRAILING STOP EJECUTADO\n` +
            `Retrocedió *${retrocesoPct.toFixed(1)}%* desde pico $${state.high_price.toLocaleString('es-AR')}\n` +
            `Vendí *${pos.cantidad} u.* @ $${result.precio.toLocaleString('es-AR')}\n` +
            `P&L acumulado: *+$${pnlStr} ARS*`
          : `🟡 *${sym}* retrocedió ${retrocesoPct.toFixed(1)}% desde su pico — ⚠️ ERROR al vender: ${result.error}\n_Revisá IOL manualmente._`
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
