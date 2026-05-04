import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta, getCotizacion, extractPrecio, normalizePortfolio, crearOrden, roundToTick } from './iol.js';
import { sendMessage } from './telegram.js';
import { fetchMarketResearch } from './research.js';
import { fetchAllTechnicals, scanMarketMovers, WATCHLIST } from './analysis.js';
import { savePendingSignal, cancelAllPending, getRecentTrades, getRecentProposals, getCustomWatchlist, logTrade, updateSignalStatus, addCooldown } from './supabase.js';
import { getDolarData, formatDolarContext } from './dolar.js';
import { getCryptoPrices, getCryptoTrending, formatCryptoContext } from './crypto.js';
import { canBuy } from './riskManager.js';

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

  // Efectivo directo desde IOL — busca la cuenta en pesos, sino toma la de mayor saldo
  const c0 = cuenta.cuentas?.[0];
  const c1 = cuenta.cuentas?.[1];
  const cuentaPesos = [c0, c1].find(c => c?.moneda?.toLowerCase?.().includes('peso')) ??
                      [c0, c1].sort((a, b) => (b?.disponible ?? 0) - (a?.disponible ?? 0))[0];
  const efectivo =
    cuentaPesos?.disponible ??
    cuentaPesos?.saldo ??
    cuenta.disponible ??
    cuenta.saldo ??
    0;

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

SEÑALES TÉCNICAS (RSI, MA20/MA50, volumen, variación intradiaria):
${techLines}

TIPO DE CAMBIO (tiempo real):
${formatDolarContext(dolar)}

MERCADO CRYPTO (contexto para evaluar CEDEARs crypto — COIN, MSTR, MARA, RIOT, HOOD):
${cryptoContext}

MARKET MOVERS HOY (variación diaria):
${moversText || 'Sin datos de movers disponibles.'}
→ Prestá atención a estos instrumentos al armar propuestas. Mover con señal técnica + catalizador = oportunidad concreta.

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
Hasta 5 propuestas: 3 de IOL (acciones/bonos), 1 de crypto y 1 de USD/dolarización. Omití las categorías donde no haya oportunidad clara — es mejor decir "sin propuestas para crypto" que forzar una mala. Las IOL van ordenadas de mayor a menor potencial.

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

ESTRUCTURA:
• propuestas_iol: hasta 3, cada una diferente símbolo. [] si no hay buenas opciones.
• propuesta_crypto: 1 o null. Solo si hay momentum claro (>5% 24h, trending, correlación tech). Ventas solo si está en holdings estimados.
• propuesta_usd: 1 o null. Solo si la brecha cambiaria o el contexto macro lo justifica.

DIVERSIFICACIÓN: Símbolos distintos entre sí y no repetir de sesiones recientes salvo señal fuerte.

CRITERIO IOL COMPRA: momentum + fundamentals + no sobrecomprado.
CRITERIO IOL VENTA: test inverso (¿la comprarías hoy?), o caída >8% con señales deterioradas, o +15% RSI sobrecomprado.
CRITERIO CRYPTO COMPRA: pct_usdt = fracción del USDT de Binance.
CRITERIO USD: brecha CCL baja → dolarizar ocioso; brecha alta → esperar.

