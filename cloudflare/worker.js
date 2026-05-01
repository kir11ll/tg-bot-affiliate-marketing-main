const TELEGRAM_API = "https://api.telegram.org";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function telegramRequest(token, method, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function isSubscribed(token, channel, userId) {
  const result = await telegramRequest(token, "getChatMember", {
    chat_id: channel,
    user_id: userId,
  });
  if (!result.ok) {
    return { ok: false, error: result.description || "getChatMember failed" };
  }
  return ["member", "administrator", "creator"].includes(result.result.status);
}

function articleKeyboard(articleUrl) {
  return {
    inline_keyboard: [
      [{ text: "Открыть статью", url: articleUrl }],
      [{ text: "Получить доступ", callback_data: "buy_access" }],
    ],
  };
}

function payKeyboard(paymentUrl) {
  return {
    inline_keyboard: [[{ text: "Оплатить доступ", url: paymentUrl }]],
  };
}

async function sendMessage(token, chatId, text, replyMarkup) {
  return telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    parse_mode: "HTML",
  });
}

async function createInviteLink(token, channelId, userId) {
  const result = await telegramRequest(token, "createChatInviteLink", {
    chat_id: channelId,
    member_limit: 1,
    name: `access_${userId}`,
  });
  if (!result.ok) throw new Error(result.description || "invite error");
  return result.result.invite_link;
}

async function handleStart(update, env) {
  const userId = update.message?.from?.id;
  const chatId = update.message?.chat?.id;
  if (!userId || !chatId) return;

  const subscription = await isSubscribed(env.BOT_TOKEN, env.PUBLIC_CHANNEL, userId);
  if (typeof subscription === "object" && subscription.ok === false) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `Не могу проверить подписку на канал.\n\nПричина: ${subscription.error}\n\nПроверь, что бот добавлен в канал как администратор и что PUBLIC_CHANNEL указан верно.`
    );
    return;
  }

  if (!subscription) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "Чтобы получить доступ, подпишитесь на канал и нажмите /start еще раз."
    );
    return;
  }

  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    "Подписка подтверждена. Вот статья:",
    articleKeyboard(env.ARTICLE_URL)
  );
}

async function handleCallback(update, env) {
  const data = update.callback_query?.data;
  const chatId = update.callback_query?.message?.chat?.id;
  if (!data || !chatId) return;

  if (data === "buy_access") {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "Здесь подключим оплату. Пока можно вставить ссылку на платежный сервис или invoice.",
      payKeyboard(env.PAYMENT_URL || "https://example.com/pay")
    );
    await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: update.callback_query.id,
    });
  }
}

async function webhookInfo(token) {
  return telegramRequest(token, "getWebhookInfo", {});
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      if (new URL(request.url).pathname === "/health") {
        return json({ ok: true, service: "tg-bot-dozmobot" });
      }

      if (env.BOT_TOKEN) {
        const info = await webhookInfo(env.BOT_TOKEN);
        return json({ ok: true, webhook: info.result || info });
      }

      return json({ ok: true, message: "Worker is running" });
    }

    if (request.method !== "POST") {
      return json({ ok: true });
    }

    const update = await request.json();

    if (update.message?.text === "/start") {
      await handleStart(update, env);
    }

    if (update.callback_query) {
      await handleCallback(update, env);
    }

    return json({ ok: true });
  },
};
