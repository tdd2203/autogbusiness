from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(..., alias="DATABASE_URL")

    jwt_secret: str = Field(..., alias="JWT_SECRET")
    jwt_algorithm: str = Field("HS256", alias="JWT_ALGORITHM")
    jwt_expire_minutes: int = Field(720, alias="JWT_EXPIRE_MINUTES")

    frontend_origin: str = Field("http://localhost:5173", alias="FRONTEND_ORIGIN")

    super_admin_email: str = Field(..., alias="SUPER_ADMIN_EMAIL")
    super_admin_username: str = Field(..., alias="SUPER_ADMIN_USERNAME")
    super_admin_password: str = Field(..., alias="SUPER_ADMIN_PASSWORD")

    # DEPRECATED kể từ Tuần 2.4 — extension API key giờ là per-workspace, sinh từ DB.
    # Giữ optional để không phá .env cũ.
    extension_api_key: str | None = Field(default=None, alias="EXTENSION_API_KEY")


@lru_cache
def get_settings() -> Settings:
    return Settings()
