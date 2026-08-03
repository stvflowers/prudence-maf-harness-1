from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    delete,
    func,
    inspect,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
    sessionmaker,
)

from maf_harness.schemas import (
    ApprovalPreview,
    ApprovalRecord,
    ApprovalStatus,
    EventRecord,
    ProviderProbeRecord,
    ProviderProfile,
    ProviderProfileCreate,
    ProviderProfileUpdate,
    SessionArchiveEvent,
    SessionCreate,
    SessionDetail,
    SessionSummary,
    new_id,
    utc_now,
)


class Base(DeclarativeBase):
    pass


class ProviderProfileRow(Base):
    __tablename__ = "provider_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(20))
    endpoint: Mapped[str] = mapped_column(String(2_048))
    model: Mapped[str] = mapped_column(String(200))
    api_key_env: Mapped[str | None] = mapped_column(String(100), nullable=True)
    max_context_window_tokens: Mapped[int] = mapped_column(Integer)
    max_output_tokens: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProviderProbeRow(Base):
    __tablename__ = "provider_probes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider_id: Mapped[str] = mapped_column(ForeignKey("provider_profiles.id"))
    ok: Mapped[bool] = mapped_column(Boolean)
    message: Mapped[str] = mapped_column(String(2_000))
    tool_calling: Mapped[bool] = mapped_column(Boolean)
    streaming: Mapped[bool] = mapped_column(Boolean)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class HarnessSessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    provider_id: Mapped[str] = mapped_column(ForeignKey("provider_profiles.id"))
    craft_provider_id: Mapped[str | None] = mapped_column(
        ForeignKey("provider_profiles.id"),
        nullable=True,
    )
    title: Mapped[str] = mapped_column(String(120))
    maf_state: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    events: Mapped[list[EventRow]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="EventRow.sequence",
    )


class EventRow(Base):
    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("session_id", "sequence"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    sequence: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(50))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    session: Mapped[HarnessSessionRow] = relationship(back_populates="events")


class ApprovalRow(Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    tool_name: Mapped[str] = mapped_column(String(200))
    arguments: Mapped[dict[str, Any]] = mapped_column(JSON)
    request: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ApprovalPreviewRow(Base):
    __tablename__ = "approval_previews"

    approval_id: Mapped[str] = mapped_column(ForeignKey("approvals.id"), primary_key=True)
    preview_data: Mapped[dict[str, Any]] = mapped_column(JSON)


class WorkspaceBindingRow(Base):
    __tablename__ = "workspace_bindings"

    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), primary_key=True)
    root_path: Mapped[str] = mapped_column(String(2_048))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkspaceCapabilityRow(Base):
    __tablename__ = "workspace_capabilities"

    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), primary_key=True)
    write_tools_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_approve_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SessionInstructionRow(Base):
    __tablename__ = "session_instructions"

    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), primary_key=True)
    content: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Database:
    def __init__(self, url: str) -> None:
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        self.engine = create_engine(url, connect_args=connect_args)
        self.session_factory = sessionmaker(self.engine, expire_on_commit=False)

    def initialize(self) -> None:
        Base.metadata.create_all(self.engine)
        session_columns = {
            column["name"] for column in inspect(self.engine).get_columns("sessions")
        }
        if "craft_provider_id" not in session_columns:
            with self.engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE sessions ADD COLUMN craft_provider_id VARCHAR(36)")
                )
        workspace_capability_columns = {
            column["name"]
            for column in inspect(self.engine).get_columns("workspace_capabilities")
        }
        if "auto_approve_enabled" not in workspace_capability_columns:
            with self.engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE workspace_capabilities "
                        "ADD COLUMN auto_approve_enabled BOOLEAN NOT NULL DEFAULT 0"
                    )
                )
        with self.engine.begin() as connection:
            connection.execute(
                update(ProviderProbeRow)
                .where(ProviderProbeRow.ok.is_(True))
                .values(message="Connected successfully.")
            )

