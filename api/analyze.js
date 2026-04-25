import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { fetchMarketResearch } from '../lib/research.js';
import { fetchAllTechnicals } from '../lib/analysis.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

    // Todo en paralelo: token + research
    const [token, research] = await Promise.all([
      getToken(),
      fetchMarketResearch(),
    ]);

    // Con el token: portafolio + cuenta + técnicos en paralelo
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
        const valorTotal = (t.cantidad && t.ultimoPrecio) ? `$${(t.cantidad * t.ultimoPrecio).toLocaleString('es-AR')}` : '?';
        return `• ${t.simbolo}: ${t.cantidad} unidades @ $${precio} (${variacion} hoy) — Total: ${valorTotal} ARS`;
      })
      .join('\n') || 'Sin posiciones abiertas';

    const techLines = technicals
      .filter(t => t?.dir)
      .map(t => `• ${t.sym}: ${t.dir.toUpperCase()} — RSI ${t.rsi?.toFixed(0) ?? '?'}, señales: ${t.signals.map(s => s.detail).join(' | ')}`)
      .join('\n') || 'Sin señales técnicas claras';

    const researchText = research
      .map(r => `**${r.topic}:**\n${r.answer || 'Sin datos disponibles'}\n${r.snippets || ''}`)
      .join('\n\n');

    const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

    const aiMessage = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Sos un asesor financiero profesional especializado en el mercado argentino (BCBA y CEDEARs). Respondés siempre en español. Hoy es ${now}.

PORTAFOLIO DEL CLIENTE:
Efectivo disponible: $${efectivo.toLocaleString('es-AR')} ARS
Posiciones actuales:
${posiciones}

SEÑALES TÉCNICAS (RSI 14, MA20/MA50, volumen, variación intradiaria):
${techLines}

NOTICIAS Y CONTEXTO DE MERCADO:
${researchText}

Generá un reporte de asesor financiero profesional con exactamente estas secciones:

📰 *RESUMEN DE MERCADO*
Qué pasó hoy en Argentina y el mundo. Contexto macro relevante (dólar, inflación, política). Cómo impacta al mercado local.

💼 *ESTADO DEL PORTAFOLIO*
Análisis de las posiciones actuales. Si hay algo que conviene mantener, vender o reforzar, decilo.

💡 *PROPUESTAS CONCRETAS*
Exactamente 3 propuestas ordenadas por riesgo. Para cada una: instrumento, por qué ahora, qué % del efectivo disponible usar.

🟢 *Conservadora:* ...
🟡 *Moderada:* ...
🔴 *Agresiva:* ...

⚠️ *RIESGOS A MONITOREAR*
1 o 2 factores clave a tener en cuenta en las próximas horas.

Sé directo, honesto y específico. Si no hay buenas oportunidades, decilo claramente. Usá formato Markdown compatible con Telegram. Máximo 550 palabras.`,
      }],
    });

    const report = aiMessage.content[0].text;
    await sendMessage(report);

  } catch (err) {
    await sendMessage(`❌ Error en análisis IA: ${err.message}`).catch(() => {});
  }

  res.status(200).end('ok');
}
