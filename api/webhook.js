import { getToken, crearOrden, getPortfolio, getCotizacion, getCuenta, getOrden, extractPrecio, roundToTick, searchInstrumento, normalizePortfolio } from '../lib/iol.js';
import { sendMessage, sendMessageWithButtons, replyForceReply, answerCallbackQuery, removeButtons } from '../lib/telegram.js';
import {
  getPendingSignals, updateSignalStatus, logTrade, updateTrade, cancelAllPending, getRecentTrades,
  getUserState, setUserState, clearUserState, addToWatchlist, getBotConfig, setBotConfig, getCooldowns,
} from '../lib/supabase.js';
import { runAdvisor } from '../lib/advisor.js';
import { preTradeCheck } from '../lib/preTradeCheck.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

// Comisión IOL total estimada: 0.50% + IVA 21% + derechos BYMA ~0.03% ≈ 0.635%
const COMISION_RATE = 0.00635;

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

function getMercadoStatus() {
  const now = new Date();
  const ar = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const day = ar.getDay(); // 0=dom, 6=sab
  const h = ar.getHours();
  const m = ar.getMinutes();
  const minutos = h * 60 + m;
  if (day === 0 || day === 6) return { abierto: false, motivo: 'fin de semana' };
  if (minutos < 11 * 60) return { abierto: false, motivo: `abre a las 11:00 ART (faltan ${11 * 60 - minutos} min)` };
  if (minutos >= 17 * 60) return { abierto: false, motivo: `cerró a las 17:00 ART (reabre mañana 11:00)` };
  return { abierto: true };
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

    // Verificar horario de mercado (solo compra/venta, no dólar)
    if (!skipCheck && pending.dir !== 'dolar') {
      const mercadoStatus = getMercadoStatus();
      if (!mercadoStatus.abierto) {
        await sendMessage(
          `🔴 *Mercado cerrado* — ${mercadoStatus.motivo}\n\n` +
          `Las órdenes enviadas ahora vencen sin ejecutarse.\n` +
          `Usá */forzar ${n}* si de todas formas querés enviarla (quedará como orden para la próxima apertura si IOL lo permite).`
        );
        return;
      }
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
      const pos = normalizePortfolio(portfolio).find(
        t => t.simbolo === pending.simbolo.toUpperCase()
      );
      cantidadFinal = pos?.cantidad || 0;
      if (!cantidadFinal) {
        await sendMessage(`⚠️ No tenés posición en ${pending.simbolo}.`);
        await updateSignalStatus(pending.id, 'cancelado');
        return;
      }
      // Precio límite venta: 1% por debajo del live (o precio guardado), redondeado al tick BYMA
      precioLimite = precioLive ? roundToTick(precioLive * 0.99, 'venta') : roundToTick(pending.precio, 'venta');
    } else {
      // Precio límite compra: 1% por encima del live (o precio guardado), redondeado al tick BYMA
      precioLimite = precioLive ? roundToTick(precioLive * 1.01, 'compra') : roundToTick(pending.precio, 'compra');
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
        // Si no alcanza el porcentaje pero sí hay plata para 1 unidad, comprar 1
        if (efectivoActual >= precioLimite) {
          cantidadFinal = 1;
          await sendMessage(
            `ℹ️ ${pending.simbolo} cuesta $${precioLimite.toLocaleString('es-AR')} por unidad — supera el ${(pct * 100).toFixed(0)}% asignado ($${Math.round(efectivoActual * pct).toLocaleString('es-AR')} ARS).\n` +
            `Comprando *1 unidad* (${(precioLimite / efectivoActual * 100).toFixed(0)}% del efectivo).`
          );
        } else {
          await sendMessage(
            `⚠️ Efectivo insuficiente para comprar ${pending.simbolo}.\n` +
            `Efectivo: $${efectivoActual.toLocaleString('es-AR')} | Precio: $${precioLimite.toLocaleString('es-AR')} | Necesitás al menos $${precioLimite.toLocaleString('es-AR')}.`
          );
          await updateSignalStatus(pending.id, 'cancelado');
          return;
        }
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
    const ordenRaw = JSON.stringify(orden).slice(0, 400);
    console.log('[crearOrden] response:', ordenRaw);

    await updateSignalStatus(pending.id, 'ejecutado');
    // Log inicial con precio live (mejor estimación antes de confirmar ejecución)
    const precioLog = precioLive ?? precioLimite;
    const montoLog = cantidadFinal * precioLog;
    const comisionLog = montoLog * COMISION_RATE;
    const efectivo_post_inicial = pending.dir === 'venta'
      ? efectivoActual + montoLog - comisionLog
      : efectivoActual - montoLog - comisionLog;

    const tradeRow = await logTrade({
      fecha: new Date().toISOString().slice(0, 10),
      hora: new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      simbolo: pending.simbolo,
      accion: pending.dir,
      precio: precioLog,
      cantidad: cantidadFinal,
      monto: montoLog,
      senales: pending.signals,
      efectivo_pre: efectivoActual,
      efectivo_post: Math.round(efectivo_post_inicial),
    }).catch(() => null);

    await sendMessage(
      `✅ *Orden enviada a IOL*\n\n` +
      `*${pending.simbolo}* — ${pending.dir.toUpperCase()}\n` +
      `📦 Cantidad: ${cantidadFinal}\n` +
      `💵 Precio límite: $${precioLimite}${precioLive ? ` (cotización live: $${precioLive})` : ''}\n` +
      `🔑 Orden #${ordenNum ?? 'N/A'}\n\n` +
      `⏳ Verificando en 15 segundos...`
    );

    // Verificación post-orden + actualización del log con precio real de IOL
    await new Promise(r => setTimeout(r, 15000));

    let estadoFinal = null;
    if (ordenNum) {
      try {
        const estadoOrden = await getOrden(token, ordenNum);
        estadoFinal = estadoOrden.estado || estadoOrden.status || estadoOrden.estadoOrden || 'desconocido';
        const emoji = estadoFinal.toLowerCase().includes('ejecut') ? '✅' :
                      estadoFinal.toLowerCase().includes('cancel') ? '❌' : '⏳';
        await sendMessage(`${emoji} *Orden #${ordenNum}*: ${estadoFinal}`);
      } catch {
        await sendMessage(`📊 *Orden #${ordenNum}* enviada. Verificá el estado en IOL.`);
      }
    } else {
      await sendMessage(`📊 Orden enviada a IOL. Verificá el estado en la app.`);
    }

    // Actualizar el log con precio real (ppc de IOL) y efectivo_post recalculado
    if (tradeRow?.id) {
      try {
        const portfolioPost = await getPortfolio(token);
        const pos = normalizePortfolio(portfolioPost).find(
          t => t.simbolo === pending.simbolo.toUpperCase()
        );
        if (pos) {
          const precioReal   = pos.ppc ?? null;
          const cantidadReal = pos.cantidad ?? cantidadFinal;
          if (precioReal && precioReal > 0) {
            const montoReal = cantidadReal * precioReal;
            const comisionReal = montoReal * COMISION_RATE;
            const efectivo_post_real = pending.dir === 'venta'
              ? efectivoActual + montoReal - comisionReal
              : efectivoActual - montoReal - comisionReal;
            await updateTrade(tradeRow.id, {
              precio: precioReal,
              cantidad: cantidadReal,
              monto: Math.round(montoReal),
              efectivo_post: Math.round(efectivo_post_real),
            });
            console.log(`[logTrade] actualizado: precio=${precioReal} x ${cantidadReal} ef_post=${Math.round(efectivo_post_real)}`);
          }
        }
      } catch (e) {
        console.log('[logTrade] no se pudo actualizar con precio real:', e.message);
      }
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
    const titulos = normalizePortfolio(portfolio);

    if (titulos.length === 0) {
      await sendMessage(`💼 *Portafolio*\n\nSin posiciones abiertas.\n💵 Efectivo: $${efectivo.toLocaleString('es-AR')} ARS`);
      return;
    }

    const lines = titulos.map(t => {
      const precio = t.ultimoPrecio ?? 0;
      const total  = t.cantidad && precio ? t.cantidad * precio : 0;
      const variacion = t.variacionDiaria != null
        ? `${t.variacionDiaria >= 0 ? '+' : ''}${t.variacionDiaria.toFixed(2)}%`
        : '?';

      let pnlStr = '';
      if (t.ppc && t.ppc > 0 && precio) {
        const pnlPct   = (precio - t.ppc) / t.ppc * 100;
        const pnlMonto = (precio - t.ppc) * (t.cantidad || 0);
        pnlStr = ` | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${pnlMonto.toLocaleString('es-AR')})`;
      }

      return `• *${t.simbolo}*: ${t.cantidad} u. @ $${precio} (${variacion} hoy)${pnlStr}\n  Total: $${total.toLocaleString('es-AR')} ARS`;
    }).join('\n');

    const totalPortafolio = titulos.reduce((sum, t) => {
      return sum + (t.cantidad && t.ultimoPrecio ? t.cantidad * t.ultimoPrecio : 0);
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

async function handleSearchInstrumento(ticker) {
  const sym = ticker.toUpperCase().trim();
  if (!sym || sym.length > 10) {
    await sendMessage(`❌ Ticker inválido: *${sym}*\nUsá un ticker como GGAL, MELI, AL30 o AAPL.`);
    return;
  }
  try {
    const token = await getToken();
    const inst = await searchInstrumento(token, sym);
    await sendMessageWithButtons(
      `🔍 *Instrumento encontrado:*\n\n` +
      `📌 *${inst.simbolo}* — ${inst.nombre}\n` +
      `💵 Precio actual: $${inst.precio ?? '?'}\n` +
      `🏦 Mercado: ${inst.mercado.toUpperCase()}\n\n` +
      `¿Querés agregarlo a tu watchlist personalizada?`,
      [
        [
          { text: '✅ Confirmar', callback_data: `agregar_confirm:${inst.simbolo}:${inst.mercado}` },
          { text: '❌ Cancelar', callback_data: 'agregar_cancel' },
        ],
      ]
    );
  } catch {
    await sendMessage(
      `❌ No encontré cotización para *${sym}*.\n` +
      `Verificá que el ticker sea correcto (ej: GGAL, MELI, AL30, AAPL).`
    );
  }
}

async function handleCallbackQuery(cb) {
  // Quitar el ícono de carga del botón inmediatamente
  await answerCallbackQuery(cb.id).catch(() => {});

  const from = cb.from;
  const data = cb.data;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;

  // Verificar autorización
  const allowed = process.env.TG_ALLOWED_USERS?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
  if (allowed.length > 0 && !allowed.includes(String(from?.id))) return;

  // Eliminar botones del mensaje original para evitar doble-click
  if (chatId && messageId) await removeButtons(chatId, messageId).catch(() => {});

  if (data === 'no') {
    await handleCancelAll();
  } else if (data?.startsWith('si:')) {
    const n = parseInt(data.replace('si:', ''));
    if (!isNaN(n)) await handleConfirmN(n);
  } else if (data?.startsWith('agregar_confirm:')) {
    // formato: agregar_confirm:SYM:mercado
    const parts = data.split(':');
    const sym     = parts[1] ?? '';
    const mercado = parts[2] ?? 'bcba';
    try {
      await addToWatchlist(sym, sym, mercado); // nombre = sym (se puede enriquecer luego)
      await sendMessage(`✅ *${sym}* agregado a tu watchlist personalizada.\nSe incluirá en el próximo análisis del mercado.`);
    } catch (e) {
      await sendMessage(`⚠️ ${e.message}`);
    }
  } else if (data === 'agregar_cancel') {
    await sendMessage('❌ Operación cancelada.');
  } else if (data?.startsWith('scan_sell:')) {
    // formato: scan_sell:SYM:CANTIDAD:PRECIO
    const parts = data.split(':');
    const sym      = parts[1];
    const cantidad = parseInt(parts[2]);
    const precio   = parseFloat(parts[3]);
    if (!sym || isNaN(cantidad) || isNaN(precio)) {
      await sendMessage('❌ Error al parsear la orden de venta.');
      return;
    }
    const mercadoStatus = getMercadoStatus();
    if (!mercadoStatus.abierto) {
      await sendMessage(`🔴 *Mercado cerrado* — ${mercadoStatus.motivo}\nLa orden se enviará igual pero puede no ejecutarse hoy.`);
    }
    try {
      const token = await getToken();
      const orden = await crearOrden(token, { simbolo: sym, cantidad, precio, operacion: 'venta' });
      const ordenNum = orden.numero ?? orden.id ?? orden.nroOperacion ?? null;
      await logTrade({
        fecha: new Date().toISOString().slice(0, 10),
        hora:  new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
        simbolo: sym, accion: 'venta_tesis', precio, cantidad,
        monto: Math.round(precio * cantidad), senales: ['tesis_invalidada'], efectivo_pre: 0,
      }).catch(() => {});
      await sendMessage(
        `✅ *Orden enviada*\n\n📉 *${sym}* — VENTA\n` +
        `📦 ${cantidad} u. @ $${precio.toLocaleString('es-AR')}\n` +
        `🔑 Orden #${ordenNum ?? 'N/A'}`
      );
    } catch (e) {
      await sendMessage(`❌ Error al enviar la orden: ${e.message}`);
    }
  } else if (data === 'scan_ignore') {
    await sendMessage('👍 Entendido — posición mantenida. El bot seguirá monitoreando.');
  }
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

  // Manejar pulsación de botones inline
  if (body?.callback_query) {
    await handleCallbackQuery(body.callback_query).catch(() => {});
    return res.status(200).end('ok');
  }

  const msg = body?.message;
  if (!msg?.text) return res.status(200).end('ok');

  // Normalizar texto del teclado fijo a comandos estándar
  const rawText = msg.text.trim();
  const keyboardMap = {
    '📊 Analizar':     'analizar',
    '💼 Portafolio':   'portafolio',
    '📋 Historial':    'historial',
    '📌 Estado':       'estado',
    '💵 Precio Dolar': 'precio dolar',
    '❓ Ayuda':        'ayuda',
    '➕ Agregar':      'agregar',
  };
  const mappedText = keyboardMap[rawText];
  const text = mappedText ?? parseCommand(msg.text);

  const userId = msg.from?.id;

  // ── Flujo "Agregar instrumento" ──────────────────────────────────────────────
  // Detectar de dos formas (cualquiera que funcione en el cliente Telegram):
  // 1. El usuario respondió al force_reply del bot (reply_to_message.text)
  // 2. El usuario mandó un mensaje nuevo y hay estado pendiente en Supabase
  // Detectar respuesta al force_reply de "Agregar instrumento"
  // El bot responde al mensaje del usuario — por eso llega al webhook con privacy mode ON
  const replyToText = msg.reply_to_message?.text ?? '';
  if (replyToText.includes('Agregar instrumento') && isAuthorized(msg)) {
    await handleSearchInstrumento(rawText);
    return res.status(200).end('ok');
  }

  // Comando /buscar TICKER — alternativa explícita
  const buscarMatch = text.match(/^buscar\s+(\S+)$/);

  const siMatch     = text.match(/^si\s+([1-5](?:\s+[1-5])*)$/);
  const forzarMatch = text.match(/^forzar\s+([1-5](?:\s+[1-5])*)$/);
  const precioMatch = text.match(/^precio\s+(\w+)$/);
  const debugMatch  = text.match(/^debug\s+(\w+)$/);

  // Read-only commands: anyone in the group can use
  if (text === 'precio dolar' || text === 'precio usd' || text === 'precio dollar') {
    const { getDolarData, formatDolarContext } = await import('../lib/dolar.js');
    const d = await getDolarData();
    await sendMessage(`💵 *Dólar — cotizaciones actuales*\n\n${formatDolarContext(d)}`);
  } else if (precioMatch && ['dolar','usd','dollar'].includes(precioMatch[1])) {
    const { getDolarData, formatDolarContext } = await import('../lib/dolar.js');
    const d = await getDolarData();
    await sendMessage(`💵 *Dólar — cotizaciones actuales*\n\n${formatDolarContext(d)}`);
  } else if (buscarMatch && isAuthorized(msg)) {
    await handleSearchInstrumento(buscarMatch[1]);
  } else if (precioMatch) {
    await handlePrecio(precioMatch[1]);
  } else if (debugMatch) {
    await handleDebugCot(debugMatch[1]);
  } else if (text === 'ayuda' || text === 'help' || text === 'start') {
    const paused = await getBotConfig('trading_paused').catch(() => 'false');
    const estadoBot = paused === 'true' ? '🔴 *PAUSADO*' : '🟢 *ACTIVO*';
    await sendMessage(
      `🤖 *IOL Bot — Comandos*\n\n` +
      `📊 *Analizar* — análisis completo del mercado\n` +
      `💼 *Portafolio* — posiciones actuales con P&L\n` +
      `📋 *Historial* — últimas operaciones\n` +
      `📌 *Estado* — propuestas pendientes\n` +
      `💵 *Precio Dolar* — cotizaciones MEP/CCL/blue\n\n` +
      `🛑 */pausar* — detener trading automático\n` +
      `▶️ */reanudar* — reactivar trading automático\n` +
      `🔎 */cooldowns* — ver qué símbolos están en cooldown\n\n` +
      `_Estado del bot: ${estadoBot}_\n` +
      `_También: /buscar TICKER, /precio TICKER_`
    );
  } else {
    // Sensitive commands: owner only
    if (!isAuthorized(msg)) return res.status(200).end('ok');

    if (text === 'pausar') {
      await setBotConfig('trading_paused', 'true');
      await sendMessage('🛑 *Trading automático PAUSADO*\nNo se ejecutarán órdenes hasta que uses /reanudar.');
    } else if (text === 'reanudar') {
      await setBotConfig('trading_paused', 'false');
      await sendMessage('▶️ *Trading automático REACTIVADO*\nEl bot volverá a operar normalmente.');
    } else if (text === 'cooldowns') {
      const cooldowns = await getCooldowns().catch(() => ({}));
      const syms = Object.keys(cooldowns);
      if (syms.length === 0) {
        await sendMessage('✅ No hay símbolos en cooldown.');
      } else {
        const lines = syms.map(sym => {
          const until = new Date(cooldowns[sym]).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
          return `• *${sym}* — bloqueado hasta ${until}`;
        });
        await sendMessage(`⏳ *Cooldowns activos:*\n\n${lines.join('\n')}`);
      }
    } else if (text === 'agregar') {
      // Responde al mensaje del usuario con force_reply.
      // Al ser respuesta del bot, Telegram la entrega al webhook aunque
      // el grupo tenga privacy mode ON. selective:true muestra el campo
      // de respuesta solo al usuario que presionó el botón.
      await replyForceReply(
        msg.chat.id,
        msg.message_id,
        'Agregar instrumento a tu watchlist\n\nEscribí el ticker como respuesta a este mensaje:\nEjemplos: CRM, NVDA, AL35, AAPL'
      );
    } else if (text === 'analizar') {
      await handleAnalisis();
    } else if (siMatch) {
      const nums = [...new Set(siMatch[1].trim().split(/\s+/).map(Number))].sort();
      for (const n of nums) await handleConfirmN(n);
    } else if (forzarMatch) {
      const nums = [...new Set(forzarMatch[1].trim().split(/\s+/).map(Number))].sort();
      for (const n of nums) await handleConfirmN(n, { skipCheck: true });
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
