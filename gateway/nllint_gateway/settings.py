from typing import Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", hide_input_in_errors=True
    )

    database_url: SecretStr = Field(min_length=1)
    database_migration_url: SecretStr | None = None
    nllint_session_secret: SecretStr = Field(min_length=32)
    nllint_provider_encryption_key: SecretStr
    nllint_admin_token: SecretStr | None = Field(default=None, min_length=32)
    nllint_dev_ui_url: str | None = None
    nllint_remote_dev_origin: str | None = None
    nllint_app_url: str = "http://localhost:8080"
    github_client_id: str = ""
    github_client_secret: SecretStr = SecretStr("")
    allowed_github_user_ids: str = ""
    typesafe_api_key: SecretStr = Field(min_length=1)
    typesafe_base_url: str = "https://api.typesafe.ai"
    nllint_decision_model: str = "jev-latest"
    openrouter_api_key: SecretStr = Field(min_length=1)
    nllint_range_base_url: str = "https://openrouter.ai/api/v1"
    nllint_range_model: str = "openai/gpt-4.1-mini"
    nllint_allowed_provider_base_urls: str = ""
    nllint_cache_epoch: str = "1"
    nllint_worker_enabled: bool = True
    nllint_worker_slots: int = Field(4, ge=1, le=32)
    nllint_decision_requests_per_minute: int = Field(120, ge=1, le=6000)
    nllint_range_requests_per_minute: int = Field(60, ge=1, le=6000)
    nllint_annotation_delay_seconds: int = Field(60, ge=0, le=3600)
    langfuse_public_key: str = Field(min_length=1)
    langfuse_secret_key: SecretStr = Field(min_length=1)
    langfuse_base_url: str = "https://cloud.langfuse.com"
    langfuse_project_id: str = ""
    langfuse_tracing_enabled: bool = True

    @classmethod
    def from_env(cls) -> Self:
        # BaseSettings resolves required fields through its environment and dotenv sources.
        return cls()  # pyright: ignore[reportCallIssue]

    @property
    def oauth_enabled(self) -> bool:
        return bool(self.github_client_id)

    @property
    def allowed_ids(self) -> set[str]:
        return {
            part.strip()
            for part in self.allowed_github_user_ids.split(",")
            if part.strip()
        }

    def allows(self, user_id: int) -> bool:
        if self.oauth_enabled:
            return str(user_id) in self.allowed_ids
        return user_id == 0 and self.nllint_admin_token is not None

    @model_validator(mode="after")
    def valid_auth(self):
        origin = urlsplit(self.nllint_app_url)
        if origin.scheme not in {"http", "https"} or (
            not origin.hostname
            or origin.username
            or origin.password
            or origin.path not in {"", "/"}
            or origin.query
            or origin.fragment
        ):
            raise ValueError("NLLINT_APP_URL must be an HTTP or HTTPS origin")
        local = origin.hostname in {"127.0.0.1", "localhost", "::1"}
        if not local and origin.scheme != "https":
            raise ValueError("NLLINT_APP_URL must use HTTPS outside loopback")
        self.nllint_app_url = self.nllint_app_url.rstrip("/")
        if self.nllint_dev_ui_url:
            ui = urlsplit(self.nllint_dev_ui_url)
            if (
                not local
                or ui.scheme != origin.scheme
                or ui.hostname != origin.hostname
                or ui.username
                or ui.password
                or ui.path not in {"", "/"}
                or ui.query
                or ui.fragment
            ):
                raise ValueError(
                    "NLLINT_DEV_UI_URL must use the same loopback host and scheme as NLLINT_APP_URL"
                )
            self.nllint_dev_ui_url = self.nllint_dev_ui_url.rstrip("/")
        if self.nllint_remote_dev_origin:
            dev = urlsplit(self.nllint_remote_dev_origin)
            if (
                local
                or dev.scheme != "http"
                or dev.hostname != "localhost"
                or dev.port is None
                or dev.username
                or dev.password
                or dev.path not in {"", "/"}
                or dev.query
                or dev.fragment
            ):
                raise ValueError(
                    "NLLINT_REMOTE_DEV_ORIGIN requires a hosted gateway and an HTTP localhost origin with a port"
                )
            self.nllint_remote_dev_origin = f"http://localhost:{dev.port}"
        if self.oauth_enabled:
            if (
                not self.github_client_secret.get_secret_value()
                or not self.allowed_ids
                or any(
                    not value.isascii() or not value.isdigit() or int(value) <= 0
                    for value in self.allowed_ids
                )
            ):
                raise ValueError(
                    "GitHub sign-in requires a client secret and a list of numeric GitHub user IDs"
                )
        elif self.github_client_secret.get_secret_value() or self.allowed_ids:
            raise ValueError("Set GITHUB_CLIENT_ID to enable GitHub sign-in")
        elif self.nllint_admin_token is None or origin.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError(
                "Set GitHub OAuth credentials or configure local development token sign-in on loopback"
            )
        return self
