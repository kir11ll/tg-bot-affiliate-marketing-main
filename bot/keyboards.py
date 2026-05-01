from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup


def article_keyboard(article_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Открыть статью", url=article_url)],
            [InlineKeyboardButton(text="Получить доступ", callback_data="buy_access")],
        ]
    )


def pay_keyboard(payment_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Оплатить доступ", url=payment_url)]]
    )

