const BASE = 'https://api.telegram.org';

// Teclado fijo que aparece en la parte inferior del chat en todos los mensajes
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Analizar' }, { text: '💼 Portafolio' }],
    [{ text: '📋 Historial' }, { text: '📌 Estado' }],
    [{ text: '💵 Precio Dolar' }, { text: '❓ Ayuda' }],
    [{ text: '➕ Agregar' }],
  ],
  resize_keyboard: true,
  persistent: true,
};

async function tgPost(method, body) {
  const res = await fetch(`${BASE}/bot${process.env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// Mensaje estándar — siempre incluye el teclado principal
export async function sendMessage(text, parseMode = 'Markdown') {
  if (!text?.trim()) return;

  const body = { chat_id: process.env.TG_CHAT_ID, text, reply_markup: MAIN_KEYBOARD };
  if (parseMode) body.parse_mode = parseMode;

  const res = await tgPost('sendMessage', body);

  if (!res.ok && parseMode) {
    const retry = await tgPost('sendMessage', { chat_id: process.env.TG_CHAT_ID, text, reply_markup: MAIN_KEYBOARD });
    if (!retry.ok) throw new Error(`Telegram sendMessage failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

// Mensaje con botones inline (para propuestas — reemplaza el teclado temporalmente)
export async function sendMessageWithButtons(text, inlineKeyboard, parseMode = 'Markdown') {
  if (!text?.trim()) return;

  const body = {
    chat_id: process.env.TG_CHAT_ID,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard },
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await tgPost('sendMessage', body);

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

// Responde al callback_query para quitar el icono de carga del boton
export async function answerCallbackQuery(callbackQueryId, text = '') {
  await tgPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Responde a un mensaje específico con force_reply + selective.
// Con selective:true Telegram muestra el campo de respuesta SOLO al usuario
// que envió el mensaje original. Como es una respuesta al bot, llega al webhook
// incluso con privacy mode ON.
export async function replyForceReply(chatId, replyToMessageId, text) {
  const body = {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    reply_markup: { force_reply: true, selective: true },
  };
  const res = await tgPost('sendMessage', body);
  if (!res.ok) throw new Error(`replyForceReply failed: ${res.status}`);
  return res.json();
}

// Elimina los botones inline de un mensaje (despues de que se presiono uno)
export async function removeButtons(chatId, messageId) {
  await tgPost('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}
