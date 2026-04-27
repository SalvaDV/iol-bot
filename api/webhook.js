import { getToken, crearOrden, getPortfolio, getCotizacion, getCuenta, getOrden, extractPrecio } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import {
  getPendingSignals, updateSignalStatus, logTrade, cancelAllPending, getRecentTrades,
} from '../lib/supabase.js';
import { runAdvisor } from '../lib/advisor.js';
import { preTradeCheck } from '../lib/preTradeCheck.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

async function handleAnalisis() {
  await sendMessage('🔍 *Analizando mercado...*\nConsultando noticias, técnicos y portafolio. Tardará ~40 segundos.');
  try {
    await runAdvisor();
  } catch (err) {
    await sendMessage(`❌ Error en análisis: ${err.message}`).catch(() => {});
  }
}

function getPct(pending) {
  const sig = pending.signals?.find(s => s?.startsWith('pct:'));
  return sig ? parseFloat(sig.replace('pct:', '')) : 0.15;
}

function getMercado(pending) {
  const sig = pending.signals?.find(s => s?.startsWith('mercado:'));
  return sig ? sig.replace('mercado:', '') : 'bcba';
}

async function handleConfirmN(n, { skipCheck = false } = {}) {
  try {
    const signals = await getPendingSignals();
    if (signals.length === 0) {
      await sendMessage('⚠️ No hay propuestas pendientes.');
      return;
    }

    const pending = signals.find(s => s.signals?.[0] === `propuesta:${n}`) ?? signals[n - 1];
    if (!pending) {
      await sendMessage(`⚠️ No existe propuesta ${n}. Tenés ${signals.length} propuesta(s) disponible(s).`);
      return;
    }

    // Pre-trade check: solo para compra/venta de acciones (no para dolar)
    if (!skipCheck && pending.dir !== 'dolar') {
      await sendMessage(`🔎 *Verificando noticias recientes de ${pending.simbolo}...*`);
      const check = await preTradeCheck(pending.simbolo, pending.dir);
      if (check.material && check.recomendacion === 'pausar') {
        await sendMessage(
          `⚠️ *Noticia material detectada antes de ejecutar*\n\n` +
          `*${pending.simbolo}* (${pending.dir.toUpperCase()})\n\n` +
          `${check.resumen}\n\n` +
          `🤔 ¿Querés ejecutar igual? Respondé */forzar ${n}* para proceder, o */no* para cancelar.`
        );
        return;
      }
      if (check.material) {
        await sendMessage(`ℹ️ Contexto: ${check.resumen}\n\nProcediendo con la operación...`);
      }
    }

    await updateSignalStatus(pending.id, 'procesando');
    for (const s of signals) {
      if (s.id !== pending.id) await updateSignalStatus(s.id, 'cancelado').catch(() => {});
    }

    const token = await getToken();

    // Caso dólar — operación manual
    if (pending.dir === 'dolar') {
      const pct = getPct(pending);
      await sendMessage(
        `💵 *Recomendación: Comprar dólares*\n\n` +
        `El análisis sugiere dolarizar ~*${(pct * 100).toFixed(0)}%* del efectivo disponible.\n\n` +
        `*Cómo ejecutarlo en IOL:*\n` +
        `1. Ingresá a invertironline.com\n` +
        `2. Buscá el bono *AL30* (pesos) → vendelo\n` +
        `3. Comprá *AL30D* (dólares) con el mismo monto\n` +
        `_(Esto es la operación Dólar MEP)_\n\n` +
        `O si tenés CEDEARs: vendé en ARS y recomprá en USD para armar CCL.\n\n` +
        `Símbolo sugerido: *${pending.simbolo}*`
      );
      await updateSignalStatus(pending.id, 'ejecutado');
      await logTrade({
        fecha: new Date().toISOString().slice(0, 10),
        hora: new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
        simbolo: pending.simbolo,
        accion: 'dolar_manual',
        precio: 0,
        cantidad: 0,
        monto: 0,
        senales: pending.signals,
        efectivo_pre: pending.ef_pre,
      }).catch(() => {});
      return;
    }

    // Precio en tiempo real
    const mercadoSignal = getMercado(pending);
    let precioLive = null;
    let precioError = null;
    let mercadoFinal = mercadoSignal;
    try {
      // getCotizacion ya prueba múltiples mercados internamente
      const cot = await getCotizacion(token, pending.simbolo);
      precioLive = extractPrecio(cot);
      mercadoFinal = cot._mercado || mercadoSignal;
      if (!precioLive) precioError = `campos: ${Object.keys(cot).join(',')} valores: ${JSON.stringify(cot).slice(0, 200)}`;
    } catch (e) {
      precioError = e.message;
    }

    let cantidadFinal, precioLimite;

    if (pending.dir === 'venta') {
      const portfolio = await getPortfolio(token);
      const pos = (portfolio.titulos || []).find(
        t => t.simbolo?.toUpperCase() === pending.simbolo.toUpperCase()
      );
      cantidadFinal = pos?.cantidad || 0;
      if (!cantidadFinal) {
        await sendMessage(`⚠️ No tenés posición en ${pending.simbolo}.`);
        await updateSignalStatus(pending.id, 'cancelado');
        return;
      }
      // Precio límite venta: 1% por debajo del live (o precio guardado)
      precioLimite = precioLive ? Math.floor(precioLive * 0.99) : pending.precio;
    } else {
      // Precio límite compra: 1% por encima del live (o precio guardado)
      precioLimite = precioLive ? Math.ceil(precioLive * 1.01) : pending.precio;
      const pct = getPct(pending);
      const cuenta = await getCuenta(token);

      // IOL puede devolver el saldo en distintos campos/niveles; probamos varios
      const c0 = cuenta.cuentas?.[0];
      const c1 = cuenta.cuentas?.[1];
      // Buscar la cuenta en pesos (la que tiene mayor disponible, o la de moneda peso)
      const cuentaPesos = [c0, c1].find(c => c?.moneda?.toLowerCase?.().includes('peso')) ??
                          [c0, c1].sort((a, b) => (b?.disponible ?? 0) - (a?.disponible ?? 0))[0];
      const efectivoLive =
        cuentaPesos?.disponible ??
        cuentaPesos?.saldo ??
        cuenta.disponible ??
        cuenta.saldo ??
        0;

      // Fallback al efectivo guardado en la señal si el live vino 0 (probable fallo de campo)
      const efectivoActual = efectivoLive > 0 ? efectivoLive : (pending.ef_pre ?? 0);
      const fuenteEfectivo = efectivoLive > 0 ? 'live' : 'guardado al analizar';

      if (precioLimite <= 0) {
        await sendMessage(
          `⚠️ No pude obtener precio de ${pending.simbolo} para calcular la orden.\n` +
          `Precio guardado: $${pending.precio} | Precio live: ${precioLive ?? 'no disponible'}\n` +
          `${precioError ? `Error IOL: ${precioError}` : ''}`
        );
        await updateSignalStatus(pending.id, 'cancelado');
        return;
      }

      cantidadFinal = Math.floor(efectivoActual * pct / precioLimite);
      if (!cantidadFinal || cantidadFinal < 1) {
        await sendMessage(
          `⚠️ Efectivo insuficiente para comprar ${pending.simbolo}.\n` +
          `Efectivo (${fuenteEfectivo}): $${efectivoActual.toLocaleString('es-AR')} | Precio límite: $${precioLimite} | %: ${(pct * 100).toFixed(0)}%\n` +
          `Necesitás al menos $${precioLimite.toLocaleString('es-AR')} disponible.`
        );
        await updateSignalStatus(pending.id, 'cancelado');
        return;
      }
    }

    const orden = await crearOrden(token, {
      mercado: mercadoFinal,
      simbolo: pending.simbolo,
      cantidad: cantidadFinal,
      precio: precioLimite,
      operacion: pending.dir,
    });

    // Buscar el número de orden en todos los campos posibles
    const ordenNum = orden.numero ?? orden.id ?? orden.nroOperacion ?? orden.numeroOperacion ??
                     orden.nro ?? orden.orderNumber ?? orden.numeroPedido ?? null;
    console.log('[crearOrden] response keys:', Object.keys(orden).join(','), 'full:', JSON.stringify(orden).slice(0, 300));

    await updateSignalStatus(pending.id, 'ejecutado');
    await logTrade({
      fecha: new Date().toISOString().slice(0, 10),
      hora: new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      simbolo: pending.simbolo,
      accion: pending.dir,
      precio: precioLimite,
      cantidad: cantidadFinal,
      monto: cantidadFinal * precioLimite,
      senales: pending.signals,
      efectivo_pre: pending.ef_pre,
    });

    await sendMessage(
      `✅ *Orden enviada a IOL*\n\n` +
      `*${pending.simbolo}* — ${pending.dir.toUpperCase()}\n` +
      `📦 Cantidad: ${cantidadFinal}\n` +
      `💵 Precio límite: $${precioLimite}${precioLive ? ` (cotización live: $${precioLive})` : ''}\n` +
      `🔑 Orden #${ordenNum ?? 'N/A'}\n\n` +
      `⏳ Verificando en 15 segundos...`
    );

    // Verificación post-orden
    await new Promise(r => setTimeout(r, 15000));
    if (ordenNum) {
      try {
        const estadoOrden = await getOrden(token, ordenNum);
        const estado = estadoOrden.estado || estadoOrden.status || estadoOrden.estadoOrden || 'desconocido';
        const emoji = estado.toLowerCase().includes('ejecut') ? '✅' :
                      estado.toLowerCase().includes('cancel') ? '❌' : '⏳';
        await sendMessage(`${emoji} *Orden #${ordenNum}*: ${estado}`);
      } catch {
        await sendMessage(`📊 *Orden #${ordenNum}* enviada. Verificá el estado en IOL.`);
      }
    } else {
      await sendMessage(`📊 Orden enviada a IOL. Verificá el estado en la app (número no disponible en la respuesta).`);
    }
  } catch (err) {
    await sendMessage(`❌ Error ejecutando propuesta ${n}: ${err.message}`).catch(() => {});
  }
}

