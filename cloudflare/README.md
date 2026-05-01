# Cloudflare Workers version

Это webhook-версия Telegram-бота для Cloudflare Workers.

## Что делает

- принимает webhook от Telegram;
- проверяет подписку на канал;
- отправляет кнопку на статью;
- подготавливает сценарий оплаты;
- может выдавать инвайт-ссылку в закрытый канал после оплаты.

## Что нужно настроить

1. Создать Worker в Cloudflare.
2. Добавить секрет `BOT_TOKEN`.
3. Заполнить переменные `PUBLIC_CHANNEL`, `ARTICLE_URL`, `PRIVATE_CHANNEL_ID`, `PAYMENT_URL`.
4. Установить webhook Telegram на URL Worker'а.

## Локальная разработка

```bash
npx wrangler dev
```

## Деплой

```bash
npx wrangler deploy
```

