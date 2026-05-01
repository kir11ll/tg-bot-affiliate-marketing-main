# Telegram subscription bot

Базовый каркас Telegram-бота, который:

- проверяет подписку на публичный канал;
- выдаёт кнопку на статью;
- после покупки может выдавать доступ в закрытый канал;
- удобно обновляется через GitHub.

## Быстрый старт

1. Скопируйте `.env.example` в `.env` и заполните значения.
2. Установите зависимости:

```bash
pip install -r requirements.txt
```

3. Запустите бота:

```bash
python main.py
```

## Что уже есть

- `/start` с проверкой подписки;
- кнопка на статью;
- заглушка под оплату;
- выдача инвайт-ссылки в приватный канал после оплаты.

## GitHub workflow

Самый простой способ обновлять бот:

1. Создать репозиторий на GitHub.
2. Привязать его как remote.
3. Делать изменения локально.
4. Коммитить и пушить.

Пример:

```bash
git remote add origin https://github.com/USERNAME/REPO.git
git branch -M main
git add .
git commit -m "Initial bot scaffold"
git push -u origin main
```

