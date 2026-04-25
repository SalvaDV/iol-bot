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

  const aiMessage = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
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

Generá un reporte de asesor financiero con estas secciones exactas:

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

Sé directo y específico. Formato Markdown para Telegram. Máximo 500 palabras.

Al final, agregá exactamente este bloque JSON (sin texto después):

\`\`\`json
{
  "propuestas": [
    { "simbolo": "XXXX", "dir": "compra", "pct_efectivo": 0.20 },
    { "simbolo": "XXXX", "dir": "compra", "pct_efectivo": 0.30 },
    { "simbolo": "XXXX", "dir": "venta", "pct_efectivo": null }
  ]
}
\`\`\`

Reglas para el JSON:
- Usá exactamente 3 propuestas, en orden conservadora/moderada/agresiva
- Solo instrumentos de la lista disponible
- dir es "compra" o "venta"
- pct_efectivo es la fracción del efectivo (ej: 0.20 = 20%); para ventas es null
- Para compras, pct_efectivo entre 0.10 y 0.40

CRITERIO ESTRICTO PARA VENTAS: Solo proponés una venta si se cumple al menos UNO de estos criterios con alta convicción:
  a) La posición tiene ganancia >15% y hay señales técnicas de reversión (RSI >75, death cross, o caída intradiaria >4%)
  b) Hay un deterioro fundamental serio del activo (noticia negativa importante, cambio regulatorio, resultados malos)
  c) Stop loss: la posición acumula pérdida >10% y no hay catalizador positivo a la vista
Si no se cumple ninguno con certeza, NO propongas venta — poné compra en su lugar. Las 3 propuestas pueden ser todas compras.`,
    }],
  });

  const fullText = aiMessage.content[0].text;

  // Separar narrativa del JSON
  const jsonMatch = fullText.match(/```json\n([\s\S]+?)\n```/);
  const report = fullText.replace(/```json[\s\S]+?```/g, '').trim();

  await sendMessage(report);

  // Cancelar señales pendientes anteriores antes de guardar las nuevas
  await cancelAllPending().catch(() => {});

  if (!jsonMatch) return;

  let propuestas = [];
  try {
    propuestas = JSON.parse(jsonMatch[1]).propuestas || [];
  } catch {
    return;
  }

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
