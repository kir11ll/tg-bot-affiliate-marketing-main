const TELEGRAM_API = "https://api.telegram.org";
const REF_BONUS_RATE = 0.3;
const MIN_WITHDRAWAL = 1000;
const FOLLOWUP_DELAY_MINUTES = 20;
const PAYMENT_REMINDER_1_MINUTES = 10;
const PAYMENT_REMINDER_2_MINUTES = 15;

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

async function sendMessage(token, chatId, text, replyMarkup) {
  return telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    parse_mode: "HTML",
  });
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function channelUrl(channel) {
  return `https://t.me/${String(channel).replace("@", "")}`;
}

function articleKeyboard(articleUrl) {
  return { inline_keyboard: [[{ text: "ССЫЛКА", url: articleUrl }]] };
}

function followupKeyboard() {
  return {
    inline_keyboard: [[{ text: "ЗАБРАТЬ МЕТОДИКУ!", callback_data: "followup:method" }]],
  };
}

function paymentKeyboard(paymentUrl) {
  return { inline_keyboard: [[{ text: "Оплатить доступ", url: paymentUrl }]] };
}

function reminder1Keyboard(paymentUrl) {
  return { inline_keyboard: [[{ text: "Забрать систему", url: paymentUrl }]] };
}

function reminder2Keyboard(paymentUrl) {
  return { inline_keyboard: [[{ text: "Получить методику", url: paymentUrl }]] };
}

function sendPlaceholdersIfMissing(env) {
  return [env.SCREENSHOT_1_URL, env.SCREENSHOT_2_URL, env.SCREENSHOT_3_URL].every(Boolean);
}

function subscribeKeyboard(channel, refLink) {
  return {
    inline_keyboard: [
      [{ text: "ОТКРЫТЬ КАНАЛ", url: channelUrl(channel) }],
      [{ text: "Подписался", callback_data: `check_sub:${refLink || ""}` }],
    ],
  };
}

function referKeyboard(refLink) {
  return {
    inline_keyboard: [
      [{ text: "Скопировать ссылку", url: refLink }],
      [{ text: "Вывод", callback_data: "cabinet:withdraw" }],
      [{ text: "Статистика", callback_data: "cabinet:stats" }],
    ],
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Статистика", callback_data: "admin:stats" }],
      [{ text: "Поиск реферала", callback_data: "admin:search" }],
      [{ text: "Рефералы", callback_data: "admin:refs" }],
      [{ text: "Уведомления", callback_data: "admin:notify" }],
    ],
  };
}

function adminReferralKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: "Учесть выплату", callback_data: `admin:payout:${userId}` }],
      [{ text: "Назад", callback_data: "admin:home" }],
    ],
  };
}

function removeReplyKeyboard() {
  return { remove_keyboard: true };
}

async function isSubscribed(token, channel, userId) {
  const result = await telegramRequest(token, "getChatMember", {
    chat_id: channel,
    user_id: userId,
  });
  if (!result.ok) return { ok: false, error: result.description || "getChatMember failed" };
  return ["member", "administrator", "creator"].includes(result.result.status);
}

async function dbOne(env, query, params = []) {
  return env.DB.prepare(query).bind(...params).first();
}

async function dbAll(env, query, params = []) {
  return env.DB.prepare(query).bind(...params).all();
}

async function dbRun(env, query, params = []) {
  return env.DB.prepare(query).bind(...params).run();
}

async function getContentStage(env, userId) {
  return dbOne(env, "SELECT * FROM content_stages WHERE user_id = ?", [userId]);
}

async function upsertContentStage(env, userId, stage, updates = {}) {
  const now = new Date().toISOString();
  const existing = await getContentStage(env, userId);
  if (!existing) {
    await dbRun(
      env,
      "INSERT INTO content_stages (user_id, stage, updated_at, article_sent_at, followup_sent_at, payment_sent_at, payment_reminder1_at, payment_reminder2_at, payment_completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        userId,
        stage,
        now,
        updates.article_sent_at || null,
        updates.followup_sent_at || null,
        updates.payment_sent_at || null,
        updates.payment_reminder1_at || null,
        updates.payment_reminder2_at || null,
        updates.payment_completed_at || null,
      ]
    );
    return;
  }
  const sets = ["stage = ?", "updated_at = ?"];
  const params = [stage, now];
  for (const key of ["article_sent_at", "followup_sent_at", "payment_sent_at", "payment_reminder1_at", "payment_reminder2_at", "payment_completed_at"]) {
    if (updates[key] && !existing[key]) {
      sets.push(`${key} = ?`);
      params.push(updates[key]);
    }
  }
  params.push(userId);
  await dbRun(env, `UPDATE content_stages SET ${sets.join(", ")} WHERE user_id = ?`, params);
}

async function setAdminState(env, adminId, key, value) {
  await dbRun(
    env,
    "INSERT OR REPLACE INTO admin_state (admin_id, state_key, state_value, updated_at) VALUES (?, ?, ?, ?)",
    [adminId, key, String(value || ""), new Date().toISOString()]
  );
}

async function getAdminState(env, adminId) {
  return dbOne(env, "SELECT * FROM admin_state WHERE admin_id = ?", [adminId]);
}

