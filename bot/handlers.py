from aiogram import Bot, F, Router
from aiogram.filters import CommandStart
from aiogram.types import CallbackQuery, Message

from bot.config import settings
from bot.keyboards import article_keyboard, pay_keyboard
from bot.services import create_private_invite_link, is_subscribed


router = Router()


@router.message(CommandStart())
async def start(message: Message, bot: Bot) -> None:
    subscribed = await is_subscribed(bot, settings.public_channel, message.from_user.id)
    if not subscribed:
        await message.answer(
            "Чтобы получить доступ, подпишитесь на канал и нажмите /start еще раз."
        )
        return

    await message.answer(
        "Подписка подтверждена. Вот статья:",
        reply_markup=article_keyboard(settings.article_url),
    )


@router.callback_query(F.data == "buy_access")
async def buy_access(callback: CallbackQuery) -> None:
    await callback.message.answer(
        "Здесь подключим оплату. Пока можно вставить ссылку на платежный сервис или invoice.",
        reply_markup=pay_keyboard("https://example.com/pay"),
    )
    await callback.answer()


async def grant_access_after_payment(bot: Bot, user_id: int) -> str:
    return await create_private_invite_link(bot, settings.private_channel_id, user_id)

