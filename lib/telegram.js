const BASE = 'https://api.telegram.org';

async function tgPost(method, body) {
  const res = await fetch(`${BASE}/bot${process.env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

export async function sendMessage(text, parseMode = 'Markdown') {
  if (!text?.trim()) return;

  const body = { chat_id: process.env.TG_CHAT_ID, text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await tgPost('sendMessage', body);

  // Retry without parse_mode if markdown parsing fails
  if (!res.ok && parseMode) {
    const retry = await tgPost('sendMessage', { chat_id: process.env.TG_CHAT_ID, text });
    if (!retry.ok) throw new Error(`Telegram sendMessage failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

// Envía un mensaje con botones inline (inline keyboard)
// inlineKeyboard: array de filas, cada fila es array de { text, callback_data }
// Ejemplo: [[{ text: '✅ Si 1', callback_data: 'si:1' }], [{ text: '❌ Cancelar', callback_data: 'no' }]]
export async function sendMessageWithButtons(text, inlineKeyboard, parseMode = 'Markdown') {
  if (!text?.trim()) return;

  const body = {
    chat_id: process.env.TG_CHAT_ID,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard },
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await tgPost('sendMessage', body);

  // Retry sin markdown si falla el parseo
  if (!res.ok && parseMode) {
    const retry = await tgPost('sendMessage', {
      chat_id: process.env.TG_CHAT_ID,
      text,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
    if (!retry.ok) throw new Error(`Telegram sendMessageWithButtons failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Telegram sendMessageWithButtons failed: ${res.status}`);
  return res.json();
}

// Responde al callback_query para quitar el ícono de carga del botón
export async function answerCallbackQuery(callbackQueryId, text = '') {
  await tgPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Elimina los botones de un mensaje ya enviado (después de que se presionó uno)
export async function removeButtons(chatId, messageId) {
  await tgPost('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}
