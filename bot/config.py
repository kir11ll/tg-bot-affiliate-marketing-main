import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


def _parse_admin_ids(value: str) -> list[int]:
    if not value.strip():
        return []
    return [int(item.strip()) for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    bot_token: str
    public_channel: str
    private_channel_id: int
    article_url: str
    payment_provider_token: str
    payment_currency: str
    admin_ids: list[int]


settings = Settings(
    bot_token=os.environ["BOT_TOKEN"],
    public_channel=os.environ["PUBLIC_CHANNEL"],
    private_channel_id=int(os.environ["PRIVATE_CHANNEL_ID"]),
    article_url=os.environ["ARTICLE_URL"],
    payment_provider_token=os.getenv("PAYMENT_PROVIDER_TOKEN", ""),
    payment_currency=os.getenv("PAYMENT_CURRENCY", "RUB"),
    admin_ids=_parse_admin_ids(os.getenv("ADMIN_IDS", "")),
)

