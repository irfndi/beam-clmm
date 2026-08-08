# langchain-beam

LangChain tool for the [Beam](https://github.com/irfndi/beam-clmm) liquidity agent. Wraps the `beam` CLI as a LangChain `BaseTool` so you can use Beam commands in agent workflows.

## Install

```bash
pip install langchain-beam
```

Requires `beam` to be installed and on your PATH (or set `BEAM_BIN`).

## Quick start

```python
from langchain_beam import BeamTool

tool = BeamTool()

# Get agent status
result = tool.run("status")

# List active positions
result = tool.run("positions")

# Run a backtest
result = tool.run("backtest --days 7")

# Run a replay backtest
result = tool.run("backtest --source replay --days 30 --pools ADDR1,ADDR2")

# Configure the agent (non-interactive)
result = tool.run("setup --non-interactive --helius-key YOUR_KEY")
```

## Commands

| Command | Description |
|---|---|
| `status` | Agent status, position count, P&L summary, last audit entries |
| `positions` | Active positions with tokens, range, deposited/current value |
| `backtest [--days N] [--source synthetic\|replay] [--pools ADDRS]` | Run a backtest simulation |
| `setup [--helius-key KEY] [--non-interactive]` | Configure the Beam agent |
| `whoami` | Show cloud account info (requires `beam register`) |
| `wallet show` | Show wallet info |
| `update` | Self-update from R2/GitHub releases |
| `version` | Current version |

## Use with LangChain agent

```python
from langchain_openai import ChatOpenAI
from langchain.agents import create_tool_calling_agent, AgentExecutor
from langchain_core.prompts import ChatPromptTemplate
from langchain_beam import BeamTool

# Create tools
tools = [BeamTool()]

# Create agent
llm = ChatOpenAI(model="gpt-4o")
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a DeFi assistant. Use the beam tool to check positions and run backtests."),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)

# Run
result = executor.invoke({"input": "Show me the current Beam positions"})
print(result["output"])
```

## Binary resolution

The tool finds the `beam` CLI in this order:

1. `BEAM_BIN` environment variable (absolute path)
2. `~/.local/bin/beam` (one-liner install)
3. `~/.bun/bin/beam` (Bun global install)
4. `beam` on `PATH`

## Timeouts

- Most commands: 30 seconds
- `backtest`: 120 seconds (long-running simulation)

## Error handling

Failed commands return a JSON error object:

```json
{
  "error": "Command 'beam backtest' failed (exit 1)",
  "stdout": "...",
  "stderr": "..."
}
```

Timeouts return:

```json
{
  "error": "Command 'beam backtest' timed out after 120s",
  "stderr": ""
}
```

## Development

```bash
cd packages/langchain-beam
pip install -e ".[dev]"
pytest
```

## License

MIT — same as the Beam project.
