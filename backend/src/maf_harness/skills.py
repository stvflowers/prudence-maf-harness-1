import re
from dataclasses import dataclass
from pathlib import Path

from agent_framework import tool

from maf_harness.schemas import SkillSummary

MAX_SKILL_BYTES = 65_536
MAX_SKILLS = 50
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


@dataclass(frozen=True)
class SkillDefinition:
    summary: SkillSummary
    path: Path


class SkillRegistry:
    def __init__(self, user_root: Path, workspace_root: Path | None = None) -> None:
        self._sources = [(user_root, "user", 10, "skills")]
        if workspace_root is not None:
            prudence_root = workspace_root / ".prudence" / "skills"
            legacy_root = workspace_root / ".maf-harness" / "skills"
            self._sources.extend(
                [
                    (legacy_root, "project", 19, ".maf-harness/skills"),
                    (prudence_root, "project", 20, ".prudence/skills"),
                ]
            )

    def discover(self) -> list[SkillDefinition]:
        effective: dict[str, SkillDefinition] = {}
        for root, source, precedence, display_root in self._sources:
            for definition in self._discover_root(root, source, precedence, display_root):
                existing = effective.get(definition.summary.name)
                if existing is None or definition.summary.precedence >= existing.summary.precedence:
                    effective[definition.summary.name] = definition
        return sorted(effective.values(), key=lambda item: item.summary.name)

    def catalog_instructions(self, definitions: list[SkillDefinition]) -> str | None:
        if not definitions:
            return None
        entries = "\n".join(
            (
                f"- {definition.summary.name}: {definition.summary.description} "
                f"[source={definition.summary.source}, "
                f"precedence={definition.summary.precedence}]"
            )
            for definition in definitions
        )
        return (
            "Reusable skills are available below. Load a skill only when its description "
            "matches the current request. Call load_skill(name) before following that skill. "
            "Project skills override user skills with the same name.\n"
            f"{entries}"
        )

    def load(self, name: str, definitions: list[SkillDefinition]) -> str:
        if not SKILL_NAME_PATTERN.fullmatch(name):
            raise ValueError("Skill name must use lowercase letters, numbers, and hyphens")
        definition = next(
            (candidate for candidate in definitions if candidate.summary.name == name),
            None,
        )
        if definition is None:
            raise ValueError(f"Skill is not available: {name}")
        return definition.path.read_text(encoding="utf-8")

    def create_agent_tool(self, definitions: list[SkillDefinition]) -> object:
        registry = self

        @tool(name="load_skill")
        def load_skill(name: str) -> str:
            """Load the full instructions for one available reusable skill by exact name."""
            return registry.load(name, definitions)

        return load_skill

    def _discover_root(
        self,
        root: Path,
        source: str,
        precedence: int,
        display_root: str,
    ) -> list[SkillDefinition]:
        if not root.exists():
            return []
        resolved_root = root.resolve(strict=True)
        if not resolved_root.is_dir():
            raise ValueError(f"Skill root is not a directory: {root}")

        definitions: list[SkillDefinition] = []
        for skill_directory in sorted(resolved_root.iterdir(), key=lambda path: path.name):
            if (
                not skill_directory.is_dir()
                or not SKILL_NAME_PATTERN.fullmatch(skill_directory.name)
            ):
                continue
            skill_file = skill_directory / "SKILL.md"
            if not skill_file.is_file():
                continue
            resolved_file = skill_file.resolve(strict=True)
            if not resolved_file.is_relative_to(resolved_root):
                raise ValueError(f"Skill file escapes its configured root: {skill_directory.name}")
            size = resolved_file.stat().st_size
            if size > MAX_SKILL_BYTES:
                raise ValueError(
                    f"Skill file exceeds {MAX_SKILL_BYTES} bytes: {skill_directory.name}"
                )
            content = resolved_file.read_text(encoding="utf-8")
            metadata = _parse_front_matter(content)
            name = metadata.get("name", skill_directory.name)
            description = metadata.get("description", "").strip()
            if name != skill_directory.name:
                raise ValueError(
                    f"Skill name must match its directory: {skill_directory.name}"
                )
            if not description:
                raise ValueError(f"Skill description is required: {skill_directory.name}")
            definitions.append(
                SkillDefinition(
                    summary=SkillSummary(
                        name=name,
                        description=description,
                        source=source,
                        precedence=precedence,
                        relative_path=f"{display_root}/{skill_directory.name}/SKILL.md",
                        size_bytes=size,
                    ),
                    path=resolved_file,
                )
            )
            if len(definitions) >= MAX_SKILLS:
                break
        return definitions


def _parse_front_matter(content: str) -> dict[str, str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    try:
        closing_index = next(
            index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"
        )
    except StopIteration:
        raise ValueError("Skill front matter is not closed") from None

    metadata: dict[str, str] = {}
    index = 1
    while index < closing_index:
        line = lines[index]
        if ":" not in line:
            index += 1
            continue
        key, raw_value = line.split(":", 1)
        key = key.strip()
        value = raw_value.strip()
        if key not in {"name", "description"}:
            index += 1
            continue
        if value in {">", "|"}:
            continuation: list[str] = []
            index += 1
            while index < closing_index and (
                not lines[index].strip() or lines[index].startswith((" ", "\t"))
            ):
                if lines[index].strip():
                    continuation.append(lines[index].strip())
                index += 1
            metadata[key] = " ".join(continuation)
            continue
        metadata[key] = value.strip("\"'")
        index += 1
    return metadata
