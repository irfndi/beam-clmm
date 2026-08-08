# autogpt-beam

AutoGPT plugin for [Beam](https://github.com/irfndi/beam-clmm) — an autonomous liquidity agent for Solana DLMM pools.

## Install

```bash
pip install autogpt-beam
```

Or from source:

```bash
cd packages/autogpt-beam
pip install -e .
```

AutoGPT discovers the plugin automatically via the `autogpt.plugins` entry point.

## Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `beam_install` | *(none)* | Runs the Beam one-liner install script |
| `beam_setup` | `helius_key` | Runs `beam setup` with the provided Helius API key |
| `beam_start` | *(none)* | Starts Beam in paper-trading mode (`beam dev`) |
| `beam_status` | *(none)* | Shows current Beam status |
| `beam_stop` | *(none)* | Stops the running Beam agent |

## Usage

Once installed, AutoGPT exposes Beam commands in its command set. Example prompt:

```
Use beam_install to install Beam, then beam_setup with helius key "abc123",
then beam_start to begin paper trading.
```

## Requirements

- Python 3.9+
- AutoGPT installed and configured
- `beam` CLI on PATH (installed by `beam_install` or manually)
- Bun runtime (Beam's underlying engine)

## How it works

Each command is a thin wrapper around `subprocess.run` calling the `beam` CLI.
No Beam internals are imported — everything goes through the CLI boundary.

## License

MIT
