/**
 * Risk Manager — controla si el bot puede operar.
 *
 * Controles activos:
 *  1. Pausa manual (/pausar / /reanudar)
 *  2. Horario de mercado BCBA (10:00–17:00 BsAs, lunes a viernes)
 *  3. Circuit breaker diario: si el P&L del día <= -DAILY_LOSS_LIMIT → para
 *  4. Cooldown por símbolo: 24h tras un stop-loss
 *  5. Máximo de posiciones simultáneas: MAX_POSITIONS
 *  6. Máximo por trade: MAX_PCT_PER_TRADE del efectivo disponible
 */

import { getBotConfig, getCooldowns, getRecentTrades } from './supabase.js';
import { getDolarData } from './dolar.js';

// CEDEARs que cotizan en USD — más vulnerables a cierre de brecha
const CEDEARS = new Set([
  'AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','MELI','META',
  'COIN','MSTR','MARA','RIOT','HOOD','AMD','INTC','JPM','KO',
  'WMT','XOM','BABA','PYPL','DIS','SPOT','UBER','GS','CVX',
  'BA','PFE','NFLX','CRM',
]);

const MAX_POSITIONS      = 12;     // posiciones abiertas simultáneas
const MAX_PCT_PER_TRADE  = 0.25;   // 25% del efectivo por operación
const DAILY_LOSS_LIMIT   = 0.03;   // circuit breaker: -3% del efectivo inicial

// ── Hora BsAs ────────────────────────────────────────────────────────────────
function bsAsNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

export function isMarketOpen() {
  const now = bsAsNow();
  const day  = now.getDay();   // 0=dom, 6=sáb
  const hour = now.getHours();
  const min  = now.getMinutes();
  if (day === 0 || day === 6) return false;
  const minuteOfDay = hour * 60 + min;
  return minuteOfDay >= 10 * 60 && minuteOfDay < 17 * 60; // 10:00–17:00
}

// ── P&L del día desde trading_log ────────────────────────────────────────────
async function getDailyPnl() {
  try {
    const trades = await getRecentTrades(50);
    const today  = new Date().toISOString().slice(0, 10);
    const todayTrades = trades.filter(t => t.fecha === today);

    // Solo contamos pérdidas realizadas (stop-loss / ventas automáticas) vs el costo de compra.
    // NO restamos compras — comprar no es una pérdida, es una posición abierta.
    // Circuit breaker solo se activa por pérdidas reales de capital.
    let pnl = 0;
    // Agrupar compras y ventas por símbolo para calcular P&L realizado
    const costos = {};   // { sym → { cantidad, monto } }
    for (const t of todayTrades) {
      if (!t.monto || !t.simbolo) continue;
      const sym = t.simbolo;
      if (t.accion?.includes('compra')) {
        if (!costos[sym]) costos[sym] = { cantidad: 0, monto: 0 };
        costos[sym].cantidad += (t.cantidad ?? 0);
        costos[sym].monto    += t.monto;
      }
    }
    for (const t of todayTrades) {
      if (!t.monto || !t.simbolo) continue;
      const sym = t.simbolo;
      if (t.accion?.includes('venta') && costos[sym]) {
        // P&L realizado = ingreso venta - costo proporcional de compra
        const costo = costos[sym];
        const pctVendido = costo.cantidad > 0 ? Math.min((t.cantidad ?? 0) / costo.cantidad, 1) : 0;
        const costoVenta = costo.monto * pctVendido;
        pnl += t.monto - costoVenta;
      }
    }
    return pnl;
  } catch {
    return 0;
  }
}

// ── Evaluación principal ──────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.simbolo       — ticker a comprar
 * @param {number}   opts.pct           — fracción del efectivo (0–1)
 * @param {number}   opts.efectivo      — efectivo disponible en ARS
 * @param {number}   opts.openPositions — cantidad de posiciones abiertas actualmente
 * @returns {{ allowed: boolean, reason: string }}
 */
export async function canBuy({ simbolo, pct, efectivo, openPositions }) {
  // 1. Pausa manual
  const paused = await getBotConfig('trading_paused').catch(() => 'false');
  if (paused === 'true') return { allowed: false, reason: 'bot en pausa manual (/reanudar para activar)' };

  // 2. Horario de mercado
  if (!isMarketOpen()) return { allowed: false, reason: 'mercado cerrado' };

  // 3. Max posiciones
  if (openPositions >= MAX_POSITIONS)
    return { allowed: false, reason: `máximo de posiciones alcanzado (${MAX_POSITIONS})` };

  // 4. Max % por trade
  if (pct > MAX_PCT_PER_TRADE)
    return { allowed: false, reason: `pct ${(pct * 100).toFixed(0)}% supera el máximo permitido (${MAX_PCT_PER_TRADE * 100}%)` };

  // 5. Circuit breaker diario
  if (efectivo > 0) {
    const dailyPnl = await getDailyPnl();
    const dailyPnlPct = dailyPnl / efectivo;
    if (dailyPnlPct <= -DAILY_LOSS_LIMIT)
      return { allowed: false, reason: `circuit breaker activo — P&L del día ${(dailyPnlPct * 100).toFixed(1)}%` };
  }

  // 6. Cooldown por símbolo
  const cooldowns = await getCooldowns().catch(() => ({}));
  if (cooldowns[simbolo]) {
    const until = new Date(cooldowns[simbolo]).toLocaleTimeString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit',
    });
    return { allowed: false, reason: `cooldown activo para ${simbolo} hasta ${until}` };
  }

  // 7. Brecha cambiaria extrema: advertencia para CEDEARs (no bloquea, solo avisa)
  let warning = null;
  if (CEDEARS.has(simbolo)) {
    try {
      const dolar = await getDolarData();
      if (dolar?.brechaCCL >= 80) {
        warning = `brecha CCL ${dolar.brechaCCL.toFixed(0)}% — CEDEAR caro en ARS, operá con precaución`;
      }
    } catch { /* ignorar */ }
  }

  return { allowed: true, reason: 'ok', warning };
}

/**
 * Verificación simple para ventas (pausa + horario).
 */
export async function canSell() {
  const paused = await getBotConfig('trading_paused').catch(() => 'false');
  if (paused === 'true') return { allowed: false, reason: 'bot en pausa manual' };
  if (!isMarketOpen())   return { allowed: false, reason: 'mercado cerrado' };
  return { allowed: true, reason: 'ok' };
}
