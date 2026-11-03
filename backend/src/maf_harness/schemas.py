import ipaddress
import re
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal, Self
from urllib.parse import urlparse
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)


class ProviderKind(StrEnum):
    FOUNDRY = "foundry"
    LOCAL = "local"


class DataBoundary(StrEnum):
    MACHINE = "machine"
    LOCAL_NETWORK = "local_network"
    EXTERNAL = "external"


_PUBLISHED_LOCAL_MODEL_LIMITS = {
    "phi35mini": (131_072, 4_096),
    "qwen25coder": (131_072, 8_192),
}


def published_local_model_limits(model: str) -> tuple[int, int] | None:
    normalized = re.sub(r"[^a-z0-9]+", "", model.casefold())
    for model_family, limits in _PUBLISHED_LOCAL_MODEL_LIMITS.items():
        if model_family in normalized:
            return limits
    return None


def endpoint_data_boundary(kind: ProviderKind, endpoint: str) -> DataBoundary:
    if kind is ProviderKind.FOUNDRY:
        return DataBoundary.EXTERNAL
    hostname = urlparse(endpoint).hostname
    if hostname is None:
        return DataBoundary.EXTERNAL
    normalized = hostname.casefold()
    if normalized == "localhost" or normalized.endswith(".localhost"):
        return DataBoundary.MACHINE
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return DataBoundary.EXTERNAL
    if address.is_loopback:
        return DataBoundary.MACHINE
    if address.is_private or address.is_link_local:
        return DataBoundary.LOCAL_NETWORK
    return DataBoundary.EXTERNAL


class ProviderProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: ProviderKind
    endpoint: str
    model: str = Field(min_length=1, max_length=200)
    api_key_env: str | None = Field(default=None, max_length=100)
    max_context_window_tokens: int = Field(default=32_768, ge=1_024)
    max_output_tokens: int = Field(default=4_096, ge=256)

    @field_validator("name", "model")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Value cannot be blank")
        return normalized

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("Endpoint must start with http:// or https://")
        return normalized

    @model_validator(mode="after")
    def assume_published_local_model_limits(self) -> Self:
        if self.kind is ProviderKind.LOCAL:
            limits = published_local_model_limits(self.model)
            if limits is not None:
                (
                    self.max_context_window_tokens,
                    self.max_output_tokens,
                ) = limits
        return self


class ProviderProfileUpdate(ProviderProfileCreate):
    pass


class ProviderProfile(ProviderProfileCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: datetime

    @computed_field
    @property
    def data_boundary(self) -> DataBoundary:
        return endpoint_data_boundary(self.kind, self.endpoint)


class ProviderProbeResult(BaseModel):
    ok: bool
    provider: ProviderKind
    model: str
    message: str
    tool_calling: bool = True
    streaming: bool = True


class ProviderProbeRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    provider_id: str
    ok: bool
    message: str
    tool_calling: bool
    streaming: bool
    checked_at: datetime


class ProviderConfigurationExport(BaseModel):
    schema_version: Literal[1] = 1
    profiles: list[ProviderProfileCreate]


class ProviderConfigurationImport(BaseModel):
    schema_version: Literal[1]
    profiles: list[ProviderProfileCreate] = Field(max_length=50)


type PersonaId = Literal[
    "default",
    "engineer",
    "intelligence",
    "blogger",
    "social",
    "presentations",
    "markdown",
    "learning",
]


class SessionCreate(BaseModel):
    provider_id: str
    craft_provider_id: str | None = None
    persona_id: PersonaId = "default"
    title: str = Field(default="New session", min_length=1, max_length=120)


class SessionTitleUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Session title cannot be blank")
        return normalized


class SessionCraftProviderUpdate(BaseModel):
    craft_provider_id: str


class SessionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider_id: str
    craft_provider_id: str | None
    persona_id: PersonaId | None = None
    title: str
    created_at: datetime
    updated_at: datetime


class EventRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: str
    sequence: int
    type: str
    payload: dict[str, Any]
    created_at: datetime


class SessionDetail(SessionSummary):
    events: list[EventRecord]


class WorkspaceBindRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2_048)

    @field_validator("path")
    @classmethod
    def normalize_path(cls, value: str) -> str:
        return value.strip()


class WorkspaceDirectorySelection(BaseModel):
    path: str | None


class WorkspaceCapabilityUpdate(BaseModel):
    write_tools_enabled: bool | None = None
    auto_approve_enabled: bool | None = None


class WorkspaceInstructionSource(BaseModel):
    scope: str
    label: str
    relative_path: str
    precedence: int
    content: str
    editable: bool = False


class SessionInstructionUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=65_536)

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Session instructions must not be empty")
        return normalized


class WorkspaceContextFile(BaseModel):
    relative_path: str
    kind: str
    size_bytes: int


