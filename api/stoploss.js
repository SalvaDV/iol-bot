import { getToken, getPortfolio, normalizePortfolio, crearOrden, roundToTick } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { logTrade } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const STOP_PCT   = 0.08;  // -8%  desde PPC → venta automática
const PROFIT_PCT = 0.30;  // +30% desde PPC → toma de ganancias automática

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

  const stopMsgs   = [];
  const profitMsgs = [];

  for (const pos of posiciones) {
    if (!pos.ppc || pos.ppc <= 0)               continue;
    if (!pos.ultimoPrecio || pos.ultimoPrecio <= 0) continue;
    if (!pos.cantidad || pos.cantidad <= 0)     continue;

    const pnlPct   = (pos.ultimoPrecio - pos.ppc) / pos.ppc;
    const pnlMonto = ((pos.ultimoPrecio - pos.ppc) * pos.cantidad)
                       .toLocaleString('es-AR', { maximumFractionDigits: 0 });

    if (pnlPct <= -STOP_PCT) {
      const result = await autoVender(token, pos, 'stoploss');
      if (result.ok) {
        stopMsgs.push(
          `🔴 *${pos.simbolo}* — VENTA AUTO (stop-loss)\n` +
          `PPC $${pos.ppc.toLocaleString('es-AR')} → $${pos.ultimoPrecio.toLocaleString('es-AR')} ` +
          `(${(pnlPct * 100).toFixed(1)}%)\n` +
          `P&L: $${pnlMonto} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
        );
      } else {
        stopMsgs.push(
          `🔴 *${pos.simbolo}* cayó *${(pnlPct * 100).toFixed(1)}%* desde compra\n` +
          `⚠️ No se pudo auto-vender: ${result.error}\n` +
          `Vendé manualmente en IOL.`
        );
      }
    } else if (pnlPct >= PROFIT_PCT) {
      const result = await autoVender(token, pos, 'takeprofit');
      if (result.ok) {
        profitMsgs.push(
          `🟢 *${pos.simbolo}* — VENTA AUTO (take-profit +${(pnlPct * 100).toFixed(1)}%)\n` +
          `PPC $${pos.ppc.toLocaleString('es-AR')} → $${pos.ultimoPrecio.toLocaleString('es-AR')}\n` +
          `Ganancia: $${pnlMonto} ARS | Orden @ $${result.precio.toLocaleString('es-AR')}`
        );
      } else {
        profitMsgs.push(
          `🟢 *${pos.simbolo}* +${(pnlPct * 100).toFixed(1)}% — TAKE-PROFIT\n` +
          `⚠️ No se pudo auto-vender: ${result.error}`
        );
      }
    }
  }

  if (stopMsgs.length > 0) {
    await sendMessage(`🚨 *AUTO STOP-LOSS*\n\n${stopMsgs.join('\n\n')}`);
  }
  if (profitMsgs.length > 0) {
    await sendMessage(`💰 *AUTO TAKE-PROFIT*\n\n${profitMsgs.join('\n\n')}`);
  }
}