async function clearAdminState(env, adminId) {
  await dbRun(env, "DELETE FROM admin_state WHERE admin_id = ?", [adminId]);
}

async function ensureUser(env, tgUser, referrerId = null) {
  const existing = await dbOne(env, "SELECT * FROM users WHERE tg_id = ?", [tgUser.id]);
  if (existing) return existing;
  await dbRun(
    env,
    "INSERT INTO users (tg_id, username, first_name, referrer_id, balance, payouts_total, ref_clicks, referred_sales, withdrawal_requests, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?)",
    [tgUser.id, tgUser.username || "", tgUser.first_name || "", referrerId, new Date().toISOString()]
  );
  return dbOne(env, "SELECT * FROM users WHERE tg_id = ?", [tgUser.id]);
}

async function getUserByTgId(env, tgId) {
  return dbOne(env, "SELECT * FROM users WHERE tg_id = ?", [tgId]);
}

async function getUserByReferralCode(env, code) {
  return dbOne(env, "SELECT * FROM users WHERE referral_code = ?", [code]);
}

function referralLink(botUsername, referralCode) {
  return `https://t.me/${botUsername}?start=ref_${referralCode}`;
}

function formatMoney(amount) {
  return `${Number(amount || 0).toFixed(2)} ₽`;
}

async function getBotUsername(env) {
  const row = await dbOne(env, "SELECT value FROM meta WHERE key = 'bot_username'");
  if (row?.value) return row.value;
  const info = await telegramRequest(env.BOT_TOKEN, "getMe", {});
  const username = info?.result?.username;
  if (username) {
    await dbRun(env, "INSERT OR REPLACE INTO meta (key, value) VALUES ('bot_username', ?)", [username]);
  }
  return username || "bot";
}

async function getOrCreateReferralCode(env, user) {
  const code = `u${user.tg_id}`;
  if (!user.referral_code) {
    await dbRun(env, "UPDATE users SET referral_code = ? WHERE tg_id = ?", [code, user.tg_id]);
  }
  return code;
}

async function createReferralIfNeeded(env, tgUser, startPayload) {
  let referrerId = null;
  if (startPayload?.startsWith("ref_")) {
    const code = startPayload.replace("ref_", "");
    const referrer = await getUserByReferralCode(env, code);
    if (referrer && referrer.tg_id !== tgUser.id) referrerId = referrer.tg_id;
  }
  const user = await ensureUser(env, tgUser, referrerId);
  if (referrerId && !user.referrer_id) {
    await dbRun(env, "UPDATE users SET referrer_id = ? WHERE tg_id = ?", [referrerId, tgUser.id]);
    await addReferralClick(env, referrerId);
  }
  return getUserByTgId(env, tgUser.id);
}

async function sendArticlePost(env, chatId, userId) {
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    "Подписка подтверждена. Вот статья:\n\nВремя на чтение 5-8 минут",
    articleKeyboard(env.ARTICLE_URL)
  );
  await upsertContentStage(env, userId, "article_sent", { article_sent_at: new Date().toISOString() });
}

async function sendFollowupPost(env, chatId, userId) {
  const message =
    "Ну что, как тебе статья?\n\n" +
    "Хочу рассказать про один пример, который должен дать тебе четкое понимание того на что способен партнерский маркетинг и сразу после отправлю стратегию, обещаю!\n\n" +
    "Выше на скриншотах один из аккаунтов, который придерживаясь нашей стратегии вышел на 120к подписчиков и заработал 5+ млн рублей! И да, автор там не показывает свое лицо (в видео не ее лицо) и делает ну очень простые видео, очень. Не веришь? - Убедись сам, вот этот аккаунт\n\n" +
    "Но сначала дочитай до конца, это важно!\n\n" +
    "Как же один аккаунт смог заработать столько и почему 98% не могут это повторить? - Все очень просто, тут дело в охватах (просмотрах) - большинство создают аккаунты по наитию, не понимая как это делать правильно, я уже молчу о том как они ведут эти аккаунты...\n\n" +
    "Дело в том, что в инстаграме существуют определенные алгоритмы, придерживаясь которых площадка сама продвигает контент на большие просмотры. Но почему все не выкладывают видео, придерживаясь определенных алгоритмов? - Ответ простой, 98% просто не знают как работают эти алгоритмы\n\n" +
    "За 4+ года работы с этой площадкой я лично поднимал аккаунты со 100 до миллионов просмотров и абсолютно всегда придерживался только одной стратегии:\n\n" +
    "- Как правильно создать профиль\n" +
    "- Как правильно настроить профиль\n" +
    "- Как правильно прогреть профиль\n" +
    "- Как правильно публиковать видео\n" +
    "- Как не попасть в теневой бан\n" +
    "- Как не попадать в блокировки\n\n" +
    "Эту всю статистику я вывел сам, работая с начинающим блогерами и брендами, которые пытались продвигаться в инстаграме.\n\n" +
    "И только понимая как все это делать правильно, понимая как работают алгоритмы в 2026 ты сможешь вывести свой профиль на большие охваты! Поэтому я и создал ту самую стратегию, куда уместил все свои знания в одно место, чтобы любой смог ее применить и выйти на первые 100к в месяц на партнерском маркетинге.\n\n" +
    "Ну что? Готов погрузиться в эту сферу и уже через 2 дня заработать первые деньги в интернете? - Забирай методику по кнопке ниже и начинай работу!\n\n" +
    "<b>ОЧЕНЬ ВАЖНО</b> придерживаться каждого шага стратегии!";

  const screenshots = [env.SCREENSHOT_1_URL, env.SCREENSHOT_2_URL, env.SCREENSHOT_3_URL].filter(Boolean);
  try {
    if (screenshots.length === 3) {
      const mediaResult = await telegramRequest(env.BOT_TOKEN, "sendMediaGroup", {
        chat_id: chatId,
        media: [
          {
            type: "photo",
            media: screenshots[0],
            caption: message,
            parse_mode: "HTML",
          },
          { type: "photo", media: screenshots[1] },
          { type: "photo", media: screenshots[2] },
        ],
      });
      if (!mediaResult?.ok) {
        await sendMessage(env.BOT_TOKEN, chatId, message);
      }
    } else {
      await sendMessage(env.BOT_TOKEN, chatId, message);
    }
  } catch (error) {
    await sendMessage(env.BOT_TOKEN, chatId, message);
  }

  await sendMessage(env.BOT_TOKEN, chatId, " ", followupKeyboard());
  await upsertContentStage(env, userId, "followup_sent", { followup_sent_at: new Date().toISOString() });
}

