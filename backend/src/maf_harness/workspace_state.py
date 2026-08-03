import os
import tempfile
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

MAX_WORKSPACE_SETTINGS_BYTES = 70_000


class WorkspaceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=1, frozen=True)
    write_tools_enabled: bool = False
    auto_approve_enabled: bool = False
    session_instructions: str | None = Field(default=None, max_length=65_536)


class WorkspaceSettingsStore:
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = workspace_root.resolve(strict=True)
        if not self.workspace_root.is_dir():
            raise ValueError("Workspace root must identify an existing directory")
        self.directory = self.workspace_root / ".prudence"
        self.path = self.directory / "settings.json"

    def exists(self) -> bool:
        return self.path.exists() or self.path.is_symlink()

    def load(self) -> WorkspaceSettings:
        if not self.path.exists():
            return WorkspaceSettings()
        source = self._resolved_settings_file()
        if source.stat().st_size > MAX_WORKSPACE_SETTINGS_BYTES:
            raise ValueError(
                f"Workspace settings exceed {MAX_WORKSPACE_SETTINGS_BYTES} bytes"
            )
        settings = WorkspaceSettings.model_validate_json(source.read_text(encoding="utf-8"))
        if settings.schema_version != 1:
            raise ValueError(
                f"Unsupported workspace settings schema version: {settings.schema_version}"
            )
        return settings

    def save(self, settings: WorkspaceSettings) -> WorkspaceSettings:
        self._ensure_directory()
        encoded = settings.model_dump_json(indent=2).encode("utf-8")
        if len(encoded) > MAX_WORKSPACE_SETTINGS_BYTES:
            raise ValueError(
                f"Workspace settings exceed {MAX_WORKSPACE_SETTINGS_BYTES} bytes"
            )
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=self.directory,
                prefix=".settings-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(encoded)
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()
        return settings

    def _ensure_directory(self) -> None:
        if self.directory.exists():
            if self.directory.is_symlink() or not self.directory.is_dir():
                raise ValueError("Workspace .prudence path must be a real directory")
        else:
            self.directory.mkdir()
        resolved = self.directory.resolve(strict=True)
        if not resolved.is_relative_to(self.workspace_root):
            raise ValueError("Workspace settings directory escapes the workspace")

    def _resolved_settings_file(self) -> Path:
        if self.path.is_symlink() or not self.path.is_file():
            raise ValueError("Workspace settings must be a real file")
        resolved = self.path.resolve(strict=True)
        if not resolved.is_relative_to(self.workspace_root):
            raise ValueError("Workspace settings file escapes the workspace")
        return resolved
