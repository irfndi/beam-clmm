"""Basic tests for the autogpt-beam plugin."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from autogpt_beam import _find_beam, _beam_status


class TestFindBeam:
    """Test the binary resolution logic."""

    def test_finds_beam_on_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """If beam is on PATH, _find_beam returns it."""
        fake_path = shutil.which("python") or "/usr/bin/python"
        # Create a fake beam binary in a temp dir on PATH
        fake_dir = Path(__file__).parent / ".fake-bin"
        fake_dir.mkdir(exist_ok=True)
        fake_beam = fake_dir / "beam"
        fake_beam.write_text("#!/bin/sh\necho beam 0.0.8")
        fake_beam.chmod(0o755)

        monkeypatch.setenv("PATH", str(fake_dir), prepend=os.pathsep)
        result = _find_beam()
        assert result.endswith("beam")

        fake_beam.unlink()
        fake_dir.rmdir()

    def test_raises_when_not_found(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """If beam is not on PATH, _find_beam raises FileNotFoundError."""
        monkeypatch.setenv("PATH", "/nonexistent")
        with pytest.raises(FileNotFoundError):
            _find_beam()


class TestBeamStatus:
    """Test the status command (safe, read-only)."""

    def test_returns_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """_beam_status always returns a string."""
        # Force FileNotFoundError path
        monkeypatch.setenv("PATH", "/nonexistent")
        result = _beam_status()
        assert isinstance(result, str)
        assert "not found" in result.lower() or "install" in result.lower()


class TestPluginClass:
    """Test that the plugin class can be imported and instantiated."""

    def test_import_and_init(self) -> None:
        """AutoGPTBeam can be imported and instantiated."""
        from autogpt_beam import AutoGPTBeam

        plugin = AutoGPTBeam()
        assert plugin._name == "AutoGPT-Beam-Plugin"
        assert plugin._version == "0.1.0"

    def test_can_handle_post_prompt(self) -> None:
        """The plugin claims it can handle post_prompt."""
        from autogpt_beam import AutoGPTBeam

        plugin = AutoGPTBeam()
        assert plugin.can_handle_post_prompt() is True