async function sendPaymentPost(env, chatId, userId) {
  const message =
    "<b>Ты уже через 2 дня сможешь получить свою первую оплату, если будешь четко придерживаться моей методике (проверено на 30+ профилях)</b>\n\n" +
    "Хватит думать о том как бы мне сделать вирусные ролики и заработать на этом, просто сделай, поверь, ты не пожалеешь 🙂\n\n" +
    "<b>Вот наш с тобой план:</b>\n\n" +
    "1. Ты заходишь в нашу стратегию (она в отдельном закрытом канале)\n" +
    "2. Ты по шагам создаешь профиль / прогреваешь его и выкладываешь первые видео\n" +
    "3. Мы с тобой настраиваем воронку (по гайду в закрытом канале)\n" +
    "4. Подключаем все к партнерскому продукту (тебе даже ничего не нужно создавать)\n" +
    "5. Получаешь комиссии с оплат и выводишь их\n\n" +
    "<b>Пока есть такая возможность, нужно ей пользоваться!</b>\n\n" +
    "<b>А еще внутри бонусом ты получаешь:</b>\n\n" +
    "- Шаблоны видео, которые уже работают\n" +
    "- Чат с единомышленниками\n" +
    "- Как работают алгоритмы\n" +
    "- Как масштабироваться на много аккаунтов\n" +
    "- Как правильно создавать профили\n" +
    "- Как упаковывать профиль\n" +
    "- Как прогревать профиль\n" +
    "- Как вести профиль\n\n" +
    "<b>Только в течение 24 часов всю методику + базу с видео не за 4990, а за 1490 рублей!</b>\n\n" +
    "<b>Все это уже ждет внутри.\nЖми кнопку ниже и забирай👇</b>";

  await sendMessage(env.BOT_TOKEN, chatId, message, paymentKeyboard(env.PAYMENT_URL || "https://example.com/pay"));
  await upsertContentStage(env, userId, "payment_sent", { payment_sent_at: new Date().toISOString() });
}

async function sendPaymentReminder1(env, chatId, userId) {
  const message =
    "Ты здесь? 👀 Вижу, что ты остановился в шаге от получения методики, но так и не забрал их.\n\n" +
    "Если ты думаешь, что это «очередное сложное обучение», то выдохни. Это не курс. Это набор готовых решений (Ctrl+C -> Ctrl+V).\n\n" +
    "Я специально сделал этот продукт таким, чтобы ты получил первый результат уже через 2 дня, потратив 30 минут.\n\n" +
    "☕️ Цена вопроса — 1490₽ (как обед в ресторане). Но обед ты съешь и забудешь, а эта Система останется с тобой и будет приносить деньги на пассиве.\n\n" +
    "Если бы тебе предложили вложить 1490 рублей и сказали, что через месяц они превратятся в 100 тысяч рублей, согласился бы? - Задумайся над этим\n\n" +
    "Заверши начатое по ссылке 👇";

  await sendMessage(env.BOT_TOKEN, chatId, message, reminder1Keyboard(env.PAYMENT_URL || "https://example.com/pay"));
  await upsertContentStage(env, userId, "payment_reminder1_sent", {
    payment_reminder1_at: new Date().toISOString(),
  });
}

