import json
from hmac import digest
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from fastapi import HTTPException
from pydantic import Field, SecretStr

from .contracts import Strict


class RouteEdit(Strict):
    base_url: str | None = Field(default=None, max_length=2048)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    api_key: SecretStr | None = Field(default=None, min_length=1, max_length=4096)
    reset: bool = False


class RoutingEdit(Strict):
    decision: RouteEdit = Field(default_factory=RouteEdit)
    ranges: RouteEdit = Field(default_factory=RouteEdit)


def normalize_base(base: str) -> str:
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.query
    ):
        raise ValueError(
            "Provider base URL must be an HTTP or HTTPS URL without credentials or query"
        )
    return base.rstrip("/")


class Routing:
    def __init__(self, settings):
        self.secret = settings.nllint_provider_encryption_key.get_secret_value().encode()
        self.crypto = Fernet(self.secret)
        self.defaults = {
            "decision": {
                "base_url": normalize_base(settings.typesafe_base_url),
                "model": settings.nllint_decision_model,
                "api_key": settings.typesafe_api_key.get_secret_value(),
            },
            "ranges": {
                "base_url": normalize_base(settings.nllint_range_base_url),
                "model": settings.nllint_range_model,
                "api_key": settings.openrouter_api_key.get_secret_value(),
            },
        }
        self.allowed_bases = {
            normalize_base(base.strip())
            for base in settings.nllint_allowed_provider_base_urls.split(",")
            if base.strip()
        }
        self.epoch = settings.nllint_cache_epoch

    def encode(self, values):
        return self.crypto.encrypt(self.serialize(values))

    def decode(self, values):
        return json.loads(self.crypto.decrypt(values)) if values is not None else {}

    @staticmethod
    def serialize(values):
        return json.dumps(values, sort_keys=True, separators=(",", ":")).encode()

    def effective(self, stored=None):
        overrides = self.decode(stored)
        values = {}
        for kind, default in self.defaults.items():
            route = {**default, **overrides.get(kind, {})}
            if (
                "api_key" not in overrides.get(kind, {})
                and route["base_url"] != default["base_url"]
            ):
                raise ValueError(
                    "A custom provider base URL requires a project API key"
                )
            values[kind] = route
        return values

    def version(self, values):
        # Bump the protocol version when the prompt or result contract changes.
        return digest(
            self.secret, self.serialize([3, self.epoch, values]), "sha256"
        ).hex()

    def view(self, stored):
        overrides = self.decode(stored)
        return {
            kind: {
                "base_url": route["base_url"],
                "model": route["model"],
                "custom_key": "api_key" in overrides.get(kind, {}),
                "overridden": bool(overrides.get(kind)),
            }
            for kind, route in self.effective(stored).items()
        }

    def update(self, stored, body: RoutingEdit):
        overrides = self.decode(stored)
        for name, default in self.defaults.items():
            change = getattr(body, name)
            if change.reset:
                overrides.pop(name, None)
                continue
            updated = dict(overrides.get(name, {}))
            if change.base_url is not None:
                try:
                    base = normalize_base(change.base_url)
                except ValueError as error:
                    raise HTTPException(422, str(error)) from error
                if base != default["base_url"] and base not in self.allowed_bases:
                    raise HTTPException(
                        422,
                        "This provider base URL is outside the gateway's approved list",
                    )
                if base != updated.get("base_url", default["base_url"]):
                    # An API key configured for one origin must not be forwarded to another.
                    updated.pop("api_key", None)
                updated["base_url"] = base
            if change.model is not None:
                updated["model"] = change.model
            if change.api_key is not None:
                updated["api_key"] = change.api_key.get_secret_value()
            if (
                updated.get("base_url", default["base_url"]) != default["base_url"]
                and "api_key" not in updated
            ):
                raise HTTPException(
                    422, "Set a project API key when using a custom provider base URL"
                )
            if updated:
                overrides[name] = updated
        return self.encode(overrides) if overrides else None
