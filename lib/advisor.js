import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta, getCotizacion } from './iol.js';
import { sendMessage } from './telegram.js';
import { fetchMarketResearch } from './research.js';
import { fetchAllTechnicals, WATCHLIST } from './analysis.js';
import { savePendingSignal, cancelAllPending, getRecentTrades } from './supabase.js';

export async function runAdvisor() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

  const [token, research, recentTrades] = await Promise.all([
    getToken(),
    fetchMarketResearch(),
    getRecentTrades(10),
  ]);

  const [portfolio, cuenta, technicals] = await Promise.all([
    getPortfolio(token),
    getCuenta(token),
    fetchAllTechnicals(token),
  ]);

  const efectivo = cuenta.cuentas?.[0]?.disponible ?? 0;

  const posiciones = (portfolio.titulos || [])
    .map(t => {
      const precio = t.ultimoPrecio ?? t.precioActual ?? '?';
      const variacion = t.variacionDiaria != null ? `${t.variacionDiaria.toFixed(2)}%` : '?';
      const total = (t.cantidad && t.ultimoPrecio)
        ? `$${(t.cantidad * t.ultimoPrecio).toLocaleString('es-AR')}`
        : '?';
      return `• ${t.simbolo}: ${t.cantidad} u. @ $${precio} (${variacion} hoy) — ${total} ARS`;
    })
    .join('\n') || 'Sin posiciones abiertas';

  const techLines = technicals
    .filter(t => t?.dir)
    .map(t => `• ${t.sym}: ${t.dir.toUpperCase()} — RSI ${t.rsi?.toFixed(0) ?? '?'} | ${t.signals.map(s => s.detail).join(' | ')}`)
    .join('\n') || 'Sin señales técnicas claras';

  const researchText = research
    .map(r => `**${r.topic}:**\n${r.answer || 'Sin datos'}\n${r.snippets || ''}`)
    .join('\n\n');

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  const tradesText = recentTrades.length > 0
    ? recentTrades.map(t =>
        `• ${t.fecha} ${t.hora} — ${t.accion?.toUpperCase()} ${t.simbolo} x${t.cantidad} @ $${t.precio} | monto $${t.monto?.toLocaleString('es-AR')}`
      ).join('\n')
    : 'Sin operaciones previas';

  const contexto = `Sos un asesor financiero profesional especializado en el mercado argentino (BCBA y CEDEARs). Respondés siempre en español. Hoy es ${now}.

PORTAFOLIO:
Efectivo disponible: $${efectivo.toLocaleString('es-AR')} ARS
Posiciones:
${posiciones}

HISTORIAL DE OPERACIONES RECIENTES (últimas 10):
${tradesText}

SEÑALES TÉCNICAS (RSI 14, MA20/MA50, volumen, variación intradiaria):
${techLines}

NOTICIAS Y CONTEXTO:
${researchText}

Instrumentos disponibles para operar: ${WATCHLIST.join(', ')}
También podés recomendar DOLAR_MEP o DOLAR_CCL si dolarizar es la mejor opción (el usuario lo ejecuta manualmente).`;

  // Paso 1: reporte narrativo (texto libre)
  const reportMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `${contexto}

Generá un reporte de asesor financiero con estas secciones en Markdown para Telegram:

📰 *RESUMEN DE MERCADO*
Qué pasó hoy en Argentina y el mundo. Contexto macro (dólar, inflación, política).

💼 *ESTADO DEL PORTAFOLIO*
Análisis de posiciones actuales.

💡 *PROPUESTAS CONCRETAS*
3 propuestas ordenadas por riesgo (conservadora, moderada, agresiva). Para cada una: instrumento, motivo, % de efectivo.

⚠️ *RIESGOS A MONITOREAR*
1-2 factores clave.

Máximo 400 palabras. Sé directo y específico.`,
    }],
  });

  const report = reportMsg.content.find(b => b.type === 'text')?.text?.trim() || '';
  console.log('[advisor] report length:', report.length);
  await sendMessage(report);

  // Paso 2: propuestas estructuradas (tool_use pequeño, garantizado)
  const proponerTool = {
    name: 'proponer_operaciones',
    description: 'Registra las 3 propuestas estructuradas.',
    input_schema: {
      type: 'object',
      properties: {
        propuestas: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              simbolo: { type: 'string', description: 'Ticker exacto, o DOLAR_MEP / DOLAR_CCL para dolarización' },
              dir: { type: 'string', enum: ['compra', 'venta', 'dolar'], description: 'dolar = compra manual de USD por el usuario' },
              pct_efectivo: { type: 'number', description: 'Fracción del efectivo (0.10-0.40). Ventas: 0.' },
            },
            required: ['simbolo', 'dir', 'pct_efectivo'],
          },
        },
      },
      required: ['propuestas'],
    },
  };

  const toolMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    tools: [proponerTool],
    tool_choice: { type: 'tool', name: 'proponer_operaciones' },
    messages: [
      { role: 'user', content: contexto },
      { role: 'assistant', content: report },
      { role: 'user', content: `Llamá a proponer_operaciones con las 3 propuestas del reporte.
CRITERIO VENTAS: solo si ganancia >15% con reversión, o deterioro fundamental, o stop loss >10%.
CRITERIO DOLAR: si el contexto macro (brecha, inflación, incertidumbre) hace que dolarizar sea mejor que invertir en pesos.
Si ningún criterio aplica: todas compras en pesos.` },
    ],
  });

  const toolBlock = toolMsg.content.find(b => b.type === 'tool_use' && b.name === 'proponer_operaciones');
  const propuestas = toolBlock?.input?.propuestas || [];

  console.log('[advisor] stop_reason:', toolMsg.stop_reason, '| propuestas:', JSON.stringify(propuestas));

  // Cancelar señales pendientes anteriores antes de guardar las nuevas
  await cancelAllPending().catch(() => {});

  // Guardar las 3 propuestas como pending_signals
  const techMap = Object.fromEntries(technicals.map(t => [t.sym, t]));
  console.log('[advisor] propuestas recibidas:', JSON.stringify(propuestas));
  console.log('[advisor] techMap keys:', Object.keys(techMap).join(', '));
  const saved = [];

  for (let i = 0; i < propuestas.length && i < 3; i++) {
    const p = propuestas[i];
    const sym = p.simbolo?.toUpperCase();
    if (!sym) { console.log(`[advisor] propuesta ${i+1}: sin simbolo`); continue; }

    let precio = techMap[sym]?.ultimo ?? null;
    console.log(`[advisor] propuesta ${i+1}: ${sym} dir=${p.dir} pct=${p.pct_efectivo} precio_techMap=${precio}`);

    // Si no está en technicals, intentar precio directo (puede fallar fuera de horario)
    if (!precio) {
      try {
        const cot = await getCotizacion(token, sym);
        precio = cot.ultimoPrecio || cot.ultimo || cot.precioActual || cot.precio || null;
        console.log(`[advisor] ${sym} cotizacion keys:`, Object.keys(cot).join(','), 'precio=', precio);
      } catch (e) {
        console.log(`[advisor] ${sym} getCotizacion error:`, e.message);
      }
    }

    // Guardar siempre — precio puede ser null (se resuelve al ejecutar)
    const cantidad = precio && p.dir === 'compra' && p.pct_efectivo && efectivo > 0
      ? Math.floor(efectivo * p.pct_efectivo / precio)
      : null;

    console.log(`[advisor] ${sym}: precio=${precio} cantidad=${cantidad} pct=${p.pct_efectivo}`);

    const techSignals = techMap[sym]?.signals?.map(s => s.detail) || [];

    try {
      await savePendingSignal({
        simbolo: sym,
        dir: p.dir,
        precio: precio ?? 0,
        cantidad: cantidad ?? null,
        ef_pre: efectivo,
        signals: [`propuesta:${i + 1}`, `pct:${p.pct_efectivo}`, ...techSignals],
        status: 'pending',
      });
      console.log(`[advisor] ${sym}: guardado OK`);
    } catch (e) {
      console.log(`[advisor] ${sym}: savePendingSignal error:`, e.message);
      continue;
    }

    saved.push({ num: i + 1, simbolo: sym, dir: p.dir, precio, cantidad, pct: p.pct_efectivo });
  }

  console.log('[advisor] saved:', JSON.stringify(saved));
  if (saved.length === 0) return;

  const lines = saved.map(s => {
    if (s.dir === 'dolar') {
      return `${s.num}️⃣ *${s.simbolo}* — 💵 DOLARIZAR: ${(s.pct * 100).toFixed(0)}% del efectivo (manual)`;
    }
    let montoStr;
    if (s.dir === 'venta') {
      montoStr = 'posición completa';
    } else if (s.cantidad && s.cantidad >= 1) {
      montoStr = `${s.cantidad} u. @ $${s.precio}`;
    } else {
      montoStr = `${(s.pct * 100).toFixed(0)}% del efectivo (precio al ejecutar)`;
    }
    return `${s.num}️⃣ *${s.simbolo}* — ${s.dir === 'compra' ? '📈 COMPRA' : '📉 VENTA'}: ${montoStr}`;
  }).join('\n');

  await sendMessage(
    `🚨 *PROPUESTAS LISTAS PARA EJECUTAR*\n\n${lines}\n\n` +
    `Respondé *si 1*, *si 2* o *si 3* para ejecutar esa propuesta.\n` +
    `*no* para cancelar todas.`
  );
}