async function sendPaymentReminder2(env, chatId, userId) {
  const message =
    "<b>47530 рублей за 1 видео, созданное за 15 минут</b>\n\n" +
    "И это никакие не сказки... Что может сказать о эксперте лучше чем свой же кейс? Я сапожник с сапогами👢\n\n" +
    "<b>Немного математики:</b>\n\n" +
    "- Недавно мое видео залетело на <b>2.5млн просмотров за день</b>\n" +
    "- Комментарий с кодовым словом оставило <b>2561 человек</b>\n" +
    "- Из них на бота перешли и прочитали статью <b>2014 человек</b>\n" +
    "- Из 2014 человек купили продукт <b>97 человек</b>\n" +
    "- Продукт стоил 490 рублей (ниша - психология)\n" +
    "- По итогу продаж на <b>47530 рублей</b> (1 видео / 1 аккаунт)\n\n" +
    "Как тебе такой результат, хотел бы его повторить самостоятельно? - в методике полностью по шагам расписано как это сделать!\n\n" +
    "Я уверен в том, что предлагаю ведь сам пользуюсь этим и получаю результат.\n\n" +
    "Завтра стоимость повысится в два раза, поэтому сегодня последная возможность воспользоваться лучшим инструментом на рынке по набору аудитории.\n\n" +
    "Кликай по ссылке ниже и повтори такой результат у себя.";

  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    message,
    reminder2Keyboard(env.PAYMENT_URL || "https://example.com/pay")
  );
  if (env.SCREENSHOT_4_URL) {
    try {
      await telegramRequest(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: env.SCREENSHOT_4_URL,
        caption: " ",
      });
    } catch (error) {
      // fallback: don't block the flow if the image is unavailable
    }
  }
  await upsertContentStage(env, userId, "payment_reminder2_sent", {
    payment_reminder2_at: new Date().toISOString(),
  });
}

async function addReferralClick(env, userId) {
  await dbRun(env, "UPDATE users SET ref_clicks = ref_clicks + 1 WHERE tg_id = ?", [userId]);
}

async function addReferralEarning(env, userId, paymentId, amount) {
  const reward = Math.round(amount * REF_BONUS_RATE * 100) / 100;
  await dbRun(
    env,
    "INSERT INTO referral_earnings (user_id, payment_id, amount, reward, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, paymentId, amount, reward, new Date().toISOString()]
  );
  await dbRun(env, "UPDATE users SET balance = balance + ?, referred_sales = referred_sales + 1 WHERE tg_id = ?", [
    reward,
    userId,
  ]);
  return reward;
}

async function addPayoutRequest(env, userId, amount) {
  await dbRun(
    env,
    "INSERT INTO withdrawal_requests (user_id, amount, status, created_at) VALUES (?, ?, 'pending', ?)",
    [userId, amount, new Date().toISOString()]
  );
  await dbRun(env, "UPDATE users SET withdrawal_requests = withdrawal_requests + 1 WHERE tg_id = ?", [userId]);
}

