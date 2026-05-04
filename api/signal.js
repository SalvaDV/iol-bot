import { sendMessage } from '../lib/telegram.js';
import { savePendingSignal } from '../lib/supabase.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.WEBHOOK_SECRET) return res.status(401).end('Unauthorized');

  let signal;
  try {
    signal = await new Promise((resolve, reject) => {
      let d = '';
      req.on('data', c => { d += c; });
      req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
  } catch {
    return res.status(400).end('Bad Request');
  }

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

    res.status(200).json({ ok: true, id: saved?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
