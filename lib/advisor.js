import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta } from './iol.js';
import { sendMessage } from './telegram.js';
import { fetchMarketResearch } from './research.js';
import { fetchAllTechnicals } from './analysis.js';

export async function runAdvisor() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

  // Token + research en paralelo (research no necesita token)
  const [token, research] = await Promise.all([
    getToken(),
    fetchMarketResearch(),
  ]);

  // Portfolio + cuenta + técnicos en paralelo con el token
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
    max_tokens: 1500,
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

Sé directo y específico. Si no hay oportunidades claras, decilo. Formato Markdown para Telegram. Máximo 550 palabras.`,
    }],
  });

  const report = aiMessage.content[0].text;
  await sendMessage(report);
}