async function adminIsAllowed(env, tgId) {
  const ownerRow = await dbOne(env, "SELECT value FROM meta WHERE key = 'owner_id'");
  if (ownerRow?.value && String(ownerRow.value) === String(tgId)) return true;
  return String(env.ADMIN_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .includes(String(tgId));
}

async function claimOwnerIfNeeded(env, tgId) {
  const ownerRow = await dbOne(env, "SELECT value FROM meta WHERE key = 'owner_id'");
  if (!ownerRow?.value) {
    await dbRun(env, "INSERT OR REPLACE INTO meta (key, value) VALUES ('owner_id', ?)", [String(tgId)]);
  }
}

async function buildUserCabinet(env, tgUser) {
  const user = await getUserByTgId(env, tgUser.id);
  const code = await getOrCreateReferralCode(env, user);
  const botUsername = await getBotUsername(env);
  const link = referralLink(botUsername, code);
  return {
    text:
      `Ваш реферальный кабинет\n\n` +
      `Реферальная ссылка: ${link}\n` +
      `Переходы: ${user.ref_clicks || 0}\n` +
      `Вознаграждение за оплаты: ${formatMoney(user.balance || 0)}\n` +
      `Запрос на вывод: ${user.withdrawal_requests || 0}\n\n` +
      `Вывод доступен от ${formatMoney(MIN_WITHDRAWAL)}.`,
    keyboard: referKeyboard(link),
  };
}

async function buildAdminStats(env) {
  const today = new Date();
  const dates = [1, 7, 14, 30];
  const counts = {};
  for (const days of dates) {
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    const row = await dbOne(
      env,
      "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s FROM payments WHERE status = 'paid' AND paid_at >= ?",
      [from.toISOString()]
    );
    counts[days] = row || { c: 0, s: 0 };
  }
  const all = await dbOne(env, "SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS s FROM payments WHERE status = 'paid'");
  return {
    text:
      `<b>Статистика</b>\n\n` +
      `Оплаты за сегодня: ${counts[1].c} / ${formatMoney(counts[1].s)}\n` +
      `Оплаты за 7 дней: ${counts[7].c} / ${formatMoney(counts[7].s)}\n` +
      `Оплаты за 14 дней: ${counts[14].c} / ${formatMoney(counts[14].s)}\n` +
      `Оплаты за 30 дней: ${counts[30].c} / ${formatMoney(counts[30].s)}\n` +
      `Оплаты за все время: ${all?.c || 0} / ${formatMoney(all?.s || 0)}`,
    keyboard: adminKeyboard(),
  };
}

async function buildAdminRefs(env) {
  const rows = await dbAll(
    env,
    "SELECT u.tg_id, u.username, u.first_name, u.referral_code, u.balance, u.payouts_total, u.ref_clicks, u.referred_sales, u.withdrawal_requests, COALESCE(SUM(p.amount), 0) AS revenue FROM users u LEFT JOIN payments p ON p.referrer_id = u.tg_id AND p.status = 'paid' GROUP BY u.tg_id ORDER BY revenue DESC, u.balance DESC LIMIT 20"
  );
  const text = ["<b>Рефералы</b>"];
  for (const row of rows.results || []) {
    text.push(
      `\n<b>${htmlEscape(row.first_name || row.username || row.tg_id)}</b>` +
        `\nID: ${row.tg_id}` +
        `\nКод: ${row.referral_code || ""}` +
        `\nПереходы: ${row.ref_clicks || 0}` +
        `\nВыручка: ${formatMoney(row.revenue || 0)}` +
        `\nБаланс: ${formatMoney(row.balance || 0)}` +
        `\nВыплачено: ${formatMoney(row.payouts_total || 0)}` +
        `\nВыводы: ${row.withdrawal_requests || 0}`
    );
  }
  return { text: text.join("\n"), keyboard: adminKeyboard() };
}

async function buildAdminNotify(env) {
  const enabled = (await dbOne(env, "SELECT value FROM settings WHERE key = 'notify_enabled'"))?.value === "1";
  return {
    text: `Уведомления сейчас ${enabled ? "включены" : "выключены"}`,
    keyboard: {
      inline_keyboard: [
        [{ text: enabled ? "Выключить уведомления" : "Включить уведомления", callback_data: "admin:notify" }],
        [{ text: "Назад", callback_data: "admin:home" }],
      ],
    },
  };
}

async function buildReferralCard(env, user) {
  const code = user.referral_code || `u${user.tg_id}`;
  const botUsername = await getBotUsername(env);
  const link = referralLink(botUsername, code);
  const revenueRow = await dbOne(
    env,
    "SELECT COALESCE(SUM(amount), 0) AS revenue FROM payments WHERE referrer_id = ? AND status = 'paid'",
    [user.tg_id]
  );
  return {
    text:
      `<b>Реферал</b>\n\n` +
      `Имя: ${htmlEscape(user.first_name || user.username || "без имени")}\n` +
      `ID: ${user.tg_id}\n` +
      `Username: @${htmlEscape(user.username || "нет")}\n` +
      `Код: ${htmlEscape(code)}\n` +
      `Ссылка: ${htmlEscape(link)}\n` +
      `Переходы: ${user.ref_clicks || 0}\n` +
      `Выручка: ${formatMoney(revenueRow?.revenue || 0)}\n` +
      `Продажи: ${user.referred_sales || 0}\n` +
      `Баланс выплат: ${formatMoney(user.balance || 0)}\n` +
      `Выплачено: ${formatMoney(user.payouts_total || 0)}\n` +
      `Заявок на вывод: ${user.withdrawal_requests || 0}`,
    keyboard: adminReferralKeyboard(user.tg_id),
  };
}

async function sendUserCabinet(update, env) {
  await ensureUser(env, update.message.from);
  const cab = await buildUserCabinet(env, update.message.from);
  await sendMessage(env.BOT_TOKEN, update.message.chat.id, cab.text, cab.keyboard);
}

async function sendAdminStats(chatId, env) {
  const payload = await buildAdminStats(env);
  await sendMessage(env.BOT_TOKEN, chatId, payload.text, payload.keyboard);
}

async function sendAdminRefs(chatId, env) {
  const payload = await buildAdminRefs(env);
  await sendMessage(env.BOT_TOKEN, chatId, payload.text, payload.keyboard);
}

async function handleStart(update, env) {
  const user = update.message?.from;
  const chatId = update.message?.chat?.id;
  if (!user || !chatId) return;

  const text = update.message?.text || "";
  const payload = text.split(" ")[1] || "";
  await createReferralIfNeeded(env, user, payload);

  if (payload === "partner" || payload === "cabinet") {
    await sendUserCabinet(update, env);
    return;
  }

  if (payload === "from_article") {
    await sendFollowupPost(env, chatId, user.id);
    return;
  }

  const stage = await getContentStage(env, user.id);
  if (text === "/start" && stage?.stage === "article_sent" && !stage?.followup_sent_at) {
    await sendFollowupPost(env, chatId, user.id);
    return;
  }
  if (text.startsWith("/start") && stage?.stage === "article_sent" && !stage?.followup_sent_at) {
    await sendFollowupPost(env, chatId, user.id);
    return;
  }

  const isAdmin = await adminIsAllowed(env, user.id);

  if (isAdmin) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "Админ кабинет",
      adminKeyboard()
    );
    return;
  }

  const botUsername = await getBotUsername(env);
  const userRow = await getUserByTgId(env, user.id);
  const code = await getOrCreateReferralCode(env, userRow);
  const refLink = referralLink(botUsername, code);

  const introText =
    '<b>Привет! Чтобы забрать статью "Как выйти на первые 100к с помощью Партнерского маркетинга"</b>\n\n' +
    "Подпишись на Партнерский канал @khak_partners\n\n" +
    "Возможно, благодаря этому каналу ты сможешь сделать рывок в доходе!";

  const subscription = await isSubscribed(env.BOT_TOKEN, env.PUBLIC_CHANNEL, user.id);
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
      introText,
      subscribeKeyboard(env.PUBLIC_CHANNEL, refLink)
    );
    return;
  }

  await sendArticlePost(env, chatId, user.id);
}

