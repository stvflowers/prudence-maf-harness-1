import difflib
import fnmatch
import os
import re
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Literal

from agent_framework import FunctionTool, tool

IGNORED_DIRECTORIES = {
    ".git",
    ".maf-harness",
    ".prudence",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
}
MAX_FILE_BYTES = 1_048_576
MAX_READ_LINES = 400
MAX_SEARCH_FILES = 2_000
MAX_SEARCH_MATCHES = 100
MAX_TOOL_OUTPUT_CHARS = 100_000
MAX_DIFF_PREVIEW_CHARS = 100_000
GIT_TIMEOUT_SECONDS = 10
TEST_TIMEOUT_SECONDS = 120
MAX_TEST_TARGET_CHARS = 300
MAX_COMMIT_MESSAGE_CHARS = 500
TEST_RUNNERS = {
    "pytest": ["pytest"],
    "uv_pytest": ["uv", "run", "pytest"],
    "npm_test": ["npm", "test", "--"],
    "dotnet_test": ["dotnet", "test"],
    "go_test": ["go", "test"],
    "cargo_test": ["cargo", "test"],
}


class WorkspaceReadTools:
    def __init__(
        self,
        root: Path,
        on_file_mutated: Callable[[str], None] | None = None,
    ) -> None:
        self.root = root.resolve(strict=True)
        self._on_file_mutated = on_file_mutated
        if not self.root.is_dir():
            raise ValueError("Workspace root must identify an existing directory")

    @property
    def git_available(self) -> bool:
        return (self.root / ".git").exists()

    @property
    def capability_names(self) -> list[str]:
        capabilities = ["search_workspace", "read_workspace_file"]
        if self.git_available:
            capabilities.extend(["git_status", "git_diff", "git_log"])
        return capabilities

    @property
    def write_capability_names(self) -> list[str]:
        capabilities = [
            "create_workspace_file",
            "replace_workspace_text",
            "run_workspace_tests",
        ]
        if self.git_available:
            capabilities.extend(["create_git_branch", "git_commit"])
        return capabilities

    def create_agent_tools(
        self,
        write_tools_enabled: bool = False,
        auto_approve_enabled: bool = False,
    ) -> list[FunctionTool]:
        workspace = self
        write_approval_mode: Literal["always_require", "never_require"] = (
            "never_require" if auto_approve_enabled else "always_require"
        )

        @tool(name="search_workspace")
        def search_workspace(query: str, path_glob: str = "**/*") -> str:
            """Search UTF-8 workspace files for text without modifying the workspace."""
            return workspace.search(query, path_glob)

        @tool(name="read_workspace_file")
        def read_workspace_file(
            relative_path: str,
            start_line: int = 1,
            end_line: int | None = None,
        ) -> str:
            """Read a bounded line range from one UTF-8 file inside the workspace."""
            return workspace.read_file(relative_path, start_line, end_line)

        tools = [search_workspace, read_workspace_file]
        if self.git_available:

            @tool(name="git_status")
            def git_status() -> str:
                """Inspect the workspace Git branch and working-tree status."""
                return workspace.git_status()

            @tool(name="git_diff")
            def git_diff(relative_path: str | None = None, staged: bool = False) -> str:
                """Inspect an unstaged or staged Git diff, optionally limited to one path."""
                return workspace.git_diff(relative_path, staged)

            @tool(name="git_log")
            def git_log(limit: int = 10) -> str:
                """Inspect recent Git commits without changing the repository."""
                return workspace.git_log(limit)

            tools.extend([git_status, git_diff, git_log])
        if write_tools_enabled:

            @tool(name="create_workspace_file", approval_mode=write_approval_mode)
            def create_workspace_file(relative_path: str, content: str) -> str:
                """Create one new UTF-8 workspace file after explicit user approval."""
                return workspace.create_file(relative_path, content)

            @tool(name="replace_workspace_text", approval_mode=write_approval_mode)
            def replace_workspace_text(
                relative_path: str,
                old_text: str,
                new_text: str,
            ) -> str:
                """Replace one exact text occurrence after explicit user approval."""
                return workspace.replace_text(relative_path, old_text, new_text)

            @tool(name="run_workspace_tests", approval_mode=write_approval_mode)
            def run_workspace_tests(runner: str, target: str | None = None) -> str:
                """Run an allowlisted project test runner after explicit user approval."""
                return workspace.run_tests(runner, target)

            tools.extend([create_workspace_file, replace_workspace_text, run_workspace_tests])
            if self.git_available:

                @tool(name="create_git_branch", approval_mode=write_approval_mode)
                def create_git_branch(branch_name: str) -> str:
                    """Create and switch to a Git branch after explicit user approval."""
                    return workspace.create_git_branch(branch_name)

                @tool(name="git_commit", approval_mode=write_approval_mode)
                def git_commit(message: str) -> str:
                    """Commit already-staged changes after explicit user approval."""
                    return workspace.git_commit(message)

                tools.extend([create_git_branch, git_commit])
        return tools

    def search(self, query: str, path_glob: str = "**/*") -> str:
        normalized_query = query.strip()
        if not normalized_query:
            raise ValueError("Search query must not be empty")
        if len(normalized_query) > 200:
            raise ValueError("Search query must not exceed 200 characters")
        normalized_glob = path_glob.strip().replace("\\", "/") or "**/*"
        matches: list[str] = []
        scanned = 0
        for current_root, directory_names, file_names in os.walk(
            self.root,
            followlinks=False,
        ):
            directory_names[:] = sorted(
                name
                for name in directory_names
                if name not in IGNORED_DIRECTORIES
                and not (Path(current_root) / name).is_symlink()
            )
            for file_name in sorted(file_names):
                if scanned >= MAX_SEARCH_FILES or len(matches) >= MAX_SEARCH_MATCHES:
                    break
                source = Path(current_root) / file_name
                if source.is_symlink():
                    continue
                relative_path = source.relative_to(self.root).as_posix()
                if not self._matches_glob(relative_path, normalized_glob):
                    continue
                scanned += 1
                if source.stat().st_size > MAX_FILE_BYTES:
                    continue
                try:
                    lines = source.read_text(encoding="utf-8").splitlines()
                except UnicodeDecodeError:
                    continue
                folded_query = normalized_query.casefold()
                for line_number, line in enumerate(lines, start=1):
                    if folded_query in line.casefold():
                        matches.append(f"{relative_path}:{line_number}: {line}")
                        if len(matches) >= MAX_SEARCH_MATCHES:
                            break
            if scanned >= MAX_SEARCH_FILES or len(matches) >= MAX_SEARCH_MATCHES:
                break
        if not matches:
            return "No matches found."
        result = "\n".join(matches)
        if len(matches) >= MAX_SEARCH_MATCHES:
            result += f"\n[Results limited to {MAX_SEARCH_MATCHES} matches.]"
        elif scanned >= MAX_SEARCH_FILES:
            result += f"\n[Search limited to {MAX_SEARCH_FILES} files.]"
        return self._truncate(result)

    def read_file(
        self,
        relative_path: str,
        start_line: int = 1,
        end_line: int | None = None,
    ) -> str:
        source = self._resolve_file(relative_path)
        if source.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"File exceeds the {MAX_FILE_BYTES}-byte read limit")
        if start_line < 1:
            raise ValueError("start_line must be at least 1")
        selected_end = end_line if end_line is not None else start_line + MAX_READ_LINES - 1
        if selected_end < start_line:
            raise ValueError("end_line must be greater than or equal to start_line")
        if selected_end - start_line + 1 > MAX_READ_LINES:
            raise ValueError(f"Cannot read more than {MAX_READ_LINES} lines at once")
        try:
            lines = source.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError as exc:
            raise ValueError("Workspace reads require UTF-8 text files") from exc
        selected = lines[start_line - 1 : selected_end]
        body = "\n".join(
            f"{line_number}: {line}"
            for line_number, line in enumerate(selected, start=start_line)
        )
        relative = source.relative_to(self.root).as_posix()
        return self._truncate(f"{relative} (lines {start_line}-{selected_end})\n{body}")

    def git_status(self) -> str:
        return self._run_git(["status", "--short", "--branch"])

    def git_diff(self, relative_path: str | None = None, staged: bool = False) -> str:
        arguments = ["diff", "--no-ext-diff", "--no-color"]
        if staged:
            arguments.append("--cached")
        if relative_path:
            normalized = self._validate_relative_path(relative_path)
            arguments.extend(["--", normalized])
        return self._run_git(arguments)

    def git_log(self, limit: int = 10) -> str:
        if limit < 1 or limit > 20:
            raise ValueError("Git log limit must be between 1 and 20")
        return self._run_git(
            [
                "log",
                f"--max-count={limit}",
                "--date=iso-strict",
                "--pretty=format:%h%x09%ad%x09%an%x09%s",
            ]
        )

    def replace_text(self, relative_path: str, old_text: str, new_text: str) -> str:
        if not old_text:
            raise ValueError("old_text must not be empty")
        source = self._resolve_file(relative_path)
        if source.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"File exceeds the {MAX_FILE_BYTES}-byte write limit")
        try:
            with source.open("r", encoding="utf-8", newline="") as source_file:
                content = source_file.read()
        except UnicodeDecodeError as exc:
            raise ValueError("Workspace writes require UTF-8 text files") from exc
        occurrences = content.count(old_text)
        if occurrences != 1:
            raise ValueError(
                f"old_text must match exactly once; found {occurrences} occurrences"
            )
        updated = content.replace(old_text, new_text, 1)
        if len(updated.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError(f"Updated file exceeds the {MAX_FILE_BYTES}-byte write limit")
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="",
                dir=source.parent,
                prefix=".prudence-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(updated)
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, source)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()
        relative = source.relative_to(self.root).as_posix()
        if self._on_file_mutated is not None:
            self._on_file_mutated(relative)
        return f"Replaced one occurrence in {relative}."

    def create_file(self, relative_path: str, content: str) -> str:
        normalized = self._validate_relative_path(relative_path)
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise ValueError(f"New file exceeds the {MAX_FILE_BYTES}-byte write limit")
        target = self.root / Path(*PurePosixPath(normalized).parts)
        if target.exists() or target.is_symlink():
            raise ValueError("Workspace file already exists; use replace_workspace_text")
        target.parent.mkdir(parents=True, exist_ok=True)
        resolved_parent = target.parent.resolve(strict=True)
        if not resolved_parent.is_relative_to(self.root):
            raise ValueError("Workspace path escapes the bound directory")
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=resolved_parent,
                prefix=".prudence-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(encoded)
                temporary_path = Path(temporary.name)
            try:
                os.link(temporary_path, target)
            except FileExistsError as exc:
                raise ValueError(
                    "Workspace file already exists; use replace_workspace_text"
                ) from exc
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()
        if self._on_file_mutated is not None:
            self._on_file_mutated(normalized)
        return f"Created {normalized}."

    def preview_replace_text(
        self,
        relative_path: str,
        old_text: str,
        new_text: str,
    ) -> tuple[str, bool]:
        if not old_text:
            raise ValueError("old_text must not be empty")
        source = self._resolve_file(relative_path)
        if source.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"File exceeds the {MAX_FILE_BYTES}-byte preview limit")
        try:
            with source.open("r", encoding="utf-8", newline="") as source_file:
                content = source_file.read()
        except UnicodeDecodeError as exc:
            raise ValueError("Workspace previews require UTF-8 text files") from exc
        occurrences = content.count(old_text)
        if occurrences != 1:
            raise ValueError(
                f"old_text must match exactly once; found {occurrences} occurrences"
            )
        updated = content.replace(old_text, new_text, 1)
        relative = source.relative_to(self.root).as_posix()
        diff = "".join(
            difflib.unified_diff(
                content.splitlines(keepends=True),
                updated.splitlines(keepends=True),
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
            )
        )
        truncated = len(diff) > MAX_DIFF_PREVIEW_CHARS
        return diff[:MAX_DIFF_PREVIEW_CHARS], truncated

    def run_tests(self, runner: str, target: str | None = None) -> str:
        command = TEST_RUNNERS.get(runner)
        if command is None:
            allowed = ", ".join(sorted(TEST_RUNNERS))
            raise ValueError(f"Unsupported test runner. Choose one of: {allowed}")
        arguments: list[str] = []
        if runner in {"pytest", "uv_pytest"} and target:
            path_part, separator, selector = target.partition("::")
            normalized = self._resolve_test_target(path_part)
            arguments.append(f"{normalized}{separator}{selector}")
        elif runner == "dotnet_test" and target:
            normalized = self._resolve_test_target(target)
            if Path(normalized).suffix.casefold() not in {".sln", ".csproj"}:
                raise ValueError("dotnet_test target must be a .sln or .csproj file")
            arguments.append(normalized)
        elif runner == "go_test":
            if target not in {None, "./..."}:
                raise ValueError("go_test target must be omitted or ./...")
            arguments.append("./...")
        elif target is not None:
            raise ValueError(f"{runner} does not accept a test target")
        return self._run_process(
            [*command, *arguments],
            timeout=TEST_TIMEOUT_SECONDS,
            operation="Test command",
        )

    def create_git_branch(self, branch_name: str) -> str:
        normalized = branch_name.strip()
        if (
            not normalized
            or len(normalized) > 200
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", normalized)
        ):
            raise ValueError("Branch name contains unsupported characters")
        self._run_git(["check-ref-format", "--branch", normalized])
        return self._run_git(["switch", "-c", normalized])

    def git_commit(self, message: str) -> str:
        normalized = message.strip()
        if not normalized or len(normalized) > MAX_COMMIT_MESSAGE_CHARS:
            raise ValueError(
                f"Commit message must contain 1-{MAX_COMMIT_MESSAGE_CHARS} characters"
            )
        return self._run_git(["commit", "-m", normalized], timeout=TEST_TIMEOUT_SECONDS)

    def _resolve_file(self, relative_path: str) -> Path:
        normalized = self._validate_relative_path(relative_path)
        source = (self.root / normalized).resolve(strict=True)
        if not source.is_relative_to(self.root):
            raise ValueError("Workspace path escapes the bound directory")
        if not source.is_file():
            raise ValueError("Workspace path must identify a file")
        return source

    def _resolve_test_target(self, relative_path: str) -> str:
        if not relative_path or len(relative_path) > MAX_TEST_TARGET_CHARS:
            raise ValueError(
                f"Test target must contain 1-{MAX_TEST_TARGET_CHARS} characters"
            )
        normalized = self._validate_relative_path(relative_path)
        target = (self.root / normalized).resolve(strict=True)
        if not target.is_relative_to(self.root):
            raise ValueError("Test target escapes the bound directory")
        return normalized

    def _validate_relative_path(self, relative_path: str) -> str:
        normalized = relative_path.strip().replace("\\", "/")
        candidate = PurePosixPath(normalized)
        if not normalized or candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError("Workspace path must be a relative path inside the bound directory")
        resolved = (self.root / Path(*candidate.parts)).resolve(strict=False)
        if not resolved.is_relative_to(self.root):
            raise ValueError("Workspace path escapes the bound directory")
        return candidate.as_posix()

    def _run_git(
        self,
        arguments: list[str],
        timeout: int = GIT_TIMEOUT_SECONDS,
    ) -> str:
        if not self.git_available:
            raise ValueError("The bound workspace is not a Git repository")
        return self._run_process(
            ["git", "--no-pager", *arguments],
            timeout=timeout,
            operation="Git command",
        )

    def _run_process(self, command: list[str], timeout: int, operation: str) -> str:
        try:
            completed = subprocess.run(
                command,
                cwd=self.root,
                capture_output=True,
                check=False,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"{command[0]} is not installed or is not available on PATH"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(f"{operation} exceeded {timeout} seconds") from exc
        output = "\n".join(
            part for part in (completed.stdout.strip(), completed.stderr.strip()) if part
        )
        if completed.returncode != 0:
            raise RuntimeError(f"{operation} failed: {output or 'No diagnostic output.'}")
        return self._truncate(output or "No output.")

    @staticmethod
    def _matches_glob(relative_path: str, pattern: str) -> bool:
        if fnmatch.fnmatchcase(relative_path, pattern):
            return True
        return pattern.startswith("**/") and fnmatch.fnmatchcase(relative_path, pattern[3:])

    @staticmethod
    def _truncate(value: str) -> str:
        if len(value) <= MAX_TOOL_OUTPUT_CHARS:
            return value
        return value[:MAX_TOOL_OUTPUT_CHARS] + "\n[Output truncated.]"
