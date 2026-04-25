import { getToken, crearOrden, getPortfolio } from '../lib/iol.js';
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

async function handleConfirmN(n) {
  try {
    const signals = await getPendingSignals();
    if (signals.length === 0) {
      await sendMessage('⚠️ No hay propuestas pendientes.');
      return;
    }

    // Las propuestas se guardan con signals[0] = "propuesta:N"
    const pending = signals.find(s => s.signals?.[0] === `propuesta:${n}`)
      ?? signals[n - 1]; // fallback por índice

    if (!pending) {
      await sendMessage(`⚠️ No existe propuesta ${n}. Tenés ${signals.length} propuesta(s) disponible(s).`);
      return;
    }

    await updateSignalStatus(pending.id, 'procesando');

    // Cancelar las otras
    for (const s of signals) {
      if (s.id !== pending.id) await updateSignalStatus(s.id, 'cancelado').catch(() => {});
    }

    const token = await getToken();
    let cantidadFinal = pending.cantidad;

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
    }

    const orden = await crearOrden(token, {
      simbolo: pending.simbolo,
      cantidad: cantidadFinal,
      precio: pending.precio,
      operacion: pending.dir,
    });

    await updateSignalStatus(pending.id, 'ejecutado');
    await logTrade({
      fecha: new Date().toISOString().slice(0, 10),
      hora: new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      instrumento: pending.simbolo,
      accion: pending.dir,
      precio_ejecucion: pending.precio,
      cantidad: cantidadFinal,
      orden_id: orden.numero || orden.id || null,
      signals: pending.signals,
    });

    await sendMessage(
      `✅ *Orden ejecutada*\n\n` +
      `*${pending.simbolo}* — ${pending.dir.toUpperCase()}\n` +
      `📦 Cantidad: ${cantidadFinal}\n` +
      `💵 Precio límite: $${pending.precio}\n` +
      `🔑 Orden #${orden.numero || orden.id || 'N/A'}`
    );
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
          const montoStr = s.dir === 'compra' && s.cantidad
            ? `${s.cantidad} u. @ $${s.precio}`
            : 'posición completa';
          return `${num}. *${s.simbolo}* — ${s.dir.toUpperCase()} ${montoStr}`;
        }).join('\n');
        await sendMessage(`📋 *Propuestas pendientes:*\n\n${lines}\n\nRespondé *si 1/2/3* o *no*`);
      }
    } catch (err) {
      await sendMessage(`❌ Error: ${err.message}`).catch(() => {});
    }
  }

  res.status(200).end('ok');
}
