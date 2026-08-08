"""AutoGPT plugin for Beam — autonomous Solana liquidity agent."""
from __future__ import annotations

import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple, TypeVar, TypedDict

from auto_gpt_plugin_template import AutoGPTPluginTemplate

PromptGenerator = TypeVar("PromptGenerator")


class Message(TypedDict):
    role: str
    content: str


_INSTALL_URL = (
    "https://raw.githubusercontent.com/irfndi/beam-clmm"
    "/main/scripts/install.sh"
)


def _find_beam() -> str:
    """Locate the ``beam`` binary on PATH."""
    path = shutil.which("beam")
    if path is not None:
        return path
    raise FileNotFoundError(
        "beam CLI not found on PATH. Run the beam_install command first, "
        "or install Beam manually: "
        f"curl -fsSL {_INSTALL_URL} | bash"
    )


def _run_beam(*args: str, timeout: int = 120) -> str:
    """Run a beam CLI command and return combined stdout+stderr."""
    beam = _find_beam()
    cmd = [beam, *args]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            return f"Exit code {result.returncode}\n{output}" if output else (
                f"Exit code {result.returncode} (no output)"
            )
        return output or "(no output)"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s: beam {' '.join(args)}"
    except FileNotFoundError as exc:
        return str(exc)
    except OSError as exc:
        return f"Failed to execute beam: {exc}"


# ---------------------------------------------------------------------------
# Command callbacks
# ---------------------------------------------------------------------------

def _beam_install(**_kwargs: Any) -> str:
    """Run the Beam one-liner install script."""
    try:
        result = subprocess.run(
            ["bash", "-c", f"curl -fsSL {_INSTALL_URL} | bash"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        output = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            return (
                f"Install failed (exit {result.returncode})\n{output}"
                if output
                else f"Install failed (exit {result.returncode})"
            )
        return (
            f"Beam installed successfully.\n{output}\n\n"
            "Run 'beam --help' to verify, then use beam_setup to configure."
        )
    except subprocess.TimeoutExpired:
        return "Install timed out after 180s. Check your network connection."
    except OSError as exc:
        return f"Failed to run installer: {exc}"


def _beam_setup(helius_key: str = "", **_kwargs: Any) -> str:
    """Run ``beam setup`` with the provided Helius API key."""
    if not helius_key or not helius_key.strip():
        return (
            "Error: helius_key is required. "
            "Get a free key at https://helius.dev"
        )
    return _run_beam(
        "setup", "--non-interactive", "--helius-key", helius_key.strip()
    )


def _beam_start(**_kwargs: Any) -> str:
    """Start Beam in paper-trading mode (``beam dev``) as a background process."""
    try:
        beam = _find_beam()
        # Start in background so AutoGPT doesn't block forever
        proc = subprocess.Popen(
            [beam, "dev"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return (
            f"Beam agent started in background (PID {proc.pid}). "
            "Use beam_status to verify it's running."
        )
    except FileNotFoundError as exc:
        return str(exc)
    except OSError as exc:
        return f"Failed to start agent: {exc}"


def _beam_status(**_kwargs: Any) -> str:
    """Get current Beam status."""
    try:
        beam = _find_beam()
        result = subprocess.run(
            [beam, "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return (result.stdout + result.stderr).strip() or "beam is installed"
    except FileNotFoundError as exc:
        return str(exc)
    except subprocess.TimeoutExpired:
        return "Status check timed out"
    except OSError as exc:
        return f"Failed to check status: {exc}"


def _beam_stop(**_kwargs: Any) -> str:
    """Stop the running Beam agent (best-effort)."""
    try:
        # beam doesn't have a dedicated stop command; kill the background process
        result = subprocess.run(
            ["pkill", "-f", "bun.*engine/index.ts"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return "Beam agent stopped."
        # Also try killing by the beam wrapper name
        result2 = subprocess.run(
            ["pkill", "-f", "beam dev"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result2.returncode == 0:
            return "Beam agent stopped."
        return (
            "No running Beam agent found. "
            "If Beam is running in another terminal, stop it manually."
        )
    except FileNotFoundError:
        # pkill not available (Windows)
        return (
            "Automatic stop is not supported on this platform. "
            "Stop Beam manually or close the terminal running 'beam dev'."
        )
    except OSError as exc:
        return f"Failed to stop agent: {exc}"


# ---------------------------------------------------------------------------
# Plugin class
# ---------------------------------------------------------------------------

class AutoGPTBeam(AutoGPTPluginTemplate):
    """AutoGPT plugin that exposes Beam liquidity-agent commands."""

    def __init__(self) -> None:
        super().__init__()
        self._name = "AutoGPT-Beam-Plugin"
        self._version = "0.1.0"
        self._description = (
            "AutoGPT Beam Plugin: Manage an autonomous Solana liquidity agent."
        )
        self.load_commands = True

    # -- prompt hooks --------------------------------------------------------

    def can_handle_post_prompt(self) -> bool:
        return True

    def post_prompt(self, prompt: PromptGenerator) -> PromptGenerator:
        """Register Beam commands with AutoGPT's prompt generator."""
        prompt.add_command(
            "Install Beam liquidity agent",
            "beam_install",
            {},
            _beam_install,
        )
        prompt.add_command(
            "Setup Beam with Helius API key",
            "beam_setup",
            {"helius_key": "<helius_api_key>"},
            _beam_setup,
        )
        prompt.add_command(
            "Start Beam in paper-trading mode",
            "beam_start",
            {},
            _beam_start,
        )
        prompt.add_command(
            "Get Beam status",
            "beam_status",
            {},
            _beam_status,
        )
        prompt.add_command(
            "Stop the Beam agent",
            "beam_stop",
            {},
            _beam_stop,
        )
        return prompt

    # -- stubs for remaining abstract methods --------------------------------

    def can_handle_on_response(self) -> bool:
        return False

    def on_response(self, response: str, *args: Any, **kwargs: Any) -> str:
        return response

    def can_handle_on_planning(self) -> bool:
        return False

    def on_planning(
        self, prompt: PromptGenerator, messages: List[Message]
    ) -> Optional[str]:
        return None

    def can_handle_post_planning(self) -> bool:
        return False

    def post_planning(self, response: str) -> str:
        return response

    def can_handle_pre_instruction(self) -> bool:
        return False

    def pre_instruction(self, messages: List[Message]) -> List[Message]:
        return messages

    def can_handle_on_instruction(self) -> bool:
        return False

    def on_instruction(self, messages: List[Message]) -> Optional[str]:
        return None

    def can_handle_post_instruction(self) -> bool:
        return False

    def post_instruction(self, response: str) -> str:
        return response

    def can_handle_pre_command(self) -> bool:
        return False

    def pre_command(
        self, command_name: str, arguments: Dict[str, Any]
    ) -> Tuple[str, Dict[str, Any]]:
        return command_name, arguments

    def can_handle_post_command(self) -> bool:
        return False

    def post_command(self, command_name: str, response: str) -> str:
        return response

    def can_handle_chat_completion(
        self,
        messages: Dict[Any, Any],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> bool:
        return False

    def handle_chat_completion(
        self,
        messages: List[Message],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> str:
        return ""

    def can_handle_text_embedding(self, text: str) -> bool:
        return False

    def handle_text_embedding(self, text: str) -> List[float]:
        return []

    def can_handle_user_input(self, user_input: str) -> bool:
        return False

    def user_input(self, user_input: str) -> str:
        return user_input

    def can_handle_report(self) -> bool:
        return False

    def report(self, message: str) -> None:
        return None
