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
const MAX_CEDEAR_PCT     = 0.70;   // máx 70% del portfolio en CEDEARs (dólar)
const MAX_SECTOR_POSITIONS = 2;    // máx 2 posiciones del mismo sector

// ── Mapa de sectores ──────────────────────────────────────────────────────────
export const SECTOR_MAP = {
  // Bancos
  GGAL: 'bancos', BMA: 'bancos', SUPV: 'bancos', VALO: 'bancos',
  // Energía
  YPFD: 'energia', PAMP: 'energia', CEPU: 'energia', EDN: 'energia',
  TGNO4: 'energia', TGSU2: 'energia', HARG: 'energia', METR: 'energia',
  // Materiales
  ALUA: 'materiales', TXAR: 'materiales', LOMA: 'materiales',
  // Agro
  AGRO: 'agro', CRES: 'agro', MOLI: 'agro', POLL: 'agro',
  // Tech US (CEDEARs)
  AAPL: 'tech_us', MSFT: 'tech_us', GOOGL: 'tech_us', AMZN: 'tech_us',
  NVDA: 'tech_us', TSLA: 'tech_us', META: 'tech_us', MELI: 'tech_us',
  AMD: 'tech_us', INTC: 'tech_us', NFLX: 'tech_us', CRM: 'tech_us',
  DIS: 'tech_us', SPOT: 'tech_us', UBER: 'tech_us', BABA: 'tech_us', PYPL: 'tech_us',
  // Crypto CEDEARs
  COIN: 'crypto', MSTR: 'crypto', MARA: 'crypto', RIOT: 'crypto', HOOD: 'crypto',
  // Finanzas US
  JPM: 'finanzas_us', GS: 'finanzas_us',
  // Consumo/Salud US
  KO: 'consumo_us', WMT: 'consumo_us', PFE: 'consumo_us',
  // Energía US
  XOM: 'energia_us', CVX: 'energia_us',
  // Bonos soberanos
  AL30: 'bonos', GD30: 'bonos', GD35: 'bonos', GD38: 'bonos', AE38: 'bonos', AL35: 'bonos',
};

// ── Chequeo de concentración sectorial ───────────────────────────────────────
export function checkSectorConcentration(simbolo, portfolioTitulos = []) {
  const sector = SECTOR_MAP[simbolo];
  if (!sector) return { ok: true };
  const held = portfolioTitulos
    .map(t => t.simbolo?.toUpperCase())
    .filter(sym => SECTOR_MAP[sym] === sector);
  if (held.length >= MAX_SECTOR_POSITIONS)
    return { ok: false, reason: `sector "${sector}" ya tiene ${held.length} posiciones (${held.join(', ')}) — máx ${MAX_SECTOR_POSITIONS}` };
  return { ok: true, warning: held.length === 1 ? `sector "${sector}" ya tiene 1 posición (${held[0]})` : null };
}

// ── Chequeo de exposición cambiaria ──────────────────────────────────────────
export function checkCurrencyExposure(simbolo, portfolioTitulos = []) {
  if (!CEDEARS.has(simbolo)) return { ok: true };
  let total = 0, cedearTotal = 0;
  for (const pos of portfolioTitulos) {
    const val = (pos.cantidad ?? 0) * (pos.ultimoPrecio ?? pos.ppc ?? 0);
    total += val;
    if (CEDEARS.has(pos.simbolo?.toUpperCase())) cedearTotal += val;
  }
  if (total <= 0) return { ok: true };
  const pct = cedearTotal / total;
  if (pct >= MAX_CEDEAR_PCT)
    return { ok: false, reason: `exposición dólar (CEDEARs) ya es ${(pct * 100).toFixed(0)}% del portfolio — diversificá en activos pesos` };
  if (pct >= 0.55)
    return { ok: true, warning: `CEDEARs = ${(pct * 100).toFixed(0)}% del portfolio — considerá balance con activos ARS` };
  return { ok: true };
}

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
