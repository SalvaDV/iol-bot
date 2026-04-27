import { getToken, crearOrden, getPortfolio, getCotizacion, getCuenta, getOrden } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import {
  getPendingSignals, updateSignalStatus, logTrade, cancelAllPending,
} from '../lib/supabase.js';
import { runAdvisor } from '../lib/advisor.js';

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

async function handleConfirmN(n) {
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
    let precioLive = null;
    try {
      const cot = await getCotizacion(token, pending.simbolo);
      precioLive = cot.ultimoPrecio || cot.ultimo || cot.precioActual || cot.precio || null;
    } catch { /* usar precio guardado como fallback */ }

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
      const efectivoActual = cuenta.cuentas?.[0]?.disponible ?? 0;
      cantidadFinal = precioLimite > 0 ? Math.floor(efectivoActual * pct / precioLimite) : 0;
      if (!cantidadFinal || cantidadFinal < 1) {
        await sendMessage(`⚠️ Efectivo insuficiente para comprar ${pending.simbolo}.\nEfectivo: $${efectivoActual.toLocaleString('es-AR')} | Precio: $${precioLimite}`);
        await updateSignalStatus(pending.id, 'cancelado');
        return;
      }
    }

    const orden = await crearOrden(token, {
      simbolo: pending.simbolo,
      cantidad: cantidadFinal,
      precio: precioLimite,
      operacion: pending.dir,
    });

    const ordenNum = orden.numero || orden.id || null;
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
    if (ordenNum) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        const estadoOrden = await getOrden(token, ordenNum);
        const estado = estadoOrden.estado || estadoOrden.status || estadoOrden.estadoOrden || 'desconocido';
        const emoji = estado.toLowerCase().includes('ejecut') ? '✅' :
                      estado.toLowerCase().includes('cancel') ? '❌' : '⏳';
        await sendMessage(`${emoji} *Orden #${ordenNum}*: ${estado}`);
      } catch {
        await sendMessage(`📊 *Orden #${ordenNum}* enviada. Verificá el estado en IOL.`);
      }
    }
  } catch (err) {
    await sendMessage(`❌ Error ejecutando propuesta ${n}: ${err.message}`).catch(() => {});
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
  const text = msg.text.trim().toLowerCase();

  const siMatch = text.match(/^si\s+([123])$/);

  if (text === 'analizar') {
    await handleAnalisis();
  } else if (siMatch) {
    await handleConfirmN(parseInt(siMatch[1]));
  } else if (text === 'si' || text === 'sí') {
    await sendMessage('¿A cuál propuesta? Respondé *si 1*, *si 2* o *si 3*.\nO mandá *estado* para ver las opciones pendientes.');
  } else if (text === 'no') {
    await handleCancelAll();
  } else if (text === 'estado') {
    try {
      const signals = await getPendingSignals();
      if (signals.length === 0) {
        await sendMessage('📋 Sin propuestas pendientes.');
      } else {
        const lines = signals.map(s => {
          const num = s.signals?.[0]?.replace('propuesta:', '') ?? '?';
          const pctSig = s.signals?.find(x => x?.startsWith('pct:'));
          const pct = pctSig ? `${(parseFloat(pctSig.replace('pct:', '')) * 100).toFixed(0)}%` : '';
          let detalle;
          if (s.dir === 'dolar') detalle = `💵 DOLARIZAR ${pct}`;
          else if (s.dir === 'venta') detalle = '📉 VENTA posición completa';
          else detalle = `📈 COMPRA ${s.cantidad ? `${s.cantidad} u. @ $${s.precio}` : `${pct} efectivo`}`;
          return `${num}. *${s.simbolo}* — ${detalle}`;
        }).join('\n');
        await sendMessage(`📋 *Propuestas pendientes:*\n\n${lines}\n\nRespondé *si 1/2/3* o *no*`);
      }
    } catch (err) {
      await sendMessage(`❌ Error: ${err.message}`).catch(() => {});
    }
  }

  res.status(200).end('ok');
}
