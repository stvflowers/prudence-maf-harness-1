from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def default_data_directory() -> Path:
    preferred = Path.home() / ".prudence"
    legacy = Path.home() / ".maf-harness"
    return legacy if legacy.exists() and not preferred.exists() else preferred


def default_frontend_directory() -> Path:
    return Path(__file__).resolve().parents[3] / "frontend" / "dist"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PRUDENCE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    data_directory: Path = Field(
        default_factory=default_data_directory,
        validation_alias=AliasChoices(
            "PRUDENCE_DATA_DIRECTORY",
            "MAF_HARNESS_DATA_DIRECTORY",
        ),
    )
    frontend_directory: Path = Field(default_factory=default_frontend_directory)
    database_url: str | None = None
    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        preferred = self.data_directory / "prudence.db"
        legacy = self.data_directory / "harness.db"
        database_path = legacy if legacy.exists() and not preferred.exists() else preferred
        return f"sqlite:///{database_path.as_posix()}"