async function handleCallback(update, env) {
  const data = update.callback_query?.data || "";
  const user = update.callback_query?.from;
  const chatId = update.callback_query?.message?.chat?.id;
  if (!user || !chatId) return;
  try {
    if (data === "subscribed") {
      const subscription = await isSubscribed(env.BOT_TOKEN, env.PUBLIC_CHANNEL, user.id);
      if (typeof subscription === "object" && subscription.ok === false) {
        await sendMessage(
          env.BOT_TOKEN,
          chatId,
          `Не могу проверить подписку на канал.\n\nПричина: ${subscription.error}`
        );
      } else if (subscription) {
        await sendArticlePost(env, chatId, user.id);
      } else {
        await sendMessage(
          env.BOT_TOKEN,
          chatId,
          "К сожалению, не увидил подписки на канал @khak_partners\n\nПерепроверь подписку и нажми на кнопку подписался, сразу после отправлю статью!",
          { inline_keyboard: [[{ text: "Подписался", callback_data: "subscribed" }]] }
        );
      }
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: "Проверяю подписку",
      });
      return;
    }

    if (data === "cabinet:stats") {
      const cab = await buildUserCabinet(env, user);
      await sendMessage(env.BOT_TOKEN, chatId, cab.text, cab.keyboard);
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "cabinet:withdraw") {
      const me = await getUserByTgId(env, user.id);
      if ((me.balance || 0) < MIN_WITHDRAWAL) {
        await sendMessage(
          env.BOT_TOKEN,
          chatId,
          `Вывод доступен от ${formatMoney(MIN_WITHDRAWAL)}.\nВаш баланс: ${formatMoney(me.balance || 0)}`
        );
      } else {
        await addPayoutRequest(env, user.id, me.balance || 0);
        await sendMessage(
          env.BOT_TOKEN,
          chatId,
          `Заявка на вывод создана на сумму ${formatMoney(me.balance || 0)}.\nАдминистратор обработает её вручную.`
        );
      }
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "followup:method") {
      const stage = await getContentStage(env, user.id);
      if (!stage?.followup_sent_at) {
        await sendFollowupPost(env, chatId, user.id);
      } else if (!stage?.payment_sent_at) {
        await sendPaymentPost(env, chatId, user.id);
      } else {
        await sendPaymentPost(env, chatId, user.id);
      }
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "admin:stats") {
      if (!(await adminIsAllowed(env, user.id))) {
        await sendMessage(env.BOT_TOKEN, chatId, "У тебя нет доступа к админ-кабинету.");
        return;
      }
      await sendAdminStats(chatId, env);
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "admin:refs") {
      if (!(await adminIsAllowed(env, user.id))) {
        await sendMessage(env.BOT_TOKEN, chatId, "У тебя нет доступа к админ-кабинету.");
        return;
      }
      await sendAdminRefs(chatId, env);
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "admin:notify") {
      if (!(await adminIsAllowed(env, user.id))) {
        await sendMessage(env.BOT_TOKEN, chatId, "У тебя нет доступа к админ-кабинету.");
        return;
      }
      const enabled = (await dbOne(env, "SELECT value FROM settings WHERE key = 'notify_enabled'"))?.value === "1";
      await dbRun(env, "INSERT OR REPLACE INTO settings (key, value) VALUES ('notify_enabled', ?)", [enabled ? "0" : "1"]);
      const payload = await buildAdminNotify(env);
      await sendMessage(env.BOT_TOKEN, chatId, payload.text, payload.keyboard);
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "admin:home") {
      if (!(await adminIsAllowed(env, user.id))) {
        await sendMessage(env.BOT_TOKEN, chatId, "У тебя нет доступа к админ-кабинету.");
        return;
      }
      await sendMessage(env.BOT_TOKEN, chatId, "Админ кабинет", adminKeyboard());
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data === "admin:search") {
      if (!(await adminIsAllowed(env, user.id))) {
        await sendMessage(env.BOT_TOKEN, chatId, "У тебя нет доступа к админ-кабинету.");
        return;
      }
      await setAdminState(env, user.id, "await_search", "1");
      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        "Отправь ID, username или реферальный код пользователя.\n\nПример: 123456789 или @nickname или u123456789"
      );
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }

    if (data.startsWith("admin:payout:")) {
      if (!(await adminIsAllowed(env, user.id))) {
        await sendMessage(env.BOT_TOKEN, chatId, "У тебя нет доступа к админ-кабинету.");
        return;
      }
      const targetId = Number(data.split(":")[2]);
      if (!targetId) return;
      await setAdminState(env, user.id, "await_payout_user", String(targetId));
      await sendMessage(
        env.BOT_TOKEN,
        chatId,
        `Введи сумму выплаты для пользователя ${targetId}.\nФормат: 1500`
      );
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
      return;
    }
  } catch (error) {
    await sendMessage(env.BOT_TOKEN, chatId, `Ошибка в кнопке: ${error.message}`);
    await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: update.callback_query.id,
    });
  }
}

