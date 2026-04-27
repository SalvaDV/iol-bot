async function tavilySearch(query, opts = {}) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_KEY,
        query,
        max_results: opts.max_results ?? 5,
        search_depth: opts.search_depth ?? 'basic',
        include_answer: true,
        days: opts.days,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      answer: data.answer || '',
      snippets: (data.results || [])
        .map(r => `- ${r.title}: ${(r.content || '').slice(0, 250)}`)
        .join('\n'),
    };
  } catch {
    return null;
  }
}

export async function searchTickerNews(simbolo) {
  // Noticias de las últimas 24h específicas del ticker
  const data = await tavilySearch(
    `${simbolo} acción bolsa noticias resultados análisis hoy`,
    { max_results: 4, days: 1 }
  );
  return data;
}

export async function fetchMarketResearch() {
  const date = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  const [bcba, macro, cedears, wall] = await Promise.all([
    tavilySearch(`mercado argentino BCBA acciones bolsa hoy ${date}`),
    tavilySearch(`economia argentina dolar inflacion noticias hoy ${date}`),
    tavilySearch(`cedears GGAL YPFD acciones argentinas tendencia analisis`),
    tavilySearch(`wall street S&P500 bolsa tendencia mercados globales hoy`),
  ]);

  return [
    { topic: 'Mercado BCBA', ...bcba },
    { topic: 'Macro Argentina (dólar/inflación)', ...macro },
    { topic: 'Acciones y CEDEARs', ...cedears },
    { topic: 'Wall Street / Mercados globales', ...wall },
  ];
}
