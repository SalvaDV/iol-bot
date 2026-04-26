import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta, getCotizacion } from './iol.js';
import { sendMessage } from './telegram.js';
import { fetchMarketResearch } from './research.js';
import { fetchAllTechnicals, WATCHLIST } from './analysis.js';
import { savePendingSignal, cancelAllPending } from './supabase.js';

export async function runAdvisor() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

  const [token, research] = await Promise.all([
    getToken(),
    fetchMarketResearch(),
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

  const proponerTool = {
    name: 'proponer_operaciones',
    description: 'Registra el reporte narrativo y las 3 propuestas de inversión concretas. Siempre llamá esta función con el reporte completo.',
    input_schema: {
      type: 'object',
      properties: {
        reporte: {
          type: 'string',
          description: 'Reporte narrativo completo en Markdown para Telegram (todas las secciones: resumen de mercado, portafolio, propuestas, riesgos). Máximo 500 palabras.',
        },
        propuestas: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              simbolo: { type: 'string', description: 'Ticker exacto de la lista disponible' },
              dir: { type: 'string', enum: ['compra', 'venta'] },
              pct_efectivo: { type: 'number', description: 'Fracción del efectivo a usar (0.10-0.40). Para ventas: 0.' },
            },
            required: ['simbolo', 'dir', 'pct_efectivo'],
          },
        },
      },
      required: ['reporte', 'propuestas'],
    },
  };

  const aiMessage = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    tools: [proponerTool],
    tool_choice: { type: 'any' },
    messages: [{
      role: 'user',
      content: `Sos un asesor financiero profesional especializado en el mercado argentino (BCBA y CEDEARs). Respondés siempre en español. Hoy es ${now}.

PORTAFOLIO:
Efectivo disponible: $${efectivo.toLocaleString('es-AR')} ARS
Posiciones:
${posiciones}

SEÑALES TÉCNICAS (RSI 14, MA20/MA50, volumen, variación intradiaria):
${techLines}

NOTICIAS Y CONTEXTO:
${researchText}

Instrumentos disponibles para operar: ${WATCHLIST.join(', ')}

Llamá a proponer_operaciones con el reporte completo y las 3 propuestas estructuradas.

El campo "reporte" debe contener estas secciones en Markdown para Telegram:

📰 *RESUMEN DE MERCADO*
Qué pasó hoy en Argentina y el mundo. Contexto macro (dólar, inflación, política). Cómo impacta al mercado local.

💼 *ESTADO DEL PORTAFOLIO*
Análisis de posiciones actuales. Si hay algo que conviene mantener, vender o reforzar, decilo.

💡 *PROPUESTAS CONCRETAS*
Exactamente 3 propuestas ordenadas por riesgo. Para cada una: instrumento, por qué ahora, qué % del efectivo usar.

🟢 *Conservadora:* ...
🟡 *Moderada:* ...
🔴 *Agresiva:* ...

⚠️ *RIESGOS A MONITOREAR*
1 o 2 factores clave para las próximas horas.

Sé directo y específico. Máximo 500 palabras en el reporte.

CRITERIO ESTRICTO PARA VENTAS: Solo proponés venta si se cumple al menos UNO con alta convicción:
  a) Posición con ganancia >15% y señales de reversión (RSI >75, death cross, caída intradiaria >4%)
  b) Deterioro fundamental serio (noticia negativa, cambio regulatorio, resultados malos)
  c) Stop loss: pérdida acumulada >10% sin catalizador positivo
Si ninguno aplica, las 3 propuestas pueden ser todas compras. Para ventas, pct_efectivo = 0.`,
    }],
  });

  const toolBlock = aiMessage.content.find(b => b.type === 'tool_use' && b.name === 'proponer_operaciones');

  const report = toolBlock?.input?.reporte?.trim() || '';
  const propuestas = toolBlock?.input?.propuestas || [];

  console.log('[advisor] tool_use propuestas:', JSON.stringify(propuestas));

  await sendMessage(report);

  // Cancelar señales pendientes anteriores antes de guardar las nuevas
  await cancelAllPending().catch(() => {});

  // Guardar las 3 propuestas como pending_signals
  const techMap = Object.fromEntries(technicals.map(t => [t.sym, t]));
  const saved = [];

  for (let i = 0; i < propuestas.length && i < 3; i++) {
    const p = propuestas[i];
    const sym = p.simbolo?.toUpperCase();
    if (!sym) continue;

    let precio = techMap[sym]?.ultimo ?? null;

    // Si no está en technicals, buscar precio directo
    if (!precio) {
      try {
        const cot = await getCotizacion(token, sym);
        precio = cot.ultimo || cot.precio || null;
      } catch {
        continue;
      }
    }

    if (!precio) continue;

    const cantidad = p.dir === 'compra' && p.pct_efectivo
      ? Math.floor(efectivo * p.pct_efectivo / precio)
      : null;

    if (p.dir === 'compra' && (!cantidad || cantidad < 1)) continue;

    const techSignals = techMap[sym]?.signals?.map(s => s.detail) || [];

    await savePendingSignal({
      simbolo: sym,
      dir: p.dir,
      precio,
      cantidad: cantidad ?? null,
      ef_pre: efectivo,
      signals: [`propuesta:${i + 1}`, ...techSignals],
      status: 'pending',
    });

    saved.push({ num: i + 1, simbolo: sym, dir: p.dir, precio, cantidad });
  }

  if (saved.length === 0) return;

  const lines = saved.map(s => {
    const montoStr = s.dir === 'compra'
      ? `${s.cantidad} u. @ $${s.precio} = $${(s.cantidad * s.precio).toLocaleString('es-AR')} ARS`
      : `posición completa`;
    return `${s.num}️⃣ *${s.simbolo}* — ${s.dir === 'compra' ? '📈 COMPRA' : '📉 VENTA'}: ${montoStr}`;
  }).join('\n');

  await sendMessage(
    `🚨 *PROPUESTAS LISTAS PARA EJECUTAR*\n\n${lines}\n\n` +
    `Respondé *si 1*, *si 2* o *si 3* para ejecutar esa propuesta.\n` +
    `*no* para cancelar todas.`
  );
}
