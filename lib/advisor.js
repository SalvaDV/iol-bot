import Anthropic from '@anthropic-ai/sdk';
import { getToken, getPortfolio, getCuenta, getCotizacion, extractPrecio } from './iol.js';
import { sendMessage } from './telegram.js';
import { fetchMarketResearch } from './research.js';
import { fetchAllTechnicals, WATCHLIST } from './analysis.js';
import { savePendingSignal, cancelAllPending, getRecentTrades, saveProposal, getPerformanceStats, getRecentProposals, getLastEfectivoPost } from './supabase.js';
import { getDolarData, formatDolarContext } from './dolar.js';
import { getCryptoPrices, getCryptoTrending, formatCryptoContext } from './crypto.js';

export async function runAdvisor() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

  const [token, research, recentTrades, dolar, recentProposals, lastTrade, cryptoPrices, cryptoTrending] = await Promise.all([
    getToken(),
    fetchMarketResearch(),
    getRecentTrades(10),
    getDolarData(),
    getRecentProposals(9),
    getLastEfectivoPost(),
    getCryptoPrices(),
    getCryptoTrending(),
  ]);

  const [portfolio, cuenta, technicals] = await Promise.all([
    getPortfolio(token),
    getCuenta(token),
    fetchAllTechnicals(token),
  ]);

  const c0 = cuenta.cuentas?.[0];
  const c1 = cuenta.cuentas?.[1];
  const cuentaPesos = [c0, c1].find(c => c?.moneda?.toLowerCase?.().includes('peso')) ??
                      [c0, c1].sort((a, b) => (b?.disponible ?? 0) - (a?.disponible ?? 0))[0];
  const efectivoLive =
    cuentaPesos?.disponible ??
    cuentaPesos?.saldo ??
    cuenta.disponible ??
    cuenta.saldo ??
    0;

  // Si hay un efectivo_post reciente (últimas 72h), usarlo como techo:
  // IOL puede no reflejar aún operaciones no liquidadas (T+2), así que usamos
  // el menor entre el saldo live y el efectivo_post calculado en la última operación.
  const efectivoPost = lastTrade?.efectivo_post ?? null;
  const efectivo = (efectivoPost !== null && efectivoPost < efectivoLive)
    ? efectivoPost
    : efectivoLive;

  console.log('[advisor] efectivo:', JSON.stringify({ efectivoLive, efectivoPost, efectivoUsado: efectivo }));

  // Mapa de precio de compra desde trading_log (fallback si IOL no devuelve ppc)
  const ppcFromTrades = {};
  for (const t of recentTrades) {
    if (t.accion === 'compra' && t.simbolo && t.precio && !ppcFromTrades[t.simbolo]) {
      ppcFromTrades[t.simbolo] = t.precio;
    }
  }

  const alertasPosicion = [];
  const posiciones = (portfolio.titulos || [])
    .map(t => {
      const precio = t.ultimoPrecio ?? t.precioActual ?? null;
      const variacion = t.variacionDiaria != null ? `${t.variacionDiaria.toFixed(2)}%` : '?';
      const total = (t.cantidad && precio)
        ? `$${(t.cantidad * precio).toLocaleString('es-AR')}`
        : '?';

      // Detectar alertas P&L
      const ppc = t.ppc ?? t.precioPromedio ?? t.costoPromedio ?? ppcFromTrades[t.simbolo] ?? null;
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
    .map(t => `• ${t.sym}: ${t.dir.toUpperCase()} — RSI ${t.rsi?.toFixed(0) ?? '?'} | ${t.signals.map(s => s.detail).join(' | ')}`)
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
  const totalInvertido = (portfolio.titulos || []).reduce((s, t) => {
    const p = t.ultimoPrecio ?? t.precioActual ?? 0;
    return s + (t.cantidad && p ? t.cantidad * p : 0);
  }, 0);
  const concentracion = totalInvertido > 0
    ? (portfolio.titulos || []).map(t => {
        const p = t.ultimoPrecio ?? t.precioActual ?? 0;
        const val = t.cantidad && p ? t.cantidad * p : 0;
        return `${t.simbolo}: ${((val / totalInvertido) * 100).toFixed(0)}%`;
      }).join(', ')
    : 'Sin posiciones';

  const cryptoContext = formatCryptoContext(cryptoPrices, cryptoTrending);

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

CRYPTO (precios USD — el usuario ejecuta manualmente en su exchange):
${cryptoContext}

NOTICIAS Y CONTEXTO:
${researchText}

Instrumentos disponibles en IOL: ${WATCHLIST.join(', ')}
Crypto disponible (ejecución manual por el usuario): BTC, ETH, SOL, BNB, XRP, MATIC, ADA, DOGE
Dólar: podés recomendar DOLAR_MEP o DOLAR_CCL si dolarizar es la mejor opción (ejecución manual).`;

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
3 propuestas ordenadas por potencial de retorno (la más agresiva primero). Para cada una: instrumento, por qué AHORA, target de salida o stop loss, y qué señal invalidaría la tesis. Incluí crypto si hay oportunidad clara.

⚡ *CATALIZADORES A VIGILAR*
1-2 eventos en las próximas horas/días que pueden mover fuerte (earnings, datos macro, movimiento de BTC, decisiones del BCRA).

Máximo 400 palabras. Lenguaje de trader — directo, sin rodeos.`,
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
              simbolo: { type: 'string', description: 'Ticker exacto en IOL, DOLAR_MEP/DOLAR_CCL para dolarización, o símbolo crypto (BTC, ETH, SOL, etc.)' },
              dir: { type: 'string', enum: ['compra', 'venta', 'dolar', 'crypto'], description: 'crypto = compra manual en exchange por el usuario' },
              pct_efectivo: { type: 'number', description: 'Fracción del efectivo ARS a destinar (0.10-0.50). Ventas: 0.' },
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

DIVERSIFICACIÓN OBLIGATORIA: Las 3 propuestas deben ser símbolos distintos. Mezclá tipos: acciones BCBA, CEDEARs, bonos, crypto. Si un instrumento fue propuesto en sesiones recientes, preferí alternativas salvo que la señal sea excepcionalmente fuerte.

CRITERIO CRYPTO: incluí una propuesta crypto si hay momentum claro (movimiento >5% en 24h, trending, correlación con CEDEARs tech). El usuario la ejecuta manualmente en su exchange. Usá pct_efectivo en ARS equivalente.

CRITERIO VENTAS:
• Test inverso: ¿la comprarías hoy? Si no → salir
• Stop loss: caída >8% con señales técnicas deterioradas
• Toma de ganancias: +15% Y RSI sobrecomprado O resistencia técnica

CRITERIO COMPRA AGRESIVA: momentum fuerte (RSI subiendo desde zona media, ruptura de MA, volumen alto), no esperés confirmación perfecta — el riesgo es parte del perfil.

CRITERIO DOLAR: si brecha CCL <40%, puede ser momento de dolarizar efectivo ocioso.

Propuesta 1 = mayor potencial de retorno (puede ser la más arriesgada).
Si hay alertas activas de posición, abordá primero esa en propuesta 1.` },
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
    let mercado = techMap[sym]?._mercado || 'bcba';
    if (!precio) {
      try {
        const cot = await getCotizacion(token, sym);
        precio = extractPrecio(cot);
        mercado = cot._mercado || mercado;
        console.log(`[advisor] ${sym} cotizacion keys:`, Object.keys(cot).join(','), 'precio=', precio, 'mercado=', mercado);
      } catch (e) {
        console.log(`[advisor] ${sym} getCotizacion error:`, e.message);
      }
    }

    // Guardar siempre — precio puede ser null (se resuelve al ejecutar)
    const cantidad = precio && p.dir === 'compra' && p.pct_efectivo && efectivo > 0
      ? Math.floor(efectivo * p.pct_efectivo / precio)
      : null;

    console.log(`[advisor] ${sym}: precio=${precio} cantidad=${cantidad} pct=${p.pct_efectivo} mercado=${mercado}`);

    const techSignals = techMap[sym]?.signals?.map(s => s.detail) || [];

    try {
      await savePendingSignal({
        simbolo: sym,
        dir: p.dir,
        precio: precio ?? 0,
        cantidad: cantidad ?? null,
        ef_pre: efectivo,
        signals: [`propuesta:${i + 1}`, `pct:${p.pct_efectivo}`, `mercado:${mercado}`, ...techSignals],
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
    } else if (s.cantidad && s.cantidad >= 1 && s.precio) {
      const montoARS = Math.round(s.cantidad * s.precio).toLocaleString('es-AR');
      montoStr = `${s.cantidad} u. @ $${s.precio} (≈$${montoARS} ARS)`;
    } else {
      const montoARS = Math.round(efectivo * s.pct).toLocaleString('es-AR');
      montoStr = `≈$${montoARS} ARS (${(s.pct * 100).toFixed(0)}% del efectivo)`;
    }
    return `${s.num}️⃣ *${s.simbolo}* — ${s.dir === 'compra' ? '📈 COMPRA' : '📉 VENTA'}: ${montoStr}`;
  }).join('\n');

  await sendMessage(
    `🚨 *PROPUESTAS LISTAS PARA EJECUTAR*\n\n${lines}\n\n` +
    `Respondé */si 1*, */si 2* o */si 3* para ejecutar esa propuesta.\n` +
    `*/no* para cancelar todas.`
  );
}
