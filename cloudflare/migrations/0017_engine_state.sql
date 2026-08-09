-- Engine state surface (deploy milestone): the engine pushes per-cycle state
-- snapshots to D1 through the API worker; the status/portfolio surfaces read
-- them. The engine keeps its local hot-loop store; D1 is the deployed
-- system of record for the operator surface.

CREATE TABLE IF NOT EXISTS engine_snapshots (
  agent_id TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'stopped')),
  positions INTEGER NOT NULL,
  pnl REAL NOT NULL,
  details TEXT,
  PRIMARY KEY (agent_id, reported_at)
);

CREATE TABLE IF NOT EXISTS engine_decisions (
  agent_id TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL,
  executed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, reported_at, pool_address, action)
);

CREATE INDEX IF NOT EXISTS idx_engine_snapshots_agent_ts
  ON engine_snapshots (agent_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_engine_decisions_agent_ts
  ON engine_decisions (agent_id, reported_at DESC);
