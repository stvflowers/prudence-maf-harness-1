import os
import re
from pathlib import Path

from agent_framework import MCPStdioTool
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from maf_harness.schemas import McpServerSummary

MAX_MCP_CONFIG_BYTES = 65_536
MAX_MCP_SERVERS = 5
MCP_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ENVIRONMENT_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class McpServerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=MCP_ID_PATTERN.pattern)
    command: str = Field(min_length=1, max_length=1_024)
    args: list[str] = Field(default_factory=list, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    enabled: bool = False
    allowed_tools: list[str] = Field(min_length=1, max_length=50)
    always_load: list[str] = Field(default_factory=list, max_length=20)
    env_vars: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("command")
    @classmethod
    def normalize_command(cls, value: str) -> str:
        normalized = value.strip()
        if "\x00" in normalized or "\n" in normalized or "\r" in normalized:
            raise ValueError("MCP command contains invalid characters")
        return normalized

    @field_validator("args")
    @classmethod
    def validate_args(cls, values: list[str]) -> list[str]:
        if any(len(value) > 2_048 or "\x00" in value for value in values):
            raise ValueError("MCP arguments cannot exceed 2048 characters")
        return values

    @field_validator("env_vars")
    @classmethod
    def validate_environment_names(cls, values: list[str]) -> list[str]:
        if any(not ENVIRONMENT_NAME_PATTERN.fullmatch(value) for value in values):
            raise ValueError("MCP environment variable names are invalid")
        return values

    @field_validator("allowed_tools", "always_load")
    @classmethod
    def validate_tool_names(cls, values: list[str]) -> list[str]:
        if any(not value or len(value) > 128 for value in values):
            raise ValueError("MCP tool names must contain 1 to 128 characters")
        return values

    @model_validator(mode="after")
    def validate_always_loaded_tools(self) -> McpServerConfig:
        unknown = set(self.always_load).difference(self.allowed_tools)
        if unknown:
            raise ValueError("MCP always_load tools must also appear in allowed_tools")
        return self


class McpConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    servers: list[McpServerConfig]


class McpServerRegistry:
    def __init__(self, data_directory: Path) -> None:
        self._path = data_directory / "mcp.json"

    def discover(self) -> list[McpServerConfig]:
        if not self._path.exists():
            return []
        resolved_path = self._path.resolve(strict=True)
        root = self._path.parent.resolve(strict=True)
        if not resolved_path.is_relative_to(root):
            raise ValueError("MCP configuration escapes the harness data directory")
        if not resolved_path.is_file():
            raise ValueError("MCP configuration is not a file")
        if resolved_path.stat().st_size > MAX_MCP_CONFIG_BYTES:
            raise ValueError(f"MCP configuration exceeds {MAX_MCP_CONFIG_BYTES} bytes")
        configuration = McpConfiguration.model_validate_json(
            resolved_path.read_text(encoding="utf-8")
        )
        if len(configuration.servers) > MAX_MCP_SERVERS:
            raise ValueError(f"MCP configuration exceeds {MAX_MCP_SERVERS} servers")
        identifiers = [server.id for server in configuration.servers]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("MCP server IDs must be unique")
        return sorted(configuration.servers, key=lambda server: server.id)

    def summaries(self, servers: list[McpServerConfig]) -> list[McpServerSummary]:
        return [
            McpServerSummary(
                id=server.id,
                description=server.description,
                enabled=server.enabled,
                transport="stdio",
                allowed_tools=server.allowed_tools,
                progressive_disclosure=True,
                approval_required=True,
                missing_env_vars=[
                    name for name in server.env_vars if os.environ.get(name) is None
                ],
            )
            for server in servers
        ]

    def create_tools(self, servers: list[McpServerConfig]) -> list[MCPStdioTool]:
        tools: list[MCPStdioTool] = []
        for server in servers:
            if not server.enabled:
                continue
            missing = [name for name in server.env_vars if os.environ.get(name) is None]
            if missing:
                joined = ", ".join(missing)
                raise ValueError(
                    f"MCP server {server.id} is missing environment variables: {joined}"
                )
            tools.append(
                MCPStdioTool(
                    name=server.id,
                    command=server.command,
                    args=server.args,
                    description=server.description,
                    tool_name_prefix=server.id,
                    load_prompts=False,
                    request_timeout=30,
                    approval_mode="always_require",
                    allowed_tools=server.allowed_tools,
                    use_progressive_disclosure=True,
                    always_load=server.always_load,
                    env=self._runtime_environment(server),
                )
            )
        return tools

    @staticmethod
    def _runtime_environment(server: McpServerConfig) -> dict[str, str]:
        environment_names = {
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            *server.env_vars,
        }
        return {
            name: value
            for name in environment_names
            if (value := os.environ.get(name)) is not None
        }
