import { getToken, crearOrden, getPortfolio } from '../lib/iol.js';
import { sendMessage } from '../lib/telegram.js';
import { getPendingSignal, updateSignalStatus, logTrade, savePendingSignal } from '../lib/supabase.js';
import { runAnalysis } from '../lib/analysis.js';

export const config = { runtime: 'edge' };

async function handleAnalisis() {
  try {
    const signal = await runAnalysis();
    if (signal) await savePendingSignal({ ...signal, status: 'pending' });
  } catch (err) {
    await sendMessage(`❌ Error en análisis: ${err.message}`);
  }
}

async function handleConfirm() {
  try {
    const pending = await getPendingSignal();
    if (!pending) { await sendMessage('⚠️ No hay operación pendiente.'); return; }
    await updateSignalStatus(pending.id, 'procesando');

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
    await sendMessage(`❌ Error ejecutando orden: ${err.message}`);
    const p = await getPendingSignal().catch(() => null);
    if (p) await updateSignalStatus(p.id, 'error').catch(() => {});
  }
}

async function handleCancel() {
  try {
    const pending = await getPendingSignal();
    if (!pending) { await sendMessage('⚠️ No hay operación pendiente.'); return; }
    await updateSignalStatus(pending.id, 'cancelado');
    await sendMessage(`🚫 Operación en *${pending.simbolo}* cancelada.`);
  } catch (err) {
    await sendMessage(`❌ Error cancelando: ${err.message}`);
  }
}

export default async function handler(request, context) {
  if (request.method !== 'POST') return new Response('ok');
  let body;
  try { body = await request.json(); } catch { return new Response('ok'); }

  const msg = body?.message;
  if (!msg?.text) return new Response('ok');
  const text = msg.text.trim().toLowerCase();

  if (text === 'analizar') context.waitUntil(handleAnalisis());
  else if (text === 'si' || text === 'sí') context.waitUntil(handleConfirm());
  else if (text === 'no') context.waitUntil(handleCancel());
  else if (text === 'estado') {
    context.waitUntil(
      getPendingSignal().then(p =>
        sendMessage(p
          ? `📋 Pendiente: *${p.simbolo}* ${p.dir} @ $${p.precio}`
          : '📋 Sin señales pendientes.')
      )
    );
  }

  return new Response('ok');
}
