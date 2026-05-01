from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError


async def is_subscribed(bot: Bot, channel: str, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(chat_id=channel, user_id=user_id)
        return member.status in {"member", "administrator", "creator"}
    except (TelegramBadRequest, TelegramForbiddenError):
        return False


async def create_private_invite_link(bot: Bot, channel_id: int, user_id: int) -> str:
    invite = await bot.create_chat_invite_link(
        chat_id=channel_id,
        member_limit=1,
        name=f"access_{user_id}",
    )
    return invite.invite_link

