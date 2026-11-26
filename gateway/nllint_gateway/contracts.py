from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

RangeServiceTier = Literal["flex", "fast"]
ProjectName = Annotated[str, Field(min_length=1, max_length=200)]
OperatorLabel = Annotated[str, Field(min_length=1, max_length=120)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("*")
    @classmethod
    def reject_null_bytes(cls, value):
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("NUL characters are unsupported")
        return value


def relative_path(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not path.parts
        or path.is_absolute()
        or ".." in path.parts
        or str(path) != value
        or "\\" in value
    ):
        raise ValueError("use a normalized path relative to the project")
    return value


def source_lines(source: str) -> list[str]:
    # Match Rust str::lines for a trailing newline, CRLF, and an empty file.
    parts = source.split("\n")
    lines = [line.removesuffix("\r") for line in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


class Rule(Strict):
    id: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1, max_length=1024)
    text: str = Field(min_length=1, max_length=60_000)

    _path = field_validator("path")(relative_path)


class LintRequest(Strict):
    project: ProjectName
    path: str = Field(min_length=1, max_length=1024)
    source: str = Field(max_length=1_000_000)
    prompt: str = Field(default="", max_length=60_000)
    rules: list[Rule] = Field(min_length=1, max_length=100)

    _path = field_validator("path")(relative_path)

    @model_validator(mode="after")
    def unique_rules(self):
        if len({rule.id for rule in self.rules}) != len(self.rules) or (
            len({rule.path for rule in self.rules}) != len(self.rules)
        ):
            raise ValueError("rule IDs and paths must be unique")
        return self


class LineRange(Strict):
    start: int = Field(
        strict=True, ge=1, description="First line of the range, counted from 1."
    )
    end: int = Field(strict=True, ge=1, description="Last included line of the range.")

    @model_validator(mode="after")
    def ordered(self):
        if self.end < self.start:
            raise ValueError("end must be at or after start")
        return self


class NumberedRanges(Strict):
    ranges: list[LineRange] = Field(max_length=250)

    def checked(self, line_count: int) -> list[LineRange]:
        ranges = sorted(self.ranges, key=lambda region: region.start)
        previous_end = 0
        for region in ranges:
            if region.end > line_count or region.start <= previous_end:
                raise ValueError("ranges must be non-overlapping and within the file")
            previous_end = region.end
        return ranges


class HumanIdentity(Strict):
    type: Literal["HUMAN"]
    user_id: int | None = None


class BotIdentity(Strict):
    type: Literal["BOT"]
    model: str | None = Field(default=None, max_length=200)
    harness_version: str | None = Field(default=None, max_length=120)
    name: str | None = Field(default=None, max_length=120)


class Attribution(Strict):
    labeler_type: Literal["HUMAN", "BOT"] | None = Field(
        default=None,
        description="Annotation author type. Defaults to BOT for bearer-key review requests.",
    )
    labeler_identity: (
        Annotated[HumanIdentity | BotIdentity, Field(discriminator="type")] | None
    ) = None

    @model_validator(mode="after")
    def matching_identity(self):
        if (
            self.labeler_type
            and self.labeler_identity
            and self.labeler_type != self.labeler_identity.type
        ):
            raise ValueError("Labeler type and identity must agree")
        return self


class FileAnnotation(Attribution):
    decision: bool | None = Field(
        description="True confirms a violation, false suppresses findings for the pair, and null clears the annotation.",
    )
    reject_all: bool = Field(
        default=False,
        description="Also mark candidate ranges as no violation. Requires decision=false.",
    )
    run_id: int | None = Field(
        default=None, ge=1, description="Run reviewed when making this decision."
    )


class RangeAnnotation(LineRange, Attribution):
    decision: bool | None = Field(
        description="True confirms the range, false marks it as no violation, and null clears the annotation.",
    )


class KeyName(Strict):
    name: OperatorLabel


class NewProject(Strict):
    name: ProjectName


class Inheritance(Strict):
    parent: ProjectName | None