Propuesta IOL #1 = mayor potencial. Si hay alertas activas, abordarlas primero.` },
    ],
  });

  const toolBlock = toolMsg.content.find(b => b.type === 'tool_use' && b.name === 'proponer_operaciones');
  const input = toolBlock?.input ?? {};
  const propuestas_iol = input.propuestas_iol ?? [];
  const propuesta_usd  = input.propuesta_usd  ?? null;

  console.log('[advisor] tool input:', JSON.stringify(input));

  await cancelAllPending().catch(() => {});

  const techMap = Object.fromEntries(technicals.map(t => [t.sym, t]));
  const saved = [];
  let numCounter = 1;

  // Helper para guardar una señal IOL
  async function saveIolSignal(p, num) {
    const sym = p.simbolo?.toUpperCase();
    if (!sym) return;

    let precio = techMap[sym]?.ultimo ?? null;
    let mercado = techMap[sym]?._mercado || 'bcba';
    if (!precio) {
      try {
        const cot = await getCotizacion(token, sym);
        precio = extractPrecio(cot);
        mercado = cot._mercado || mercado;
      } catch (e) {
        console.log(`[advisor] ${sym} getCotizacion error:`, e.message);
      }
    }

    const cantidad = precio && p.dir === 'compra' && p.pct_efectivo && efectivo > 0
      ? Math.floor(efectivo * p.pct_efectivo / precio) : null;

    const techSignals = techMap[sym]?.signals?.map(s => s.detail) || [];

    try {
      const row = await savePendingSignal({
        simbolo: sym, dir: p.dir,
        precio: precio ?? 0, cantidad: cantidad ?? null,
        ef_pre: efectivo,
        signals: [`propuesta:${num}`, `pct:${p.pct_efectivo ?? 0}`, `mercado:${mercado}`, ...techSignals],
        status: 'pending',
      });
      saved.push({
        num, simbolo: sym, dir: p.dir, precio, cantidad, pct: p.pct_efectivo ?? 0,
        id: row?.id ?? null,
        rawSignals: techMap[sym]?.signals ?? [],
      });
    } catch (e) {
      console.log(`[advisor] ${sym} save error:`, e.message);
    }
  }

  // IOL proposals (hasta 4, incluyendo CEDEARs crypto)
  for (const p of propuestas_iol.slice(0, 4)) {
    await saveIolSignal(p, numCounter++);
  }

  // USD proposal (next num)
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
    await sendMessage('📊 *Sin propuestas para este turno* — no hay señales con suficiente convicción ahora mismo.');
    return;
  }

  // ── Auto-ejecución total con controles de riesgo ──────────────────────────
  const openPositions = titulos.length;
  const ejecutadas    = [];
  const bloqueadas    = [];

  for (const s of saved) {
    // Ventas: verificar pausa + horario
    if (s.dir === 'venta') {
      if (!s.precio || !s.cantidad || s.cantidad < 1) continue;
      const precioLimite = roundToTick(s.precio * 0.99, 'venta');
      try {
        await crearOrden(token, { simbolo: s.simbolo, cantidad: s.cantidad, precio: precioLimite, operacion: 'venta' });
        await logTrade({
          fecha: new Date().toISOString().slice(0, 10),
          hora:  new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
          simbolo: s.simbolo, accion: 'venta_auto', precio: precioLimite,
          cantidad: s.cantidad, monto: Math.round(precioLimite * s.cantidad),
          senales: s.rawSignals.map(sig => sig.detail ?? sig), efectivo_pre: efectivo,
        }).catch(() => {});
        if (s.id) await updateSignalStatus(s.id, 'auto_ejecutado').catch(() => {});
        ejecutadas.push(`📉 *${s.simbolo}* — VENTA ${s.cantidad} u. @ $${precioLimite.toLocaleString('es-AR')}`);
      } catch (e) {
        bloqueadas.push(`📉 *${s.simbolo}* venta fallida: ${e.message}`);
      }
      continue;
    }

    // Compras: pasar por el risk manager
    if (s.dir === 'compra') {
      if (!s.precio || !s.cantidad || s.cantidad < 1) continue;
      const check = await canBuy({ simbolo: s.simbolo, pct: s.pct, efectivo, openPositions: openPositions + ejecutadas.length });
      if (!check.allowed) {
        bloqueadas.push(`⛔ *${s.simbolo}* bloqueada — ${check.reason}`);
        console.log(`[advisor] ${s.simbolo} bloqueada: ${check.reason}`);
        continue;
      }
      const precioLimite = roundToTick(s.precio * 1.01, 'compra');
      try {
        await crearOrden(token, { simbolo: s.simbolo, cantidad: s.cantidad, precio: precioLimite, operacion: 'compra' });
        await logTrade({
          fecha: new Date().toISOString().slice(0, 10),
          hora:  new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
          simbolo: s.simbolo, accion: 'compra_auto', precio: precioLimite,
          cantidad: s.cantidad, monto: Math.round(precioLimite * s.cantidad),
          senales: s.rawSignals.map(sig => sig.detail ?? sig), efectivo_pre: efectivo,
        }).catch(() => {});
        if (s.id) await updateSignalStatus(s.id, 'auto_ejecutado').catch(() => {});
        ejecutadas.push(
          `📈 *${s.simbolo}* — COMPRA ${s.cantidad} u. @ $${precioLimite.toLocaleString('es-AR')} ` +
          `(≈$${Math.round(precioLimite * s.cantidad).toLocaleString('es-AR')} ARS)\n` +
          `↳ ${s.rawSignals.map(sig => sig.detail ?? sig).join(' | ')}`
        );
        console.log(`[advisor] auto-compra ejecutada: ${s.simbolo}`);
      } catch (e) {
        bloqueadas.push(`📈 *${s.simbolo}* compra fallida: ${e.message}`);
        console.log(`[advisor] ${s.simbolo} error:`, e.message);
      }
      continue;
    }

    // USD / dolar: solo notificar (no auto-ejecutar, requiere acción manual en el broker)
    if (s.dir === 'dolar') {
      bloqueadas.push(`💵 *${s.simbolo}* — dolarizar ${(s.pct * 100).toFixed(0)}% (acción manual requerida en IOL)`);
    }
  }

  // Resumen de ejecuciones
  const partes = [];
  if (ejecutadas.length > 0) partes.push(`✅ *EJECUTADAS*\n${ejecutadas.join('\n\n')}`);
  if (bloqueadas.length > 0) partes.push(`ℹ️ *NO EJECUTADAS*\n${bloqueadas.join('\n')}`);

  if (partes.length > 0) {
    await sendMessage(`🤖 *TRADING AUTOMÁTICO*\n\n${partes.join('\n\n')}`);
  }
}