async function handlePortafolio() {
  try {
    const token = await getToken();
    const [portfolio, cuenta] = await Promise.all([getPortfolio(token), getCuenta(token)]);
    const efectivo = cuenta.cuentas?.[0]?.disponible ?? 0;
    const titulos = portfolio.titulos || [];

    if (titulos.length === 0) {
      await sendMessage(`💼 *Portafolio*\n\nSin posiciones abiertas.\n💵 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS`);
      return;
    }

    const lines = titulos.map(t => {
      const precio = t.ultimoPrecio ?? t.precioActual ?? 0;
      const ppc = t.ppc ?? t.precioPromedio ?? t.costoPromedio ?? null;
      const total = t.cantidad && precio ? (t.cantidad * precio) : 0;
      const variacion = t.variacionDiaria != null ? `${t.variacionDiaria >= 0 ? '+' : ''}${t.variacionDiaria.toFixed(2)}%` : '?';

      let pnlStr = '';
      if (ppc && ppc > 0 && precio) {
        const pnlPct = (precio - ppc) / ppc * 100;
        const pnlMonto = (precio - ppc) * (t.cantidad || 0);
        pnlStr = ` | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${pnlMonto.toLocaleString('es-AR')})`;
      }

      return `• *${t.simbolo}*: ${t.cantidad} u. @ $${precio} (${variacion} hoy)${pnlStr}\n  Total: $${total.toLocaleString('es-AR')} ARS`;
    }).join('\n');

    const totalPortafolio = titulos.reduce((sum, t) => {
      const precio = t.ultimoPrecio ?? t.precioActual ?? 0;
      return sum + (t.cantidad && precio ? t.cantidad * precio : 0);
    }, 0);

    await sendMessage(
      `💼 *Portafolio*\n\n${lines}\n\n` +
      `💵 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS\n` +
      `📊 Total invertido: $${totalPortafolio.toLocaleString('es-AR')} ARS\n` +
      `🏦 Patrimonio total: $${(efectivo + totalPortafolio).toLocaleString('es-AR')} ARS`
    );
  } catch (err) {
    await sendMessage(`❌ Error: ${err.message}`).catch(() => {});
  }
}

