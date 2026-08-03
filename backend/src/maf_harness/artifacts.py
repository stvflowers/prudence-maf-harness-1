import mimetypes
import os
import re
import tempfile
from pathlib import Path, PurePosixPath
from threading import Lock
from typing import Literal
from uuid import UUID, uuid4

from maf_harness.schemas import (
    ArtifactPreview,
    ArtifactSummary,
    ArtifactVersion,
    utc_now,
)

MAX_ARTIFACT_BYTES = 1_048_576
MAX_PREVIEW_CHARACTERS = 100_000
WORKSPACE_NOTE_DIRECTORY = "prudence-notes"
WorkspaceArtifactKind = Literal["file", "note"]


class ArtifactStore:
    def __init__(self, root: Path, workspace_root: Path | None = None) -> None:
        self._root = root
        self._workspace_root = (
            workspace_root.resolve(strict=True) if workspace_root is not None else None
        )
        self._lock = Lock()

    @classmethod
    def for_workspace(cls, workspace_root: Path) -> ArtifactStore:
        root = workspace_root.resolve(strict=True)
        return cls(root / ".prudence" / "artifacts", root)

    def write_business_note(
        self,
        session_id: str,
        title: str,
        content: str,
    ) -> ArtifactSummary:
        normalized_title = title.strip()
        if not normalized_title:
            raise ValueError("Artifact title cannot be empty")
        rendered = f"# {normalized_title}\n\n{content}"
        encoded = rendered.encode("utf-8")
        if len(encoded) > MAX_ARTIFACT_BYTES:
            raise ValueError(f"Artifact content exceeds {MAX_ARTIFACT_BYTES} bytes")
        if self._workspace_root is not None:
            return self._write_workspace_note(session_id, normalized_title, encoded)
        return self._write_global_note(session_id, normalized_title, encoded)

    def business_note_relative_path(self, session_id: str, title: str) -> str:
        if self._workspace_root is None:
            raise ValueError("Workspace note paths require a workspace artifact store")
        normalized_title = title.strip()
        if not normalized_title:
            raise ValueError("Artifact title cannot be empty")
        self._workspace_note_directory(create=False)
        existing = next(
            (
                artifact
                for artifact in self.list_artifacts(session_id)
                if artifact.title.casefold() == normalized_title.casefold()
                and self._workspace_manifest_kind(artifact.id) == "note"
            ),
            None,
        )
        if existing is not None:
            return existing.versions[-1].file_name

        base = (
            re.sub(r"[^a-z0-9]+", "-", normalized_title.casefold()).strip("-")
            or "note"
        )
        relative_path = f"{WORKSPACE_NOTE_DIRECTORY}/{base}.md"
        suffix = 2
        assert self._workspace_root is not None
        while (self._workspace_root / Path(*PurePosixPath(relative_path).parts)).exists():
            relative_path = f"{WORKSPACE_NOTE_DIRECTORY}/{base}-{suffix}.md"
            suffix += 1
        return relative_path

    def index_workspace_file(
        self,
        session_id: str,
        relative_path: str,
        *,
        title: str | None = None,
        manifest_kind: WorkspaceArtifactKind = "file",
    ) -> ArtifactSummary:
        if self._workspace_root is None:
            raise ValueError("Workspace indexing requires a workspace artifact store")
        normalized = self._normalize_workspace_path(relative_path)
        target = self._workspace_file(normalized)
        encoded = target.read_bytes()
        if len(encoded) > MAX_ARTIFACT_BYTES:
            raise ValueError(f"Artifact content exceeds {MAX_ARTIFACT_BYTES} bytes")
        try:
            encoded.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("Artifacts must be UTF-8 text files") from exc

        with self._lock:
            artifacts = self.list_artifacts(session_id)
            artifact = next(
                (
                    candidate
                    for candidate in artifacts
                    if candidate.versions
                    and candidate.versions[-1].file_name == normalized
                ),
                None,
            )
            now = utc_now()
            if artifact is None:
                artifact = ArtifactSummary(
                    id=str(uuid4()),
                    session_id=self._validated_id(session_id, "session"),
                    title=(title or normalized).strip(),
                    media_type=mimetypes.guess_type(normalized)[0] or "text/plain",
                    current_version=0,
                    created_at=now,
                    updated_at=now,
                    versions=[],
                )
            next_version = artifact.current_version + 1
            version = ArtifactVersion(
                version=next_version,
                file_name=normalized,
                size_bytes=len(encoded),
                created_at=now,
            )
            updated = artifact.model_copy(
                update={
                    "title": (title or artifact.title).strip(),
                    "current_version": next_version,
                    "updated_at": now,
                    "versions": [version],
                }
            )
            stored_kind = (
                self._workspace_manifest_kind(artifact.id)
                if artifact.current_version > 0
                else manifest_kind
            )
            self._write_workspace_manifest(updated, stored_kind)
            return updated

    def list_artifacts(
        self,
        session_id: str,
        query: str | None = None,
    ) -> list[ArtifactSummary]:
        self._validated_id(session_id, "session")
        normalized_query = query.strip().casefold() if query else None
        if self._workspace_root is not None:
            if not self._root.is_dir():
                return []
            artifacts = [
                ArtifactSummary.model_validate_json(manifest.read_text(encoding="utf-8"))
                for manifest in self._root.glob("*.json")
                if not manifest.is_symlink()
            ]
        else:
            session_directory = self._session_directory(session_id)
            if not session_directory.is_dir():
                return []
            artifacts = [
                ArtifactSummary.model_validate_json(manifest.read_text(encoding="utf-8"))
                for manifest in session_directory.glob("*/manifest.json")
            ]
        if normalized_query:
            artifacts = [
                artifact
                for artifact in artifacts
                if normalized_query in artifact.title.casefold()
                or (
                    artifact.versions
                    and normalized_query
                    in artifact.versions[-1].file_name.casefold()
                )
            ]
        return sorted(artifacts, key=lambda artifact: artifact.updated_at, reverse=True)

    def get_artifact(self, session_id: str, artifact_id: str) -> ArtifactSummary:
        if self._workspace_root is not None:
            self._validated_id(session_id, "session")
            manifest = self._workspace_manifest(artifact_id)
        else:
            manifest = self._artifact_directory(session_id, artifact_id) / "manifest.json"
        if not manifest.is_file() or manifest.is_symlink():
            raise LookupError(f"Artifact {artifact_id} was not found")
        artifact = ArtifactSummary.model_validate_json(manifest.read_text(encoding="utf-8"))
        if (
            self._workspace_root is None
            and artifact.session_id != self._validated_id(session_id, "session")
        ):
            raise ValueError("Artifact manifest does not belong to this session")
        return artifact

    def preview(
        self,
        session_id: str,
        artifact_id: str,
        version: int | None = None,
    ) -> ArtifactPreview:
        artifact = self.get_artifact(session_id, artifact_id)
        selected_version = version or artifact.current_version
        metadata = self._version_metadata(artifact, selected_version)
        content = self._version_path(session_id, artifact_id, artifact, metadata).read_text(
            encoding="utf-8"
        )
        return ArtifactPreview(
            **artifact.model_dump(),
            version=selected_version,
            content=content[:MAX_PREVIEW_CHARACTERS],
            content_truncated=len(content) > MAX_PREVIEW_CHARACTERS,
        )

    def download_path(
        self,
        session_id: str,
        artifact_id: str,
        version: int | None = None,
    ) -> tuple[ArtifactSummary, ArtifactVersion, Path]:
        artifact = self.get_artifact(session_id, artifact_id)
        selected_version = version or artifact.current_version
        metadata = self._version_metadata(artifact, selected_version)
        return (
            artifact,
            metadata,
            self._version_path(session_id, artifact_id, artifact, metadata),
        )

    def _write_global_note(
        self, session_id: str, normalized_title: str, encoded: bytes
    ) -> ArtifactSummary:
        with self._lock:
            artifacts = self.list_artifacts(session_id)
            artifact = next(
                (
                    candidate
                    for candidate in artifacts
                    if candidate.title.casefold() == normalized_title.casefold()
                ),
                None,
            )
            now = utc_now()
            if artifact is None:
                artifact = ArtifactSummary(
                    id=str(uuid4()),
                    session_id=self._validated_id(session_id, "session"),
                    title=normalized_title,
                    media_type="text/markdown",
                    current_version=0,
                    created_at=now,
                    updated_at=now,
                    versions=[],
                )
            next_version = artifact.current_version + 1
            artifact_directory = self._artifact_directory(session_id, artifact.id)
            version_directory = artifact_directory / "versions"
            version_directory.mkdir(parents=True, exist_ok=True)
            relative_file_name = f"versions/{next_version}.md"
            (artifact_directory / relative_file_name).write_bytes(encoded)
            version = ArtifactVersion(
                version=next_version,
                file_name=relative_file_name,
                size_bytes=len(encoded),
                created_at=now,
            )
            updated = artifact.model_copy(
                update={
                    "current_version": next_version,
                    "updated_at": now,
                    "versions": [*artifact.versions, version],
                }
            )
            self._atomic_write(
                artifact_directory / "manifest.json",
                updated.model_dump_json(indent=2).encode("utf-8"),
            )
            return updated

    def _write_workspace_note(
        self,
        session_id: str,
        title: str,
        encoded: bytes,
    ) -> ArtifactSummary:
        assert self._workspace_root is not None
        relative_path = self.business_note_relative_path(session_id, title)
        self._workspace_note_directory(create=True)
        candidate = self._workspace_root / Path(*PurePosixPath(relative_path).parts)
        target = (
            self._workspace_file(relative_path)
            if candidate.exists()
            else candidate
        )
        self._atomic_write(target, encoded)
        return self.index_workspace_file(
            session_id,
            relative_path,
            title=title,
            manifest_kind="note",
        )

    def _workspace_note_directory(self, *, create: bool) -> Path:
        assert self._workspace_root is not None
        directory = self._workspace_root / WORKSPACE_NOTE_DIRECTORY
        if directory.exists():
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError(
                    "Workspace business note path must be a real directory"
                )
        elif create:
            directory.mkdir()
        if directory.exists() and not directory.resolve(strict=True).is_relative_to(
            self._workspace_root
        ):
            raise ValueError("Workspace business note path escapes the workspace")
        return directory

    def _write_workspace_manifest(
        self,
        artifact: ArtifactSummary,
        kind: WorkspaceArtifactKind,
    ) -> None:
        assert self._workspace_root is not None
        prudence_directory = self._workspace_root / ".prudence"
        if prudence_directory.exists() and (
            prudence_directory.is_symlink() or not prudence_directory.is_dir()
        ):
            raise ValueError("Workspace .prudence path must be a real directory")
        prudence_directory.mkdir(exist_ok=True)
        self._root.mkdir(exist_ok=True)
        if self._root.is_symlink():
            raise ValueError("Artifact metadata directory must not be a symbolic link")
        if not self._root.resolve(strict=True).is_relative_to(self._workspace_root):
            raise ValueError("Artifact metadata directory escapes the workspace")
        target = self._root / f"{kind}-{artifact.id}.json"
        self._atomic_write(
            target,
            artifact.model_dump_json(indent=2).encode("utf-8"),
        )
        legacy_manifest = self._root / f"{artifact.id}.json"
        if legacy_manifest != target and legacy_manifest.is_file():
            legacy_manifest.unlink()

    def _workspace_manifest(self, artifact_id: str) -> Path:
        validated_id = self._validated_id(artifact_id, "artifact")
        candidates = [
            self._root / f"note-{validated_id}.json",
            self._root / f"file-{validated_id}.json",
            self._root / f"{validated_id}.json",
        ]
        manifest = next((candidate for candidate in candidates if candidate.is_file()), None)
        if manifest is None:
            return self._root / f"file-{validated_id}.json"
        return manifest

    def _workspace_manifest_kind(self, artifact_id: str) -> WorkspaceArtifactKind:
        manifest = self._workspace_manifest(artifact_id)
        return "note" if manifest.name.startswith("note-") else "file"

    def _version_metadata(
        self, artifact: ArtifactSummary, selected_version: int
    ) -> ArtifactVersion:
        metadata = next(
            (item for item in artifact.versions if item.version == selected_version),
            None,
        )
        if metadata is None:
            raise LookupError(f"Artifact version {selected_version} was not found")
        if (
            self._workspace_root is not None
            and selected_version != artifact.current_version
        ):
            raise LookupError("Historical workspace artifact content is not retained")
        return metadata

    def _version_path(
        self,
        session_id: str,
        artifact_id: str,
        artifact: ArtifactSummary,
        version: ArtifactVersion,
    ) -> Path:
        if self._workspace_root is not None:
            return self._workspace_file(version.file_name)
        artifact_directory = self._artifact_directory(session_id, artifact_id)
        target = (artifact_directory / version.file_name).resolve(strict=True)
        if not target.is_relative_to(artifact_directory):
            raise ValueError("Artifact version path escapes its artifact directory")
        return target

    def _workspace_file(self, relative_path: str) -> Path:
        assert self._workspace_root is not None
        normalized = self._normalize_workspace_path(relative_path)
        candidate = self._workspace_root / Path(*PurePosixPath(normalized).parts)
        current = self._workspace_root
        for part in PurePosixPath(normalized).parts:
            current /= part
            if current.is_symlink():
                raise ValueError("Workspace artifact path contains a symbolic link")
        target = candidate.resolve(strict=True)
        if not target.is_relative_to(self._workspace_root) or not target.is_file():
            raise ValueError("Workspace artifact path must identify a contained file")
        if target.stat().st_size > MAX_ARTIFACT_BYTES:
            raise ValueError(f"Artifact content exceeds {MAX_ARTIFACT_BYTES} bytes")
        try:
            target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("Artifacts must be UTF-8 text files") from exc
        return target

    @staticmethod
    def _normalize_workspace_path(relative_path: str) -> str:
        normalized = relative_path.strip().replace("\\", "/")
        candidate = PurePosixPath(normalized)
        if (
            not normalized
            or candidate.is_absolute()
            or not candidate.parts
            or ".." in candidate.parts
            or candidate.parts[0].casefold() == ".prudence"
        ):
            raise ValueError("Artifact path must be relative to the workspace")
        return candidate.as_posix()

    @staticmethod
    def _atomic_write(target: Path, encoded: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=target.parent,
                prefix=".prudence-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(encoded)
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, target)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()

    def _session_directory(self, session_id: str) -> Path:
        return self._root / self._validated_id(session_id, "session")

    def _artifact_directory(self, session_id: str, artifact_id: str) -> Path:
        return self._session_directory(session_id) / self._validated_id(
            artifact_id, "artifact"
        )

    @staticmethod
    def _validated_id(value: str, label: str) -> str:
        try:
            return str(UUID(value))
        except ValueError as exc:
            raise ValueError(f"Invalid {label} id") from exc
