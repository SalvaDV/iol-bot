import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta, getCotizacion, extractPrecio, normalizePortfolio, extractEfectivo } from './iol.js';
import { sendMessage, sendMessageWithButtons } from './telegram.js';
import { fetchMarketResearch } from './research.js';
import { fetchAllTechnicals, scanMarketMovers, WATCHLIST } from './analysis.js';
import { savePendingSignal, cancelAllPending, getRecentTrades, getRecentProposals, getCustomWatchlist, addCooldown } from './supabase.js';
import { getDolarData, formatDolarContext } from './dolar.js';
import { getCryptoPrices, getCryptoTrending, formatCryptoContext } from './crypto.js';
import { getMervalUSD, getBrechaAnalysis, buildPerformanceFeedback, formatAlphaContext } from './merval.js';
import { checkSectorConcentration, checkCurrencyExposure } from './riskManager.js';

export async function runAdvisor() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

  const [token, research, recentTrades, dolar, recentProposals, cryptoPrices, cryptoTrending, customWatchlist] = await Promise.all([
    getToken(),
    fetchMarketResearch(),
    getRecentTrades(10),
    getDolarData(),
    getRecentProposals(15),
    getCryptoPrices(),
    getCryptoTrending(),
    getCustomWatchlist().catch(() => []),
  ]);

  // Portfolio, cuenta y market movers en paralelo
  const [portfolio, cuenta, movers] = await Promise.all([
    getPortfolio(token),
    getCuenta(token),
    scanMarketMovers(token, 5).catch(() => ({ gainers: [], losers: [] })),
  ]);

  // Efectivo operable en ARS: usa hrs24.disponibleOperar para incluir fondos T+1
  const efectivo = extractEfectivo(cuenta);
  console.log('[advisor] efectivo IOL:', efectivo);

  const titulos = normalizePortfolio(portfolio);

  // Combinar: portafolio + custom watchlist + top movers → análisis técnico completo
  const portfolioSyms = titulos.map(t => t.simbolo).filter(Boolean);
  const customSyms = customWatchlist.map(w => w.simbolo?.toUpperCase()).filter(Boolean);
  const moverSyms = [...movers.gainers, ...movers.losers].map(m => m.sym);
  const technicals = await fetchAllTechnicals(token, [...portfolioSyms, ...customSyms, ...moverSyms]);

  // Mapa de precio de compra desde trading_log (fallback si IOL no devuelve ppc)
  const ppcFromTrades = {};
  for (const t of recentTrades) {
    if (t.accion === 'compra' && t.simbolo && t.precio && !ppcFromTrades[t.simbolo]) {
      ppcFromTrades[t.simbolo] = t.precio;
    }
  }

  // Holdings de crypto estimados desde trading_log (compras manuales no vendidas)
  const cryptoHoldings = {};
  for (const t of recentTrades) {
    const sym = t.simbolo?.toUpperCase();
    if (!sym) continue;
    if (t.accion === 'crypto_manual') {
      cryptoHoldings[sym] = (cryptoHoldings[sym] ?? 0) + (t.monto ?? 0);
    } else if (t.accion === 'crypto_manual_venta') {
      cryptoHoldings[sym] = (cryptoHoldings[sym] ?? 0) - (t.monto ?? 0);
    }
  }

  const alertasPosicion = [];
  const posiciones = titulos
    .map(t => {
      const precio    = t.ultimoPrecio ?? null;
      const variacion = t.variacionDiaria != null ? `${t.variacionDiaria.toFixed(2)}%` : '?';
      const total     = (t.cantidad && precio)
        ? `$${(t.cantidad * precio).toLocaleString('es-AR')}`
        : '?';

      // Detectar alertas P&L
      const ppc = t.ppc ?? ppcFromTrades[t.simbolo] ?? null;
      if (precio && ppc && ppc > 0) {
        const pnlPct = (precio - ppc) / ppc;
        if (pnlPct <= -0.08) {
          alertasPosicion.push(`🔴 *${t.simbolo}* cayó ${(pnlPct * 100).toFixed(1)}% desde compra (PPC $${ppc} → $${precio})`);
        } else if (pnlPct >= 0.20) {
          alertasPosicion.push(`🟢 *${t.simbolo}* subió +${(pnlPct * 100).toFixed(1)}% desde compra (PPC $${ppc} → $${precio})`);
        }
      }

      return `• ${t.simbolo}: ${t.cantidad} u. @ $${precio ?? '?'} (${variacion} hoy) — ${total} ARS${ppc ? ` | PPC $${ppc}` : ''}`;
    })
    .join('\n') || 'Sin posiciones abiertas';

  // ── Alpha argentino ──────────────────────────────────────────────────────
  const mervalUSD     = getMervalUSD(technicals, dolar);
  const brechaAnalysis = getBrechaAnalysis(dolar);
  const perfFeedback  = buildPerformanceFeedback(recentTrades);
  const alphaContext  = formatAlphaContext(mervalUSD, brechaAnalysis, perfFeedback, dolar);

  const techLines = technicals
    .filter(t => t?.dir)
    .map(t => {
      const rsiStr     = t.rsi        != null ? `RSI ${t.rsi.toFixed(0)}` : '';
      const weeklyStr  = t.weeklyRsi  != null ? `RSI-W ${t.weeklyRsi.toFixed(0)}` : '';
      const vwapStr    = t.vwap       ? (t.vwap.price_above ? 'sobre VWAP' : 'bajo VWAP') : '';
      const donchStr   = t.donchian   ? `S:$${t.donchian.support.toFixed(1)} R:$${t.donchian.resistance.toFixed(1)}` : '';
      const meta       = [rsiStr, weeklyStr, vwapStr, donchStr].filter(Boolean).join(' | ');
      return `• ${t.sym}: ${t.dir.toUpperCase()} — ${meta}\n  ↳ ${t.signals.map(s => s.detail).join(' | ')}`;
    })
    .join('\n') || 'Sin señales técnicas claras';

  const researchText = research
    .map(r => `**${r.topic}:**\n${r.answer || 'Sin datos'}\n${r.snippets || ''}`)
    .join('\n\n');

  const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

  // Agrupar propuestas recientes por símbolo para instrucción de diversificación
  const recentPropMap = {};
  for (const p of recentProposals) {
    const sym = p.simbolo?.toUpperCase();
    if (!sym) continue;
    if (!recentPropMap[sym]) recentPropMap[sym] = 0;
    recentPropMap[sym]++;
  }
  const repetidos = Object.entries(recentPropMap)
    .sort((a, b) => b[1] - a[1])
    .map(([sym, n]) => `${sym} (${n}x)`)
    .join(', ');
  const diversificacionNote = repetidos
    ? `\nPROPUESTAS RECIENTES (últimas 3 sesiones): ${repetidos}\n→ Evitá repetir estos símbolos a menos que las señales técnicas sean significativamente más fuertes que cualquier alternativa. Priorizá variedad de sectores y tipos de instrumento (acciones BCBA, CEDEARs, bonos).`
    : '';

  const tradesText = recentTrades.length > 0
    ? recentTrades.map(t =>
        `• ${t.fecha} ${t.hora} — ${t.accion?.toUpperCase()} ${t.simbolo} x${t.cantidad} @ $${t.precio} | monto $${t.monto?.toLocaleString('es-AR')}`
      ).join('\n')
    : 'Sin operaciones previas';

  // Salidas recientes → candidatos a recompra
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const recentSalesText = recentTrades
    .filter(t => t.accion?.includes('venta') && t.fecha >= sevenDaysAgo)
    .map(t => `• ${t.simbolo} — vendida el ${t.fecha} @ $${t.precio?.toLocaleString('es-AR')} (${t.accion})`)
    .join('\n') || 'Ninguna';

  const alertasText = alertasPosicion.length > 0
    ? `\n⚠️ ALERTAS DE POSICIONES (evaluación urgente):\n${alertasPosicion.join('\n')}`
    : '';

  // Concentración del portafolio
  const totalInvertido = titulos.reduce((s, t) => {
    return s + (t.cantidad && t.ultimoPrecio ? t.cantidad * t.ultimoPrecio : 0);
  }, 0);
  const concentracion = totalInvertido > 0
    ? titulos.map(t => {
        const val = t.cantidad && t.ultimoPrecio ? t.cantidad * t.ultimoPrecio : 0;
        return `${t.simbolo}: ${((val / totalInvertido) * 100).toFixed(0)}%`;
      }).join(', ')
    : 'Sin posiciones';

  const cryptoContext = formatCryptoContext(cryptoPrices, cryptoTrending);
  const cryptoHoldingsText = Object.entries(cryptoHoldings).filter(([, v]) => v > 0).length > 0
    ? 'Holdings estimados (desde historial): ' + Object.entries(cryptoHoldings)
        .filter(([, v]) => v > 0)
        .map(([sym, monto]) => `${sym} ≈$${Math.round(monto).toLocaleString('es-AR')} ARS invertidos`)
        .join(', ')
    : 'Sin holdings de crypto registrados.';

  // Market movers del día
  const moversText = [
    movers.gainers.length > 0
      ? `📈 MAYORES SUBAS: ${movers.gainers.map(m => `${m.sym} ${m.variacion >= 0 ? '+' : ''}${m.variacion.toFixed(1)}%`).join(' | ')}`
      : '',
    movers.losers.length > 0
      ? `📉 MAYORES BAJAS: ${movers.losers.map(m => `${m.sym} ${m.variacion.toFixed(1)}%`).join(' | ')}`
      : '',
  ].filter(Boolean).join('\n');

  // Watchlist personalizada y todos los instrumentos disponibles
  const customWatchlistText = customSyms.length > 0
    ? `Watchlist personalizada (usuario): ${customSyms.join(', ')}`
    : '';
  const allAvailable = [...new Set([...WATCHLIST, ...customSyms, ...moverSyms])];
  console.log('[advisor] movers:', JSON.stringify(movers));
  console.log('[advisor] custom watchlist:', customSyms);

  const contexto = `Sos un trader agresivo especializado en el mercado argentino (BCBA, CEDEARs) y crypto. Tu objetivo es maximizar retorno en el corto plazo — operás con alto riesgo y alta ganancia. Asumís que el usuario acepta perder hasta un 20-30% de una posición si la tesis lo justifica. Siempre explicás el razonamiento. Respondés en español. Hoy es ${now}.${diversificacionNote}

PERFIL DE RIESGO: ALTO — priorizá momentum, ruptura de resistencias, noticias catalizadoras. No evitás volatilidad, la buscás. Horizonte de holding: horas a días, no meses.

PORTAFOLIO:
Efectivo disponible: $${efectivo.toLocaleString('es-AR')} ARS
Posiciones:
${posiciones}${alertasText}
Concentración: ${concentracion}

HISTORIAL DE OPERACIONES RECIENTES (últimas 10):
${tradesText}

SALIDAS RECIENTES — CANDIDATOS A RECOMPRA (últimos 7 días):
${recentSalesText}
→ Si alguna tiene señales técnicas favorables y no hay cooldown activo, podés proponer recompra. El stop-loss genera cooldown de 24h, las ventas voluntarias no.

SEÑALES TÉCNICAS (RSI, MA20/MA50, volumen, variación intradiaria):
${techLines}

TIPO DE CAMBIO (tiempo real):
${formatDolarContext(dolar)}

MERCADO CRYPTO (contexto para evaluar CEDEARs crypto — COIN, MSTR, MARA, RIOT, HOOD):
${cryptoContext}

MARKET MOVERS HOY (variación diaria):
${moversText || 'Sin datos de movers disponibles.'}
→ Prestá atención a estos instrumentos al armar propuestas. Mover con señal técnica + catalizador = oportunidad concreta.

🇦🇷 ALPHA ARGENTINO:
${alphaContext}

NOTICIAS Y CONTEXTO:
${researchText}

${customWatchlistText ? `${customWatchlistText}\n\n` : ''}Instrumentos disponibles en IOL: ${allAvailable.join(', ')}
→ Para exposición crypto usá los CEDEARs: COIN (Coinbase), MSTR (MicroStrategy/BTC proxy), MARA/RIOT (mineras BTC), HOOD (exchange). Se operan igual que cualquier CEDEAR en IOL.
USD: podés recomendar dolarización via MEP o CCL.`;

  // Paso 1: reporte narrativo (texto libre)
  const reportMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `${contexto}

Generá un reporte con estas secciones en Markdown para Telegram:

🔥 *OPORTUNIDADES HOY*
Qué está moviendo el mercado ahora mismo. Identificá catalizadores de corto plazo: noticias, momentum técnico, movimientos de crypto correlacionados con CEDEARs tech, brecha cambiaria. Sé directo — qué está pasando y cómo aprovecharlo.

💼 *PORTAFOLIO*
Revisión rápida de posiciones abiertas. ¿Alguna para cerrar ya? ¿Alguna para promediar? Usá el test inverso: "¿La compraría hoy?" Si no, salí. Mencioná P&L y si la tesis sigue.

💡 *PROPUESTAS*
Hasta 4 de IOL (incluyendo CEDEARs crypto) + 1 de USD/dolarización si aplica. Evaluá también los CANDIDATOS A RECOMPRA del historial — si tienen señales y no hay cooldown, son oportunidades concretas. Máx 5 posiciones totales en cartera.
⚠️ IMPORTANTE: Si el portafolio actual ya está bien posicionado y no hay oportunidades claramente superiores, decí "Mantener cartera — sin señales que justifiquen mover capital" en vez de proponer algo mediocre. No fuerces operaciones.

⚡ *CATALIZADORES A VIGILAR*
1-2 eventos en las próximas horas/días que pueden mover fuerte (earnings, datos macro, movimiento de BTC, decisiones del BCRA).

Máximo 400 palabras. Lenguaje de trader — directo, sin rodeos.`,
    }],
  });

  const report = reportMsg.content.find(b => b.type === 'text')?.text?.trim() || '';
  console.log('[advisor] report length:', report.length);
  await sendMessage(report);

  // Paso 2: propuestas estructuradas por categoría
  const proponerTool = {
    name: 'proponer_operaciones',
    description: 'Registra propuestas por categoría. Omitir categorías donde no haya buena oportunidad.',
    input_schema: {
      type: 'object',
      properties: {
        propuestas_iol: {
          type: 'array',
          description: 'Hasta 4 propuestas de compra/venta en IOL (acciones, CEDEARs, bonos, o CEDEARs crypto como COIN/MSTR/MARA). Array vacío [] si no hay oportunidad.',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              simbolo: { type: 'string', description: 'Ticker exacto de cualquier instrumento disponible en IOL (acciones BCBA, CEDEARs, bonos). Podés proponer market movers aunque no estén en el WATCHLIST base.' },
              dir: { type: 'string', enum: ['compra', 'venta'] },
              pct_efectivo: { type: 'number', description: 'Fracción del efectivo ARS (0.10-0.50). Ventas: 0.' },
            },
            required: ['simbolo', 'dir', 'pct_efectivo'],
          },
        },
        propuesta_usd: {
          description: 'Una propuesta de dolarización via MEP/CCL. null si no aplica.',
          oneOf: [
            {
              type: 'object',
              properties: {
                simbolo: { type: 'string', description: 'DOLAR_MEP o DOLAR_CCL' },
                pct_efectivo: { type: 'number', description: 'Fracción del efectivo ARS a convertir (0.10-0.80)' },
              },
              required: ['simbolo', 'pct_efectivo'],
            },
            { type: 'null' },
          ],
        },
      },
      required: ['propuestas_iol'],
    },
  };

  const toolMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    tools: [proponerTool],
    tool_choice: { type: 'tool', name: 'proponer_operaciones' },
    messages: [
      { role: 'user', content: contexto },
      { role: 'assistant', content: report },
      { role: 'user', content: `Llamá a proponer_operaciones con las propuestas del reporte.

REGLA CAPITAL: El bot va a distribuir TODO el efectivo disponible ($${efectivo.toLocaleString('es-AR')} ARS) en partes iguales entre las compras que propongas. Si proponés 2 compras, cada una recibe ~50% del efectivo. Si proponés 1, recibe ~95%. Por eso: solo proponé compras con señal real — el capital se va a usar completo.

REGLA POSICIONES: Máximo 5 posiciones totales. Posiciones actuales: ${titulos.length}. Espacios disponibles: ${Math.max(0, 5 - titulos.length)}.

RECOMPRAS: Revisá la lista de SALIDAS RECIENTES. Si algún símbolo vendido tiene ahora señales técnicas favorables y no fue por stop-loss (o ya pasaron 24h), proponelo para recompra — tiene prioridad sobre un instrumento nuevo.

ESTRUCTURA:
• propuestas_iol: hasta ${Math.max(0, 5 - titulos.length)} compras nuevas (espacios libres en cartera) + ventas de posiciones existentes. [] si no hay señales claras.
• propuesta_usd: 1 o null. Solo si la brecha cambiaria lo justifica.

CRITERIO COMPRA: señal técnica clara (mínimo 2 señales alineadas) + no sobrecomprado.
CRITERIO VENTA: posición con tesis rota, RSI sobrecomprado, o mejor alternativa disponible.
CRITERIO NO OPERAR: Si la cartera actual ya está bien posicionada → mandá propuestas_iol: []. Es la respuesta correcta cuando no hay nada mejor.

Propuesta #1 = mayor urgencia/potencial. Alertas de stop-loss activas primero.` },
    ],
  });

  const toolBlock = toolMsg.content.find(b => b.type === 'tool_use' && b.name === 'proponer_operaciones');
  const input = toolBlock?.input ?? {};
  const propuestas_iol = input.propuestas_iol ?? [];
  const propuesta_usd  = input.propuesta_usd  ?? null;

  console.log('[advisor] tool input:', JSON.stringify(input));

  await cancelAllPending().catch(() => {});

  const techMap     = Object.fromEntries(technicals.map(t => [t.sym, t]));
  const portfolioMap = new Map(titulos.map(t => [t.simbolo, t]));
  const saved   = [];
  const blocked = [];
  let numCounter = 1;

  // ── Filtro intradiario ────────────────────────────────────────────────────────
  const todayBsAs = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const todayActions = {};
  for (const t of recentTrades) {
    if (t.fecha === todayBsAs && t.simbolo) todayActions[t.simbolo.toUpperCase()] = t.accion;
  }

  // ── Fase 1: recolectar propuestas sin guardar (para redistribuir capital) ─────
  const rawProposals = [];

  async function collectProposal(p, num) {
    const sym = p.simbolo?.toUpperCase();
    if (!sym) return;

    let precio  = techMap[sym]?.ultimo ?? null;
    let mercado = techMap[sym]?._mercado || 'bcba';
    if (!precio) {
      try {
        const cot = await getCotizacion(token, sym);
        precio  = extractPrecio(cot);
        mercado = cot._mercado || mercado;
      } catch (e) {
        console.log(`[advisor] ${sym} getCotizacion error:`, e.message);
      }
    }

    const rawSignals = techMap[sym]?.signals ?? [];

    // Filtro intradiario: no proponer venta de algo comprado hoy (ni compra de algo vendido hoy)
    if (p.dir === 'venta' && todayActions[sym]?.includes('compra')) {
      blocked.push({ num, simbolo: sym, dir: p.dir, razon: 'comprada esta sesión — no vender el mismo día', rawSignals });
      return;
    }
    if (p.dir === 'compra' && todayActions[sym]?.includes('venta_auto_stoploss')) {
      blocked.push({ num, simbolo: sym, dir: p.dir, razon: 'stop-loss ejecutado hoy — cooldown activo', rawSignals });
      return;
    }

    // Scale-in: posición ganadora con señal fuerte
    const posExistente = portfolioMap.get(sym);
    let accion = p.dir;
    if (posExistente && p.dir === 'compra') {
      const ppc    = posExistente.ppc;
      const actual = posExistente.ultimoPrecio;
      if (ppc > 0 && actual > ppc && rawSignals.length >= 3) {
        accion = 'scale_in';
        console.log(`[advisor] scale-in ${sym}: +${(((actual - ppc) / ppc) * 100).toFixed(1)}%`);
      } else if (ppc > 0 && actual <= ppc) {
        console.log(`[advisor] ${sym} saltada — posición perdedora, no se promedia`);
        return;
      }
    }

    // Filtros de diversificación (solo compras nuevas)
    if (p.dir === 'compra' && accion !== 'scale_in') {
      const sectorCheck = checkSectorConcentration(sym, titulos);
      if (!sectorCheck.ok) {
        blocked.push({ num, simbolo: sym, dir: p.dir, razon: sectorCheck.reason, rawSignals });
        return;
      }
      const currencyCheck = checkCurrencyExposure(sym, titulos);
      if (!currencyCheck.ok) {
        blocked.push({ num, simbolo: sym, dir: p.dir, razon: currencyCheck.reason, rawSignals });
        return;
      }
    }

    rawProposals.push({ num, sym, dir: p.dir, accion, precio, rawSignals, mercado });
  }

  for (const p of propuestas_iol.slice(0, 4)) {
    await collectProposal(p, numCounter++);
  }

  // ── Fase 2: distribuir TODO el efectivo entre las compras propuestas ──────────
  // Compras nuevas se reparten el 95% del efectivo en partes iguales.
  // Scale-in recibe la mitad de lo que le tocaría a una compra nueva.
  const newBuys   = rawProposals.filter(p => p.dir === 'compra' && p.accion !== 'scale_in');
  const scaleIns  = rawProposals.filter(p => p.accion === 'scale_in');
  // Unidades equivalentes: cada new buy = 1, cada scale-in = 0.5
  const totalUnits = newBuys.length + scaleIns.length * 0.5 || 1;
  const pctPerUnit = Math.min(0.95 / totalUnits, 0.95);

  for (const p of rawProposals) {
    if (p.dir === 'venta') { p.pctFinal = 0; continue; }
    p.pctFinal = p.accion === 'scale_in' ? pctPerUnit * 0.5 : pctPerUnit;
  }

  // ── Fase 3: guardar en Supabase con pcts definitivos ─────────────────────────
  for (const p of rawProposals) {
    const cantidad = p.precio && p.dir === 'compra' && efectivo > 0
      ? Math.floor(efectivo * p.pctFinal / p.precio) : null;
    const techSignals = p.rawSignals.map(s => s.detail);
    try {
      const row = await savePendingSignal({
        simbolo: p.sym, dir: p.dir,
        precio: p.precio ?? 0, cantidad: cantidad ?? null,
        ef_pre: efectivo,
        signals: [`propuesta:${p.num}`, `pct:${(p.pctFinal ?? 0).toFixed(3)}`, `mercado:${p.mercado}`, `accion:${p.accion}`, ...techSignals],
        status: 'pending',
      });
      saved.push({ num: p.num, simbolo: p.sym, dir: p.dir, accion: p.accion, precio: p.precio, cantidad, pct: p.pctFinal, id: row?.id ?? null, rawSignals: p.rawSignals });
    } catch (e) {
      console.log(`[advisor] ${p.sym} save error:`, e.message);
    }
  }

  // USD proposal
  if (propuesta_usd) {
    const sym = propuesta_usd.simbolo?.toUpperCase() ?? 'DOLAR_MEP';
    const pct = propuesta_usd.pct_efectivo ?? 0;
    try {
      await savePendingSignal({
        simbolo: sym, dir: 'dolar',
        precio: 0, cantidad: null,
        ef_pre: efectivo,
        signals: [`propuesta:${numCounter}`, `pct:${pct}`, `mercado:manual`],
        status: 'pending',
      });
      saved.push({ num: numCounter, simbolo: sym, dir: 'dolar', precio: null, cantidad: null, pct });
    } catch (e) { console.log('[advisor] usd save error:', e.message); }
    numCounter++;
  }

  console.log('[advisor] saved:', JSON.stringify(saved));

  if (saved.length === 0) {
    const bloqText = blocked.length > 0
      ? `\n\n_(${blocked.map(b => `${b.simbolo} bloqueada: ${b.razon}`).join('; ')})_`
      : '';
    await sendMessage(`✅ *Cartera bien posicionada — sin operaciones para este turno*\n\nNo hay señales técnicas que justifiquen mover capital ahora mismo. Se mantiene el portafolio actual.${bloqText}`);
    return;
  }

  // ── Enviar propuestas con urgencia para confirmación manual ─────────────────
  function urgencyLabel(rawSignals, dir) {
    const types = rawSignals.map(s => s.type ?? s);
    const hasBearish = types.some(t => ['DEATH_CROSS', 'MACD_BEARISH'].includes(t));
    const n = rawSignals.length;
    if (dir === 'venta' && hasBearish) return '🔴 URGENTE — señales de deterioro técnico, cada hora cuenta';
    if (n >= 4) return '🟠 ALTA — múltiples señales alineadas, ventana acotada';
    if (n >= 2) return '🟡 MEDIA — señal técnica confirmada';
    return '⚪ BAJA — señal inicial, podés esperar';
  }

  const propLines = saved.map(s => {
    const emoji = s.dir === 'venta' ? '📉' : s.dir === 'dolar' ? '💵' : '📈';
    const accionStr = s.accion === 'scale_in'
      ? 'SCALE-IN _(refuerzo de posición ganadora)_'
      : s.dir === 'dolar' ? 'DOLARIZAR'
      : s.dir.toUpperCase();
    const montoStr = s.dir === 'dolar'
      ? `~${(s.pct * 100).toFixed(0)}% del efectivo`
      : s.dir === 'venta'
      ? 'posición completa'
      : (s.cantidad && s.precio)
        ? `${s.cantidad} u. @ $${s.precio.toLocaleString('es-AR')} (≈$${Math.round(s.cantidad * s.precio).toLocaleString('es-AR')} ARS)`
        : `~${(s.pct * 100).toFixed(0)}% del efectivo`;
    const senalesStr = s.rawSignals?.length
      ? s.rawSignals.map(sig => sig.detail ?? sig).join(' | ')
      : 'análisis macro';
    const urgencia = urgencyLabel(s.rawSignals ?? [], s.dir);

    return `*${s.num}. ${emoji} ${s.simbolo}* — ${accionStr}\n` +
           `   💰 ${montoStr}\n` +
           `   📊 ${senalesStr}\n` +
           `   ⚡ ${urgencia}`;
  }).join('\n\n');

  // Propuestas bloqueadas por riesgo — visibles pero sin botón
  const blockedLines = blocked.length > 0
    ? '\n\n⛔ *BLOQUEADAS POR RIESGO DE PORTFOLIO*\n' +
      blocked.map(b =>
        `• *${b.simbolo}* — ${b.razon}`
      ).join('\n')
    : '';

  // Botones individuales en filas de 2
  const inlineButtons = [];
  const individualBtns = saved.map(s => {
    const emoji = s.dir === 'venta' ? '📉' : s.dir === 'dolar' ? '💵' : '📈';
    return { text: `${emoji} ${s.num}. ${s.simbolo}`, callback_data: `si:${s.num}` };
  });
  for (let i = 0; i < individualBtns.length; i += 2) {
    inlineButtons.push(individualBtns.slice(i, i + 2));
  }
  // Fila de acciones globales
  inlineButtons.push([
    { text: '✅ Confirmar todas', callback_data: 'si_todas' },
    { text: '🔄 Más propuestas',  callback_data: 'mas_propuestas' },
  ]);
  inlineButtons.push([{ text: '❌ Cancelar todo', callback_data: 'no' }]);

  await sendMessageWithButtons(
    `🔔 *PROPUESTAS*\n\n${propLines}${blockedLines}\n\n_Botones individuales, "Confirmar todas" o escribí */si 1 2 3*. */no* cancela._`,
    inlineButtons,
  );
}