async function handleHistorial() {
  try {
    const trades = await getRecentTrades(10);
    if (trades.length === 0) {
      await sendMessage('📋 *Historial*\n\nSin operaciones registradas aún.');
      return;
    }
    const lines = trades.map(t => {
      const emoji = t.accion === 'compra' ? '📈' : t.accion === 'venta' ? '📉' : '💵';
      return `${emoji} *${t.simbolo}* — ${t.accion?.toUpperCase()} ${t.cantidad ?? ''} u. @ $${t.precio} | $${t.monto?.toLocaleString('es-AR')} | ${t.fecha}`;
    }).join('\n');
    await sendMessage(`📋 *Últimas operaciones*\n\n${lines}`);
  } catch (err) {
    await sendMessage(`❌ Error: ${err.message}`).catch(() => {});
  }
}

async function handlePrecio(simbolo) {
  try {
    const token = await getToken();
    const cot = await getCotizacion(token, simbolo.toUpperCase());
    const precio = extractPrecio(cot) ?? '?';
    const apertura = cot.apertura ?? null;
    const variacion = cot.variacion ?? cot.variacionDiaria ?? null;
    const volumen = cot.cantidadOperaciones ?? cot.volumen ?? null;

    let msg = `📌 *${simbolo.toUpperCase()}*\n💵 Precio: $${precio}`;
    if (variacion != null) msg += `\n📊 Variación: ${variacion >= 0 ? '+' : ''}${variacion.toFixed ? variacion.toFixed(2) : variacion}%`;
    if (apertura) msg += `\n🔓 Apertura: $${apertura}`;
    if (volumen) msg += `\n📦 Volumen: ${volumen.toLocaleString('es-AR')}`;

    await sendMessage(msg);
  } catch (err) {
    await sendMessage(`❌ No encontré cotización para *${simbolo.toUpperCase()}*\n\`${err.message}\``).catch(() => {});
  }
}

