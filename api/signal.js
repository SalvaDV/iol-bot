import { sendMessage } from '../lib/telegram.js';
import { savePendingSignal } from '../lib/supabase.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const apiKey = request.headers.get('x-api-key');
  if (apiKey !== process.env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  let signal;
  try { signal = await request.json(); }
  catch { return new Response('Bad Request', { status: 400 }); }

  try {
    const saved = await savePendingSignal({ ...signal, status: 'pending' });
    const signalLines = (signal.signals || []).map(s => `  • ${s}`).join('\n');
    const cantidadStr = signal.dir === 'compra'
      ? `${signal.cantidad} acc ($${(signal.cantidad * signal.precio).toLocaleString('es-AR')} ARS)`
      : 'toda la posición';

    await sendMessage(
      `🚨 *SEÑAL AUTOMÁTICA*\n\n` +
      `*${signal.simbolo}* — ${signal.dir === 'compra' ? '📈 COMPRA' : '📉 VENTA'}\n` +
      `💵 Precio: $${signal.precio}\n` +
      `📊 Señales:\n${signalLines}\n\n` +
      `📦 ${cantidadStr}\n` +
      `💰 Efectivo: $${(signal.ef_pre || 0).toLocaleString('es-AR')} ARS\n\n` +
      `¿Confirmar? Respondé *si* o *no*`
    );

    return new Response(JSON.stringify({ ok: true, id: saved?.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