class Repository:
    def __init__(self, database: Database) -> None:
        self._database = database

    def create_provider(self, profile: ProviderProfileCreate) -> ProviderProfile:
        row = ProviderProfileRow(
            id=new_id(),
            created_at=utc_now(),
            **profile.model_dump(mode="json"),
        )
        with self._database.session_factory() as db:
            db.add(row)
            db.commit()
            return ProviderProfile.model_validate(row)

    def list_providers(self) -> list[ProviderProfile]:
        with self._database.session_factory() as db:
            rows = db.scalars(
                select(ProviderProfileRow).order_by(ProviderProfileRow.created_at)
            ).all()
            return [ProviderProfile.model_validate(row) for row in rows]

    def get_provider(self, provider_id: str) -> ProviderProfile | None:
        with self._database.session_factory() as db:
            row = db.get(ProviderProfileRow, provider_id)
            return ProviderProfile.model_validate(row) if row else None

    def update_provider(
        self,
        provider_id: str,
        profile: ProviderProfileUpdate,
    ) -> ProviderProfile:
        with self._database.session_factory() as db:
            row = db.get(ProviderProfileRow, provider_id)
            if row is None:
                raise LookupError(f"Provider {provider_id} was not found")
            for field, value in profile.model_dump(mode="json").items():
                setattr(row, field, value)
            db.commit()
            return ProviderProfile.model_validate(row)

    def delete_provider(self, provider_id: str) -> None:
        with self._database.session_factory() as db:
            row = db.get(ProviderProfileRow, provider_id)
            if row is None:
                raise LookupError(f"Provider {provider_id} was not found")
            session_count = db.scalar(
                select(func.count())
                .select_from(HarnessSessionRow)
                .where(
                    or_(
                        HarnessSessionRow.provider_id == provider_id,
                        HarnessSessionRow.craft_provider_id == provider_id,
                    )
                )
            )
            if session_count:
                raise ValueError(
                    "Provider cannot be deleted while sessions still reference it"
                )
            db.execute(
                delete(ProviderProbeRow).where(
                    ProviderProbeRow.provider_id == provider_id
                )
            )
            db.delete(row)
            db.commit()

    def import_providers(
        self,
        profiles: list[ProviderProfileCreate],
    ) -> list[ProviderProfile]:
        rows = [
            ProviderProfileRow(
                id=new_id(),
                created_at=utc_now(),
                **profile.model_dump(mode="json"),
            )
            for profile in profiles
        ]
        with self._database.session_factory() as db:
            db.add_all(rows)
            db.commit()
            return [ProviderProfile.model_validate(row) for row in rows]

    def record_provider_probe(
        self,
        provider_id: str,
        *,
        ok: bool,
        message: str,
        tool_calling: bool,
        streaming: bool,
    ) -> ProviderProbeRecord:
        row = ProviderProbeRow(
            provider_id=provider_id,
            ok=ok,
            message="Connected successfully." if ok else message[:2_000],
            tool_calling=tool_calling,
            streaming=streaming,
            checked_at=utc_now(),
        )
        with self._database.session_factory() as db:
            if db.get(ProviderProfileRow, provider_id) is None:
                raise LookupError(f"Provider {provider_id} was not found")
            db.add(row)
            db.commit()
            return ProviderProbeRecord.model_validate(row)

    def list_provider_probes(
        self,
        provider_id: str,
        limit: int = 10,
    ) -> list[ProviderProbeRecord]:
        if limit < 1 or limit > 50:
            raise ValueError("Probe history limit must be between 1 and 50")
        with self._database.session_factory() as db:
            if db.get(ProviderProfileRow, provider_id) is None:
                raise LookupError(f"Provider {provider_id} was not found")
            rows = db.scalars(
                select(ProviderProbeRow)
                .where(ProviderProbeRow.provider_id == provider_id)
                .order_by(ProviderProbeRow.checked_at.desc(), ProviderProbeRow.id.desc())
                .limit(limit)
            ).all()
            return [ProviderProbeRecord.model_validate(row) for row in rows]

    def create_session(self, session: SessionCreate) -> SessionSummary:
        now = utc_now()
        row = HarnessSessionRow(
            id=new_id(),
            provider_id=session.provider_id,
            craft_provider_id=session.craft_provider_id,
            title=session.title,
            maf_state=None,
            created_at=now,
            updated_at=now,
        )
        with self._database.session_factory() as db:
            db.add(row)
            db.commit()
            return SessionSummary.model_validate(row)

    def import_session(
        self,
        provider_id: str,
        title: str,
        events: list[SessionArchiveEvent],
    ) -> SessionSummary:
        now = utc_now()
        row = HarnessSessionRow(
            id=new_id(),
            provider_id=provider_id,
            craft_provider_id=None,
            title=f"{title[:109]} (imported)",
            maf_state=None,
            created_at=now,
            updated_at=now,
        )
        event_rows = [
            EventRow(
                session_id=row.id,
                sequence=index,
                type=event.type,
                payload=event.payload,
                created_at=event.created_at,
            )
            for index, event in enumerate(events, start=1)
        ]
        event_rows.append(
            EventRow(
                session_id=row.id,
                sequence=len(event_rows) + 1,
                type="session_imported",
                payload={
                    "source_title": title,
                    "restored_event_count": len(events),
                    "continuation_state_restored": False,
                },
                created_at=now,
            )
        )
        with self._database.session_factory() as db:
            if db.get(ProviderProfileRow, provider_id) is None:
                raise LookupError(f"Provider {provider_id} was not found")
            db.add(row)
            db.add_all(event_rows)
            db.commit()
            return SessionSummary.model_validate(row)

    def list_sessions(self) -> list[SessionSummary]:
        with self._database.session_factory() as db:
            rows = db.scalars(
                select(HarnessSessionRow).order_by(HarnessSessionRow.updated_at.desc())
            ).all()
            return [SessionSummary.model_validate(row) for row in rows]

    def delete_session(self, session_id: str) -> None:
        with self._database.session_factory() as db:
            row = db.get(HarnessSessionRow, session_id)
            if row is None:
                raise LookupError(f"Session {session_id} was not found")
            approval_ids = select(ApprovalRow.id).where(
                ApprovalRow.session_id == session_id
            )
            db.execute(
                delete(ApprovalPreviewRow).where(
                    ApprovalPreviewRow.approval_id.in_(approval_ids)
                )
            )
            db.execute(delete(ApprovalRow).where(ApprovalRow.session_id == session_id))
            db.execute(
                delete(WorkspaceCapabilityRow).where(
                    WorkspaceCapabilityRow.session_id == session_id
                )
            )
            db.execute(
                delete(WorkspaceBindingRow).where(
                    WorkspaceBindingRow.session_id == session_id
                )
            )
            db.execute(
                delete(SessionInstructionRow).where(
                    SessionInstructionRow.session_id == session_id
                )
            )
            db.execute(delete(EventRow).where(EventRow.session_id == session_id))
            db.delete(row)
            db.commit()

    def get_session(self, session_id: str) -> SessionDetail | None:
        with self._database.session_factory() as db:
            row = db.get(HarnessSessionRow, session_id)
            if row is None:
                return None
            events = [
                EventRecord(
                    id=event.id,
                    session_id=event.session_id,
                    sequence=event.sequence,
                    type=event.type,
                    payload=event.payload,
                    created_at=event.created_at,
                )
                for event in row.events
            ]
            return SessionDetail(
                id=row.id,
                provider_id=row.provider_id,
                craft_provider_id=row.craft_provider_id,
                title=row.title,
                created_at=row.created_at,
                updated_at=row.updated_at,
                events=events,
            )

    def update_session_title(self, session_id: str, title: str) -> SessionSummary:
        with self._database.session_factory() as db:
            row = db.get(HarnessSessionRow, session_id)
            if row is None:
                raise LookupError(f"Session {session_id} was not found")
            row.title = title
            row.updated_at = utc_now()
            db.commit()
            db.refresh(row)
            return SessionSummary.model_validate(row)

    def update_session_craft_provider(
        self,
        session_id: str,
        craft_provider_id: str,
    ) -> SessionSummary:
        with self._database.session_factory() as db:
            row = db.get(HarnessSessionRow, session_id)
            if row is None:
                raise LookupError(f"Session {session_id} was not found")
            if db.get(ProviderProfileRow, craft_provider_id) is None:
                raise LookupError(f"Provider {craft_provider_id} was not found")
            row.craft_provider_id = craft_provider_id
            row.updated_at = utc_now()
            db.commit()
            db.refresh(row)
            return SessionSummary.model_validate(row)

    def get_session_state(self, session_id: str) -> dict[str, Any] | None:
        with self._database.session_factory() as db:
            row = db.get(HarnessSessionRow, session_id)
            return row.maf_state if row else None

    def save_session_state(self, session_id: str, state: dict[str, Any]) -> None:
        with self._database.session_factory() as db:
            row = db.get(HarnessSessionRow, session_id)
            if row is None:
                raise LookupError(f"Session {session_id} was not found")
            row.maf_state = state
            row.updated_at = utc_now()
            db.commit()

    def set_workspace(self, session_id: str, root_path: str) -> str:
        with self._database.session_factory() as db:
            if db.get(HarnessSessionRow, session_id) is None:
                raise LookupError(f"Session {session_id} was not found")
            row = db.get(WorkspaceBindingRow, session_id)
            if row is None:
                row = WorkspaceBindingRow(
                    session_id=session_id,
                    root_path=root_path,
                    updated_at=utc_now(),
                )
                db.add(row)
            else:
                root_changed = row.root_path != root_path
                row.root_path = root_path
                row.updated_at = utc_now()
                if root_changed:
                    capability = db.get(WorkspaceCapabilityRow, session_id)
                    if capability is not None:
                        capability.write_tools_enabled = False
                        capability.auto_approve_enabled = False
                        capability.updated_at = utc_now()
            db.commit()
            return row.root_path

    def get_workspace(self, session_id: str) -> str | None:
        with self._database.session_factory() as db:
            row = db.get(WorkspaceBindingRow, session_id)
            return row.root_path if row else None

    def set_workspace_write_tools(self, session_id: str, enabled: bool) -> bool:
        with self._database.session_factory() as db:
            if db.get(WorkspaceBindingRow, session_id) is None:
                raise LookupError(f"Session {session_id} has no workspace")
            row = db.get(WorkspaceCapabilityRow, session_id)
            if row is None:
                row = WorkspaceCapabilityRow(
                    session_id=session_id,
                    write_tools_enabled=enabled,
                    auto_approve_enabled=False,
                    updated_at=utc_now(),
                )
                db.add(row)
            else:
                row.write_tools_enabled = enabled
                row.updated_at = utc_now()
            db.commit()
            return row.write_tools_enabled

    def workspace_write_tools_enabled(self, session_id: str) -> bool:
        with self._database.session_factory() as db:
            row = db.get(WorkspaceCapabilityRow, session_id)
            return row.write_tools_enabled if row else False

    def set_workspace_auto_approve(self, session_id: str, enabled: bool) -> bool:
        with self._database.session_factory() as db:
            if db.get(WorkspaceBindingRow, session_id) is None:
                raise LookupError(f"Session {session_id} has no workspace")
            row = db.get(WorkspaceCapabilityRow, session_id)
            if row is None:
                row = WorkspaceCapabilityRow(
                    session_id=session_id,
                    write_tools_enabled=False,
                    auto_approve_enabled=enabled,
                    updated_at=utc_now(),
                )
                db.add(row)
            else:
                row.auto_approve_enabled = enabled
                row.updated_at = utc_now()
            db.commit()
            return row.auto_approve_enabled

    def workspace_auto_approve_enabled(self, session_id: str) -> bool:
        with self._database.session_factory() as db:
            row = db.get(WorkspaceCapabilityRow, session_id)
            return row.auto_approve_enabled if row else False

    def get_session_instructions(self, session_id: str) -> str | None:
        with self._database.session_factory() as db:
            row = db.get(SessionInstructionRow, session_id)
            return row.content if row else None

    def set_session_instructions(self, session_id: str, content: str) -> str:
        with self._database.session_factory() as db:
            if db.get(HarnessSessionRow, session_id) is None:
                raise LookupError(f"Session {session_id} was not found")
            row = db.get(SessionInstructionRow, session_id)
            if row is None:
                row = SessionInstructionRow(
                    session_id=session_id,
                    content=content,
                    updated_at=utc_now(),
                )
                db.add(row)
            else:
                row.content = content
                row.updated_at = utc_now()
            db.commit()
            return row.content

    def clear_session_instructions(self, session_id: str) -> bool:
        with self._database.session_factory() as db:
            if db.get(HarnessSessionRow, session_id) is None:
                raise LookupError(f"Session {session_id} was not found")
            row = db.get(SessionInstructionRow, session_id)
            if row is None:
                return False
            db.delete(row)
            db.commit()
            return True

    def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> EventRecord:
        with self._database.session_factory() as db:
            harness_session = db.get(HarnessSessionRow, session_id)
            if harness_session is None:
                raise LookupError(f"Session {session_id} was not found")
            last_sequence = db.scalar(
                select(func.max(EventRow.sequence)).where(EventRow.session_id == session_id)
            )
            row = EventRow(
                session_id=session_id,
                sequence=(last_sequence or 0) + 1,
                type=event_type,
                payload=payload,
                created_at=utc_now(),
            )
            harness_session.updated_at = row.created_at
            db.add(row)
            db.commit()
            return EventRecord.model_validate(row)

    def create_approval(
        self,
        session_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        request: dict[str, Any],
        preview: ApprovalPreview,
    ) -> ApprovalRecord:
        row = ApprovalRow(
            id=new_id(),
            session_id=session_id,
            tool_name=tool_name,
            arguments=arguments,
            request=request,
            status=ApprovalStatus.PENDING,
            created_at=utc_now(),
            decided_at=None,
        )
        preview_row = ApprovalPreviewRow(
            approval_id=row.id,
            preview_data=preview.model_dump(mode="json"),
        )
        with self._database.session_factory() as db:
            db.add_all([row, preview_row])
            db.commit()
            return self._approval_record(row, preview)

    def list_approvals(self, session_id: str) -> list[ApprovalRecord]:
        with self._database.session_factory() as db:
            rows = db.scalars(
                select(ApprovalRow)
                .where(ApprovalRow.session_id == session_id)
                .order_by(ApprovalRow.created_at)
            ).all()
            previews = {
                preview.approval_id: ApprovalPreview.model_validate(preview.preview_data)
                for preview in db.scalars(
                    select(ApprovalPreviewRow).where(
                        ApprovalPreviewRow.approval_id.in_([row.id for row in rows])
                    )
                ).all()
            }
            return [
                self._approval_record(row, previews.get(row.id))
                for row in rows
            ]

    def get_approval(self, approval_id: str) -> ApprovalRecord | None:
        with self._database.session_factory() as db:
            row = db.get(ApprovalRow, approval_id)
            if row is None:
                return None
            preview_row = db.get(ApprovalPreviewRow, approval_id)
            preview = (
                ApprovalPreview.model_validate(preview_row.preview_data)
                if preview_row is not None
                else None
            )
            return self._approval_record(row, preview)

    def decide_approval(self, approval_id: str, approved: bool) -> ApprovalRecord:
        with self._database.session_factory() as db:
            row = db.get(ApprovalRow, approval_id)
            if row is None:
                raise LookupError(f"Approval {approval_id} was not found")
            if row.status != ApprovalStatus.PENDING:
                raise ValueError("Approval has already been decided")
            row.status = ApprovalStatus.APPROVED if approved else ApprovalStatus.DENIED
            row.decided_at = utc_now()
            db.commit()
            preview_row = db.get(ApprovalPreviewRow, approval_id)
            preview = (
                ApprovalPreview.model_validate(preview_row.preview_data)
                if preview_row is not None
                else None
            )
            return self._approval_record(row, preview)

    @staticmethod
    def _approval_record(
        row: ApprovalRow,
        preview: ApprovalPreview | None,
    ) -> ApprovalRecord:
        resolved_preview = preview or ApprovalPreview(
            operation=row.tool_name.replace("_", " "),
            category="tool_invocation",
            risk_level="unknown",
            preview_kind="unavailable",
            preview_content="Preview metadata is unavailable for this legacy approval.",
        )
        return ApprovalRecord(
            id=row.id,
            session_id=row.session_id,
            tool_name=row.tool_name,
            arguments=row.arguments,
            request=row.request,
            preview=resolved_preview,
            status=ApprovalStatus(row.status),
            created_at=row.created_at,
            decided_at=row.decided_at,
        )
