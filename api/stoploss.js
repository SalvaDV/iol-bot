import { getToken, getPortfolio } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const STOP_IOL = 0.08;  // 8% caída desde PPC → alerta

export default async function handler(req, res) {
  res.status(200).end('ok');
  try {
    await checkStopLoss();
  } catch (err) {
    console.error('[stoploss]', err.message);
  }
}

async function checkStopLoss() {
  const token = await getToken();
  const portfolio = await getPortfolio(token);
  const alertas = [];

  for (const pos of portfolio.titulos ?? []) {
    const ppc = pos.ppc ?? pos.precioPromedio ?? pos.costoPromedio ?? null;
    if (!ppc || ppc <= 0) continue;

    const precioActual = pos.ultimoPrecio ?? pos.precioActual ?? null;
    if (!precioActual || precioActual <= 0) continue;

    const caida = (ppc - precioActual) / ppc;
    if (caida >= STOP_IOL) {
      const pnlMonto = ((precioActual - ppc) * (pos.cantidad ?? 0)).toLocaleString('es-AR');
      alertas.push(
        `🔴 *${pos.simbolo}* cayó *${(caida * 100).toFixed(1)}%* desde tu compra\n` +
        `   PPC $${ppc.toLocaleString('es-AR')} → $${precioActual.toLocaleString('es-AR')} | P&L: $${pnlMonto} ARS`
      );
    }
  }

  if (alertas.length === 0) return;

  await sendMessage(
    `🚨🔴 *ALERTA STOP-LOSS*\n\n` +
    alertas.join('\n\n') + `\n\n` +
    `⚡ Mandá */analizar* para contexto completo o */si N* si ya tenés propuestas de venta.`
  );
}
