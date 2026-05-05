import { searchTickerNews } from './research.js';

/**
 * Verifica si hay noticias materiales recientes antes de ejecutar una orden.
 * Devuelve:
 *   { material: false }                                       — sin novedad, proceder
 *   { material: true, recomendacion: 'informar', resumen }   — hay contexto, informar pero no bloquear
 *   { material: true, recomendacion: 'pausar',  resumen }    — noticia crítica, pedir confirmación
 */
export async function preTradeCheck(simbolo, dir) {
  try {
    const data = await searchTickerNews(simbolo);
    if (!data?.answer && !data?.snippets) return { material: false };

    const texto = `${data.answer ?? ''} ${data.snippets ?? ''}`.toLowerCase();

    // Palabras que indican noticia crítica → pedir confirmación antes de operar
    const CRITICAS = [
      'suspendida', 'suspensión', 'halt', 'fraude', 'quiebra', 'default',
      'intervención', 'sanción', 'multa', 'investigación penal',
      'delisted', 'baja del panel',
    ];

    // Palabras que indican noticia relevante pero no bloqueante → solo informar
    const RELEVANTES = [
      'resultado', 'ganancia', 'pérdida', 'balance', 'earnings',
      'dividendo', 'fusión', 'adquisición', 'oferta', 'acuerdo',
      'acusación', 'demanda', 'regulación', 'bcra', 'cnv',
      'subió', 'bajó', 'rebotó', 'cayó',
    ];

    const esCritica   = CRITICAS.some(w => texto.includes(w));
    const esRelevante = RELEVANTES.some(w => texto.includes(w));

    const resumen = data.answer
      ? data.answer.slice(0, 400)
      : data.snippets?.split('\n')[0]?.slice(0, 400) ?? '';

    if (esCritica) {
      return { material: true, recomendacion: 'pausar', resumen };
    }
    if (esRelevante) {
      return { material: true, recomendacion: 'informar', resumen };
    }

    return { material: false };
  } catch {
    // Si falla la búsqueda no bloqueamos — operamos con la info que tenemos
    return { material: false };
  }
}
