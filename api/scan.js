import { getToken, getPortfolio, normalizePortfolio } from '../lib/iol.js';
import { fetchAllTechnicals } from '../lib/analysis.js';
import { sendMessage } from '../lib/telegram.js';
import { getCustomWatchlist } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 55 };

// Señales que disparan alerta — filtra ruido y prioriza entradas/salidas reales
const STRONG_SIGNALS = new Set([
  'MACD_BULLISH', 'MACD_BEARISH',
  'BB_OVERSOLD', 'BB_OVERBOUGHT',
  'RSI_OVERSOLD', 'RSI_OVERBOUGHT',
  'GOLDEN_CROSS', 'DEATH_CROSS',
]);

function bsAsHour() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })
  ).getHours();
}

export default async function handler(req, res) {
  res.status(200).end('ok');

  // Solo en horario de mercado BCBA: 11-17hs BsAs
  const hour = bsAsHour();
  if (hour < 11 || hour >= 17) {
    console.log('[scan] fuera de horario de mercado, skipping');
    return;
  }

  // Lunes a viernes
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  if (now.getDay() === 0 || now.getDay() === 6) return;

  try {
    await runQuickScan();
  } catch (err) {
    console.error('[scan]', err.message);
  }
}

async function runQuickScan() {
  const token = await getToken();

  const [portfolio, customWatchlist] = await Promise.all([
    getPortfolio(token),
    getCustomWatchlist().catch(() => []),
  ]);

  const posiciones   = normalizePortfolio(portfolio);
  const portfolioSet = new Set(posiciones.map(t => t.simbolo).filter(Boolean));
  const customSyms   = customWatchlist.map(w => w.simbolo?.toUpperCase()).filter(Boolean);

  // Análisis técnico completo (WATCHLIST + portafolio + watchlist personalizada)
  const technicals = await fetchAllTechnicals(token, [...portfolioSet, ...customSyms]);

  const compras = [];
  const ventas  = [];

  for (const t of technicals) {
    if (!t?.signals?.length) continue;

    const isPortfolio = portfolioSet.has(t.sym);

    // Criterio de alerta: al menos 1 señal fuerte
    // Portafolio: cualquier señal fuerte
    // Watchlist: mínimo 2 señales (al menos 1 fuerte)
    const strongCount = t.signals.filter(s => STRONG_SIGNALS.has(s.type)).length;
    if (strongCount === 0) continue;
    if (!isPortfolio && t.signals.length < 2) continue;

    const tag       = isPortfolio ? ' _(cartera)_' : '';
    const precioStr = t.ultimo != null ? `$${t.ultimo.toLocaleString('es-AR')}` : '?';
    const rsiStr    = t.rsi    != null ? ` | RSI ${t.rsi.toFixed(0)}` : '';
    const line      = `*${t.sym}*${tag} @ ${precioStr}${rsiStr}\n↳ ${t.signals.map(s => s.detail).join(' | ')}`;

    if (t.dir === 'compra') compras.push(line);
    else if (t.dir === 'venta') ventas.push(line);
    else compras.push(line); // neutral con señal fuerte → incluir en compras
  }

  if (compras.length === 0 && ventas.length === 0) {
    console.log('[scan] sin señales relevantes');
    return;
  }

  const hora = new Date().toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit', minute: '2-digit',
  });

  const partes = [];
  if (compras.length > 0) partes.push(`📈 *OPORTUNIDADES*\n${compras.join('\n\n')}`);
  if (ventas.length  > 0) partes.push(`📉 *SEÑALES DE VENTA*\n${ventas.join('\n\n')}`);

  await sendMessage(`🔍 *SCAN ${hora}*\n\n${partes.join('\n\n')}`);
}