async function handleManualAddPayout(update, env, amount) {
  if (!(await adminIsAllowed(env, update.message.from.id))) return;
  const text = (update.message.text || "").trim().split(/\s+/);
  const targetId = Number(text[1]);
  const payout = Number(text[2]);
  if (!targetId || !payout) {
    await sendMessage(env.BOT_TOKEN, update.message.chat.id, "Формат: /payout user_id amount");
    return;
  }
  const user = await getUserByTgId(env, targetId);
  if (!user) {
    await sendMessage(env.BOT_TOKEN, update.message.chat.id, "Реферал не найден");
    return;
  }
  await dbRun(env, "UPDATE users SET balance = MAX(balance - ?, 0), payouts_total = payouts_total + ? WHERE tg_id = ?", [
    payout,
    payout,
    targetId,
  ]);
  await dbRun(
    env,
    "INSERT INTO payouts (user_id, amount, created_at, admin_id) VALUES (?, ?, ?, ?)",
    [targetId, payout, new Date().toISOString(), update.message.from.id]
  );
  await sendMessage(env.BOT_TOKEN, update.message.chat.id, `Выплата ${formatMoney(payout)} учтена для ${targetId}`);
}

async function handleAdminText(update, env) {
  const admin = update.message.from;
  if (!(await adminIsAllowed(env, admin.id))) return;
  const state = await getAdminState(env, admin.id);
  const text = (update.message.text || "").trim();

  if (!state) return;

  if (state.state_key === "await_search") {
    let user = null;
    if (/^\d+$/.test(text)) {
      user = await getUserByTgId(env, Number(text));
    } else if (text.startsWith("@")) {
      user = await dbOne(env, "SELECT * FROM users WHERE username = ?", [text.slice(1)]);
    } else {
      user = await getUserByReferralCode(env, text.replace(/^ref_/, ""));
    }

    if (!user) {
      await sendMessage(env.BOT_TOKEN, update.message.chat.id, "Реферал не найден");
      return;
    }

    const card = await buildReferralCard(env, user);
    await sendMessage(env.BOT_TOKEN, update.message.chat.id, card.text, card.keyboard);
    await clearAdminState(env, admin.id);
    return;
  }

  if (state.state_key === "await_payout_user") {
    const amount = Number(text.replace(",", "."));
    const targetId = Number(state.state_value);
    if (!amount || amount <= 0) {
      await sendMessage(env.BOT_TOKEN, update.message.chat.id, "Введи корректную сумму, например 1500");
      return;
    }
    const user = await getUserByTgId(env, targetId);
    if (!user) {
      await sendMessage(env.BOT_TOKEN, update.message.chat.id, "Пользователь не найден");
      await clearAdminState(env, admin.id);
      return;
    }
    const payout = Math.min(amount, Number(user.balance || 0));
    await dbRun(
      env,
      "UPDATE users SET balance = MAX(balance - ?, 0), payouts_total = payouts_total + ? WHERE tg_id = ?",
      [payout, payout, targetId]
    );
    await dbRun(
      env,
      "INSERT INTO payouts (user_id, amount, created_at, admin_id) VALUES (?, ?, ?, ?)",
      [targetId, payout, new Date().toISOString(), admin.id]
    );
    await sendMessage(
      env.BOT_TOKEN,
      update.message.chat.id,
      `Выплата учтена: ${formatMoney(payout)} для ${targetId}`
    );
    await clearAdminState(env, admin.id);
  }
}

async function notifyPayment(env, payment) {
  const enabled = (await dbOne(env, "SELECT value FROM settings WHERE key = 'notify_enabled'"))?.value === "1";
  if (!enabled) return;
  const referrer = payment.referrer_id ? await getUserByTgId(env, payment.referrer_id) : null;
  const refName = referrer ? (referrer.first_name || referrer.username || referrer.tg_id) : "нет";
  const clientName = payment.client_name || payment.client_username || "unknown";
  const admins = String(env.ADMIN_IDS || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter(Boolean);
  const text = `Оплата: ${formatMoney(payment.amount)}, № ${payment.id} от ${clientName} | Реферал - ${refName}`;
  for (const adminId of admins) {
    await sendMessage(env.BOT_TOKEN, adminId, text);
  }
}

async function recordPayment(env, payload) {
  const payment = await dbOne(env, "SELECT * FROM payments WHERE id = ?", [payload.payment_id]);
  if (payment) return payment;
  const user = await getUserByTgId(env, payload.user_id);
  const referrerId = payload.referrer_id || user?.referrer_id || null;
  await dbRun(
    env,
    "INSERT INTO payments (id, user_id, referrer_id, amount, status, client_name, client_username, paid_at, created_at) VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?)",
    [
      payload.payment_id,
      payload.user_id,
      referrerId,
      payload.amount,
      payload.client_name || "",
      payload.client_username || "",
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  );
  if (referrerId) {
    await addReferralEarning(env, referrerId, payload.payment_id, payload.amount);
  }
  await upsertContentStage(env, payload.user_id, "payment_completed", {
    payment_completed_at: new Date().toISOString(),
  });
  await notifyPayment(env, { ...payload, id: payload.payment_id, referrer_id: referrerId });
}

async function webhookInfo(token) {
  return telegramRequest(token, "getWebhookInfo", {});
}

async function ensureSchema(env) {
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, referral_code TEXT, referrer_id INTEGER, balance REAL DEFAULT 0, payouts_total REAL DEFAULT 0, ref_clicks INTEGER DEFAULT 0, referred_sales INTEGER DEFAULT 0, withdrawal_requests INTEGER DEFAULT 0, created_at TEXT)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id INTEGER, referrer_id INTEGER, amount REAL, status TEXT, client_name TEXT, client_username TEXT, paid_at TEXT, created_at TEXT)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS referral_earnings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, payment_id TEXT, amount REAL, reward REAL, created_at TEXT)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS withdrawal_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, status TEXT, created_at TEXT)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, created_at TEXT, admin_id INTEGER)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS content_stages (user_id INTEGER PRIMARY KEY, stage TEXT NOT NULL, updated_at TEXT, article_sent_at TEXT, followup_sent_at TEXT, payment_sent_at TEXT, payment_reminder1_at TEXT, payment_reminder2_at TEXT, payment_completed_at TEXT)"
  );
  const boot = (await dbOne(env, "SELECT value FROM meta WHERE key = 'schema_bootstrapped'"))?.value;
  if (boot === "1") return;
  await dbRun(
    env,
    "CREATE TABLE IF NOT EXISTS admin_state (admin_id INTEGER PRIMARY KEY, state_key TEXT NOT NULL, state_value TEXT, updated_at TEXT)"
  );
  await dbRun(env, "INSERT OR REPLACE INTO settings (key, value) VALUES ('notify_enabled', '1')");
  await dbRun(env, "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_bootstrapped', '1')");
}