async function handleDebugCot(simbolo) {
  try {
    const token = await getToken();
    const cot = await getCotizacion(token, simbolo.toUpperCase());
    await sendMessage(`🔬 *Raw IOL response para ${simbolo.toUpperCase()}*\n\`\`\`\n${JSON.stringify(cot, null, 2).slice(0, 800)}\n\`\`\``);
  } catch (err) {
    await sendMessage(`❌ Error: \`${err.message}\``);
  }
}

async function handleCancelAll() {
  try {
    await cancelAllPending();
    await sendMessage('🚫 Todas las propuestas canceladas.');
  } catch (err) {
    await sendMessage(`❌ Error cancelando: ${err.message}`).catch(() => {});
  }
}

// Normalize command: strip leading slash, strip @botname suffix, lowercase
function parseCommand(raw) {
  return raw.trim().toLowerCase().replace(/^\//, '').replace(/@\w+$/, '').trim();
}

function isAuthorized(msg) {
  const allowed = process.env.TG_ALLOWED_USERS?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
  if (allowed.length === 0) return true;
  return allowed.includes(String(msg.from?.id));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end('ok');

  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
  } catch {
    return res.status(200).end('ok');
  }

  const msg = body?.message;
  if (!msg?.text) return res.status(200).end('ok');

  const text = parseCommand(msg.text);

  const siMatch = text.match(/^si\s+([123])$/);
  const forzarMatch = text.match(/^forzar\s+([123])$/);
  const precioMatch = text.match(/^precio\s+(\w+)$/);
  const debugMatch = text.match(/^debug\s+(\w+)$/);

  // Read-only commands: anyone in the group can use
  if (text === 'precio dolar' || text === 'precio usd' || text === 'precio dollar') {
    const { getDolarData, formatDolarContext } = await import('../lib/dolar.js');
    const d = await getDolarData();
    await sendMessage(`💵 *Dólar — cotizaciones actuales*\n\n${formatDolarContext(d)}`);
  } else if (precioMatch && ['dolar','usd','dollar'].includes(precioMatch[1])) {
    const { getDolarData, formatDolarContext } = await import('../lib/dolar.js');
    const d = await getDolarData();
    await sendMessage(`💵 *Dólar — cotizaciones actuales*\n\n${formatDolarContext(d)}`);
  } else if (precioMatch) {
    await handlePrecio(precioMatch[1]);
  } else if (debugMatch) {
    await handleDebugCot(debugMatch[1]);
  } else if (text === 'ayuda' || text === 'help' || text === 'start') {
    await sendMessage(
      `🤖 *Comandos disponibles*\n\n` +
      `*/analizar* — análisis completo del mercado\n` +
      `*/portafolio* — posiciones actuales con P&L\n` +
      `*/historial* — últimas operaciones\n` +
      `*/precio TICKER* — cotización de un instrumento\n` +
      `*/estado* — propuestas pendientes\n` +
      `*/si 1/2/3* — ejecutar propuesta N (con check de noticias)\n` +
      `*/forzar 1/2/3* — ejecutar saltando el check de noticias\n` +
      `*/no* — cancelar todas las propuestas`
    );
  } else {
    // Sensitive commands: owner only
    if (!isAuthorized(msg)) return res.status(200).end('ok');

    if (text === 'analizar') {
      await handleAnalisis();
    } else if (siMatch) {
      await handleConfirmN(parseInt(siMatch[1]));
    } else if (forzarMatch) {
      await handleConfirmN(parseInt(forzarMatch[1]), { skipCheck: true });
    } else if (text === 'si' || text === 'sí') {
      await sendMessage('¿A cuál propuesta? Respondé */si 1*, */si 2* o */si 3*.\nO mandá */estado* para ver las opciones pendientes.');
    } else if (text === 'no') {
      await handleCancelAll();
    } else if (text === 'portafolio') {
      await handlePortafolio();
    } else if (text === 'historial') {
      await handleHistorial();
    } else if (text === 'estado') {
      try {
        const signals = await getPendingSignals();
        if (signals.length === 0) {
          await sendMessage('📋 Sin propuestas pendientes.');
        } else {
          const lines = signals.map(s => {
            const num = s.signals?.[0]?.replace('propuesta:', '') ?? '?';
            const pctSig = s.signals?.find(x => x?.startsWith('pct:'));
            const pctVal = pctSig ? parseFloat(pctSig.replace('pct:', '')) : null;
            const pctStr = pctVal != null ? `${(pctVal * 100).toFixed(0)}%` : '';
            // Mostrar monto en ARS si tenemos ef_pre y pct, aunque no tengamos precio exacto
            const montoARS = pctVal && s.ef_pre ? `$${Math.round(s.ef_pre * pctVal).toLocaleString('es-AR')} ARS` : null;
            let detalle;
            if (s.dir === 'dolar') detalle = `💵 DOLARIZAR ${pctStr}`;
            else if (s.dir === 'venta') detalle = '📉 VENTA posición completa';
            else if (s.cantidad && s.precio) detalle = `📈 COMPRA ${s.cantidad} u. @ $${s.precio}${montoARS ? ` (≈${montoARS})` : ''}`;
            else detalle = `📈 COMPRA ≈${montoARS ?? pctStr} del efectivo`;
            return `${num}. *${s.simbolo}* — ${detalle}`;
          }).join('\n');
          await sendMessage(`📋 *Propuestas pendientes:*\n\n${lines}\n\nRespondé */si 1/2/3* o */no*`);
        }
      } catch (err) {
        await sendMessage(`❌ Error: ${err.message}`).catch(() => {});
      }
    }
  }

  res.status(200).end('ok');
}
