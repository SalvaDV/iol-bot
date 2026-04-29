import { getToken, getPortfolio } from '../lib/iol.js';
import { getCryptoPrices } from '../lib/crypto.js';
import { getRecentTrades } from '../lib/supabase.js';
import { sendMessage } from '../lib/telegram.js';
import { getBinancePrice, isBinanceConfigured } from '../lib/binance.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const STOP_IOL    = 0.08;  // 8% caída desde PPC → alerta
const STOP_CRYPTO = 0.10;  // 10% caída en crypto

export default async function handler(req, res) {
  res.status(200).end('ok');
  try {
    await checkStopLoss();
  } catch (err) {
    console.error('[stoploss]', err.message);
  }
}

async function checkStopLoss() {
  const alertas = [];

  // ── IOL: revisar posiciones vs PPC ──────────────────────────────────────
  try {
    const token = await getToken();
    const portfolio = await getPortfolio(token);

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
          `   PPC: $${ppc.toLocaleString('es-AR')} → Actual: $${precioActual.toLocaleString('es-AR')} | P&L: $${pnlMonto} ARS`
        );
      }
    }
  } catch (e) {
    console.log('[stoploss] IOL check error:', e.message);
  }

  // ── Crypto: revisar holdings del log vs precio actual ───────────────────
  try {
    const trades = await getRecentTrades(50);
    const holdings = {};

    for (const t of trades) {
      const sym = t.simbolo?.toUpperCase();
      if (!sym) continue;
      const esBuy  = t.accion === 'crypto_binance' || t.accion === 'crypto_manual';
      const esSell = t.accion === 'crypto_binance_venta' || t.accion === 'crypto_manual_venta';

      if (esBuy && t.precio > 0) {
        holdings[sym] = { precioCompra: t.precio, cantidad: t.cantidad ?? 0 };
      } else if (esSell) {
        delete holdings[sym];
      }
    }

    // Obtener precios actuales (Binance si configurado, si no CoinGecko)
    let cryptoPrices = null;
    if (!isBinanceConfigured()) {
      const { getCryptoPrices: gcg } = await import('../lib/crypto.js');
      cryptoPrices = await gcg();
    }

    const COINGECKO_MAP = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', MATIC: 'matic-network', ADA: 'cardano', DOGE: 'dogecoin' };

    for (const [sym, h] of Object.entries(holdings)) {
      if (!h.precioCompra) continue;

      let precioActual = null;
      if (isBinanceConfigured()) {
        precioActual = await getBinancePrice(sym);
      } else if (cryptoPrices) {
        const cgId = COINGECKO_MAP[sym];
        precioActual = cgId ? cryptoPrices[cgId]?.usd ?? null : null;
      }

      if (!precioActual) continue;
      const caida = (h.precioCompra - precioActual) / h.precioCompra;
      if (caida >= STOP_CRYPTO) {
        alertas.push(
          `🔴 *${sym}* cayó *${(caida * 100).toFixed(1)}%* desde tu compra\n` +
          `   Compra: $${h.precioCompra.toFixed(2)} → Actual: $${precioActual.toFixed(2)} USD`
        );
      }
    }
  } catch (e) {
    console.log('[stoploss] crypto check error:', e.message);
  }

  if (alertas.length === 0) return;

  await sendMessage(
    `🚨🔴 *ALERTA STOP-LOSS*\n\n` +
    alertas.join('\n\n') + `\n\n` +
    `⚡ Acción recomendada: revisá el mercado ahora.\n` +
    `Mandá */analizar* para un análisis completo o */si N* si ya tenés propuestas de venta pendientes.`
  );
}
