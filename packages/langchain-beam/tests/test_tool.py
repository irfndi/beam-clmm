"""Basic tests for the langchain-beam tool."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from langchain_beam import BeamTool, _find_beam_binary, run_beam


class TestFindBeam:
    """Test the binary resolution logic."""

    def test_finds_beam_on_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """If beam is on PATH, _find_beam returns it."""
        fake_dir = Path(__file__).parent / ".fake-bin"
        fake_dir.mkdir(exist_ok=True)
        fake_beam = fake_dir / "beam"
        fake_beam.write_text("#!/bin/sh\necho beam 0.0.8")
        fake_beam.chmod(0o755)

        monkeypatch.setenv("PATH", str(fake_dir), prepend=os.pathsep)
        result = _find_beam_binary()
        assert result.endswith("beam")

        fake_beam.unlink()
        fake_dir.rmdir()

    def test_raises_when_not_found(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """If beam is not found anywhere, _find_beam_binary raises FileNotFoundError."""
        monkeypatch.setenv("PATH", "/nonexistent")
        monkeypatch.delenv("BEAM_BIN", raising=False)
        monkeypatch.setattr(Path, "home", lambda: Path("/nonexistent-home"))
        with pytest.raises(FileNotFoundError):
            _find_beam_binary()


class TestRunBeam:
    """Test the low-level run_beam helper."""

    def test_returns_json_error_when_not_found(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """run_beam returns a JSON error when the binary is missing."""
        monkeypatch.setenv("BEAM_BIN", "/nonexistent/beam")
        result = run_beam(["--version"])
        assert not result.ok
        assert "not found" in result.stderr.lower() or "does not exist" in result.stderr.lower()


class TestBeamTool:
    """Test the LangChain tool interface."""

    def test_tool_name(self) -> None:
        """The tool has the correct name."""
        tool = BeamTool()
        assert tool.name == "beam"

    def test_tool_description(self) -> None:
        """The tool has a non-empty description."""
        tool = BeamTool()
        assert len(tool.description) > 0
        assert "beam" in tool.description.lower()

    def test_run_returns_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """run() always returns a string even when the binary is missing."""
        monkeypatch.setenv("PATH", "/nonexistent")
        tool = BeamTool()
        result = tool.run("status")
        assert isinstance(result, str)
        # Should be a JSON error object
        parsed = json.loads(result)
        assert "error" in parsed