class WorkspaceContext(BaseModel):
    root_path: str
    instructions: list[WorkspaceInstructionSource]
    context_files: list[WorkspaceContextFile]
    discovered_file_count: int
    discovery_truncated: bool
    read_tools: list[str]
    write_tools_enabled: bool
    auto_approve_enabled: bool
    write_tools: list[str]


class SkillSummary(BaseModel):
    name: str
    description: str
    source: str
    precedence: int
    relative_path: str
    size_bytes: int


class HookSummary(BaseModel):
    id: str
    event: str
    action: str
    message: str
    source: str
    precedence: int
    relative_path: str


class McpServerSummary(BaseModel):
    id: str
    description: str
    enabled: bool
    transport: str
    allowed_tools: list[str]
    progressive_disclosure: bool
    approval_required: bool
    missing_env_vars: list[str]


class SubagentSummary(BaseModel):
    name: str
    description: str
    permissions: list[str]
    timeout_seconds: int
    max_tool_calls: int
    max_tool_output_chars: int
    max_result_chars: int
    max_output_tokens: int


class ArtifactVersion(BaseModel):
    version: int
    file_name: str
    size_bytes: int
    created_at: datetime


class ArtifactSummary(BaseModel):
    id: str
    session_id: str
    title: str
    media_type: str
    current_version: int
    created_at: datetime
    updated_at: datetime
    versions: list[ArtifactVersion]


class ArtifactPreview(ArtifactSummary):
    version: int
    content: str
    content_truncated: bool


class TaskItem(BaseModel):
    id: int
    title: str
    description: str | None = None
    is_complete: bool = False


class SessionStateView(BaseModel):
    mode: str
    tasks: list[TaskItem]
    is_running: bool


class ModeUpdate(BaseModel):
    mode: str

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"plan", "execute"}:
            raise ValueError("Mode must be plan or execute")
        return normalized


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


class ApprovalPreview(BaseModel):
    operation: str
    category: str
    risk_level: str
    affected_paths: list[str] = Field(default_factory=list)
    preview_kind: str
    preview_content: str | None = None
    preview_truncated: bool = False


class ApprovalRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    session_id: str
    tool_name: str
    arguments: dict[str, Any]
    request: dict[str, Any]
    preview: ApprovalPreview
    status: ApprovalStatus
    created_at: datetime
    decided_at: datetime | None


class ApprovalDecision(BaseModel):
    approved: bool


class MemoryEntry(BaseModel):
    file_name: str
    description: str | None = None
    content: str


class MemoryCreate(BaseModel):
    file_name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    content: str = Field(max_length=1_000_000)

    @field_validator("file_name")
    @classmethod
    def validate_file_name(cls, value: str) -> str:
        normalized = value.strip()
        reserved_stems = {"CON", "PRN", "AUX", "NUL"} | {
            f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)
        }
        stem = normalized.split(".", maxsplit=1)[0].upper()
        if (
            not normalized
            or normalized in {".", ".."}
            or normalized.endswith((".", " "))
            or re.search(r'[<>:"/\\|?*\x00-\x1f]', normalized)
            or stem in reserved_stems
            or normalized.casefold() == "memories.md"
            or normalized.casefold().endswith("_description.md")
        ):
            raise ValueError("Memory file name must be a flat relative file name")
        return normalized


class SessionArchiveEvent(BaseModel):
    type: str = Field(min_length=1, max_length=50)
    payload: dict[str, Any]
    created_at: datetime


class SessionArchiveArtifact(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    media_type: Literal["text/markdown"]
    versions: list[str] = Field(min_length=1, max_length=100)

    @field_validator("versions")
    @classmethod
    def validate_version_sizes(cls, versions: list[str]) -> list[str]:
        if any(len(version.encode("utf-8")) > 1_048_576 for version in versions):
            raise ValueError("Archive artifact versions cannot exceed 1,048,576 bytes")
        return versions


class SessionArchive(BaseModel):
    schema_version: Literal[1] = 1
    title: str = Field(min_length=1, max_length=120)
    persona_id: PersonaId | None = None
    source_provider: ProviderProfileCreate
    events: list[SessionArchiveEvent] = Field(max_length=10_000)
    memories: list[MemoryEntry] = Field(max_length=100)
    artifacts: list[SessionArchiveArtifact] = Field(max_length=100)
    session_instructions: str | None = Field(default=None, max_length=65_536)


class SessionArchiveImport(BaseModel):
    provider_id: str
    archive: SessionArchive


class StreamPrompt(BaseModel):
    type: str
    content: str = Field(min_length=1, max_length=100_000)


class RunResult(BaseModel):
    text: str
    session_state: dict[str, Any]
    pending_approvals: list[dict[str, Any]] = []


def new_id() -> str:
    return str(uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)
