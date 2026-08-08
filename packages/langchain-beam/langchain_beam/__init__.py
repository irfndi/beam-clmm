"""LangChain tool for Beam liquidity agent.

Provides a LangChain BaseTool that wraps the Beam CLI for use in
agent workflows. All commands are thin subprocess wrappers around the
`beam` binary, matching the same patterns as the MCP server.

Usage:
    from langchain_beam import BeamTool

    tool = BeamTool()
    result = tool.run("status")
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

__all__ = ["BeamTool", "BeamExecResult"]

DEFAULT_TIMEOUT_SECONDS = 30
BACKTEST_TIMEOUT_SECONDS = 120
MAX_OUTPUT_BYTES = 10 * 1024 * 1024  # 10 MB


class BeamExecResult:
    """Result of a beam CLI invocation."""

    __slots__ = ("ok", "stdout", "stderr", "exit_code", "timed_out")

    def __init__(
        self,
        ok: bool,
        stdout: str,
        stderr: str,
        exit_code: int,
        timed_out: bool = False,
    ) -> None:
        self.ok = ok
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.timed_out = timed_out

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
        }


def _find_beam_binary() -> str:
    """Locate the beam CLI binary.

    Resolution order (matches MCP server):
    1. BEAM_BIN env var
    2. ~/.local/bin/beam
    3. ~/.bun/bin/beam
    4. beam on PATH
    """
    env_bin = os.environ.get("BEAM_BIN")
    if env_bin:
        return env_bin

    home = Path.home()
    candidates = [
        home / ".local" / "bin" / "beam",
        home / ".bun" / "bin" / "beam",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    # Fall back to PATH lookup
    on_path = shutil.which("beam")
    if on_path:
        return on_path

    raise FileNotFoundError(
        "beam CLI not found. Install Beam first: "
        "curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh | bash"
    )


def run_beam(
    args: list[str],
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> BeamExecResult:
    """Run a beam CLI command as a subprocess.

    Args:
        args: Command arguments (e.g. ["status"], ["backtest", "--days", "7"]).
        timeout_seconds: Maximum seconds to wait before killing the process.

    Returns:
        BeamExecResult with stdout, stderr, exit code, and status flags.
    """
    binary = _find_beam_binary()
    cmd = [binary] + args

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env={**os.environ, "FORCE_COLOR": "0"},
        )
        return BeamExecResult(
            ok=result.returncode == 0,
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.returncode,
            timed_out=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", errors="replace") if exc.stdout else ""
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
        return BeamExecResult(
            ok=False,
            stdout=stdout,
            stderr=stderr,
            exit_code=-1,
            timed_out=True,
        )
    except FileNotFoundError as exc:
        return BeamExecResult(
            ok=False,
            stdout="",
            stderr=f"Beam binary not found: {exc}. Set BEAM_BIN env var or install beam.",
            exit_code=-1,
        )
    except Exception as exc:
        return BeamExecResult(
            ok=False,
            stdout="",
            stderr=f"Unexpected error running beam: {exc}",
            exit_code=-1,
        )


class BeamToolInput(BaseModel):
    """Input for the Beam tool."""

    command: str = Field(
        description=(
            "The beam command to run. One of: "
            "'status', 'positions', 'backtest', 'setup', "
            "'whoami', 'wallet', 'update', 'version'. "
            "For backtest, pass args after a space: 'backtest --days 7'."
        ),
    )


class BeamTool(BaseTool):
    """LangChain tool that wraps the Beam liquidity agent CLI.

    Provides access to Beam commands (status, positions, backtest, setup, etc.)
    via subprocess calls. The tool finds the beam binary using the same
    resolution order as the MCP server.

    Usage:
        tool = BeamTool()
        result = tool.run("status")
        result = tool.run("backtest --days 7 --source replay")
    """

    name: str = "beam"
    description: str = (
        "Run Beam liquidity agent commands. "
        "Commands: 'status' (agent status + positions), "
        "'positions' (active positions), "
        "'backtest [--days N] [--source synthetic|replay]' (run backtest), "
        "'setup [--helius-key KEY] [--non-interactive]' (configure agent), "
        "'whoami' (cloud account info), "
        "'wallet show' (show wallet), "
        "'update' (self-update), "
        "'version' (current version)."
    )
    args_schema: type[BaseModel] = BeamToolInput

    def _run(self, command: str) -> str:
        """Execute a beam CLI command and return its output.

        Args:
            command: The full command string, e.g. "status" or "backtest --days 7".

        Returns:
            Command output as a string, or a JSON error object.
        """
        args = command.strip().split()
        if not args:
            return json.dumps({"error": "No command provided. Use: status, positions, backtest, setup, whoami, wallet, update, version"})

        subcommand = args[0]
        timeout = BACKTEST_TIMEOUT_SECONDS if subcommand == "backtest" else DEFAULT_TIMEOUT_SECONDS

        result = run_beam(args, timeout_seconds=timeout)

        if result.timed_out:
            return json.dumps({
                "error": f"Command 'beam {subcommand}' timed out after {timeout}s",
                "stderr": result.stderr,
            })

        if not result.ok:
            return json.dumps({
                "error": f"Command 'beam {subcommand}' failed (exit {result.exit_code})",
                "stdout": result.stdout,
                "stderr": result.stderr,
            })

        return result.stdout

    async def _arun(self, command: str) -> str:
        """Async variant — delegates to sync _run (subprocess is already non-blocking)."""
        return self._run(command)
