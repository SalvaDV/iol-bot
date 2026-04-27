import Anthropic from '@anthropic-ai/sdk';
import { searchTickerNews } from './research.js';

/**
 * Verifica si hay noticias materiales recientes del ticker antes de ejecutar.
 * Devuelve { material: boolean, resumen: string, recomendacion: 'ejecutar'|'pausar' }
 */
export async function preTradeCheck(simbolo, dir) {
  const news = await searchTickerNews(simbolo).catch(() => null);
  if (!news || !news.snippets) {
    return { material: false, resumen: 'Sin noticias relevantes recientes.', recomendacion: 'ejecutar' };
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

  const evaluarTool = {
    name: 'evaluar_noticias',
    description: 'Evalúa si las noticias afectan materialmente la operación.',
    input_schema: {
      type: 'object',
      properties: {
        material: { type: 'boolean', description: 'true si hay alguna noticia que cambia la decisión de la operación' },
        resumen: { type: 'string', description: 'Resumen breve (1-2 oraciones) de lo más relevante' },
        recomendacion: { type: 'string', enum: ['ejecutar', 'pausar'], description: 'pausar si la noticia es seria; ejecutar si es ruido o positivo' },
      },
      required: ['material', 'resumen', 'recomendacion'],
    },
  };

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      tools: [evaluarTool],
      tool_choice: { type: 'tool', name: 'evaluar_noticias' },
      messages: [{
        role: 'user',
        content: `Vas a ejecutar una operación de ${dir.toUpperCase()} sobre ${simbolo}.

Noticias del ticker (últimas 24h):
${news.answer ? `Resumen: ${news.answer}\n` : ''}${news.snippets}

Determiná si hay alguna noticia material que cambie esta decisión:
- Material = resultados negativos sorpresa, cambio regulatorio, escándalo, fusión inesperada, suspensión de cotización
- NO material = comentarios de analistas, movimiento normal, noticias del sector general, especulación

Si es material y va contra la operación (ej: noticia mala antes de comprar, buena antes de vender) → recomendá pausar.`,
      }],
    });

    const block = msg.content.find(b => b.type === 'tool_use');
    const input = block?.input || {};
    return {
      material: input.material ?? false,
      resumen: input.resumen ?? '',
      recomendacion: input.recomendacion ?? 'ejecutar',
    };
  } catch {
    return { material: false, resumen: 'Check de noticias no disponible.', recomendacion: 'ejecutar' };
  }
}