async function sendDelayedFollowups(env) {
  const cutoff = new Date(Date.now() - FOLLOWUP_DELAY_MINUTES * 60 * 1000).toISOString();
  const rows = await dbAll(
    env,
    "SELECT user_id FROM content_stages WHERE stage = 'article_sent' AND updated_at <= ? AND followup_sent_at IS NULL",
    [cutoff]
  );
  for (const row of rows.results || []) {
    const stage = await getContentStage(env, row.user_id);
    if (stage?.followup_sent_at) continue;
    await sendFollowupPost(env, row.user_id, row.user_id);
  }
}

async function sendPaymentReminders(env) {
  const reminder1Cutoff = new Date(Date.now() - PAYMENT_REMINDER_1_MINUTES * 60 * 1000).toISOString();
  const reminder2Cutoff = new Date(Date.now() - (FOLLOWUP_DELAY_MINUTES + PAYMENT_REMINDER_2_MINUTES) * 60 * 1000).toISOString();

  const reminder1Rows = await dbAll(
    env,
    "SELECT user_id FROM content_stages WHERE stage = 'payment_sent' AND updated_at <= ? AND payment_completed_at IS NULL AND payment_reminder1_at IS NULL",
    [reminder1Cutoff]
  );
  for (const row of reminder1Rows.results || []) {
    await sendPaymentReminder1(env, row.user_id, row.user_id);
  }

  const reminder2Rows = await dbAll(
    env,
    "SELECT user_id FROM content_stages WHERE stage IN ('payment_sent','payment_reminder1_sent') AND updated_at <= ? AND payment_completed_at IS NULL AND payment_reminder1_at IS NOT NULL AND payment_reminder2_at IS NULL",
    [reminder2Cutoff]
  );
  for (const row of reminder2Rows.results || []) {
    await sendPaymentReminder2(env, row.user_id, row.user_id);
  }
}

export default {
  async fetch(request, env) {
    await ensureSchema(env);

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

    if (request.method !== "POST") return json({ ok: true });

    const update = await request.json();

    if (update.message?.text?.startsWith("/start")) {
      await handleStart(update, env);
    }

    if (update.message?.text === "Подписался") {
      await handleSubscriptionCheck(update.message.from.id, update.message.chat.id, env);
    }

    if (update.message?.text === "/partner" || update.message?.text === "/cabinet") {
      await sendUserCabinet(update, env);
    }

    if (update.message?.text?.startsWith("/payout ")) {
      await handleManualAddPayout(update, env);
    }

    if (update.message?.text === "/admin") {
      await claimOwnerIfNeeded(env, update.message.from.id);
      if (await adminIsAllowed(env, update.message.from.id)) {
        await sendMessage(env.BOT_TOKEN, update.message.chat.id, "Админ кабинет", adminKeyboard());
      } else {
        await sendMessage(
          env.BOT_TOKEN,
          update.message.chat.id,
          "У тебя нет доступа к админ-кабинету."
        );
      }
    }

    if (update.message?.text && !(update.message.text.startsWith("/"))) {
      await handleAdminText(update, env);
    }

    if (update.callback_query) {
      await handleCallback(update, env);
    }

    if (update.message?.successful_payment) {
      const invoice = update.message.successful_payment;
      const paymentId = invoice.telegram_payment_charge_id || invoice.provider_payment_charge_id;
      await recordPayment(env, {
        payment_id: paymentId,
        user_id: update.message.from.id,
        amount: invoice.total_amount / 100,
        client_name: update.message.from.first_name || "",
        client_username: update.message.from.username || "",
        referrer_id: null,
      });
    }

    return json({ ok: true });
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(sendDelayedFollowups(env));
    ctx.waitUntil(sendPaymentReminders(env));
  },
};
