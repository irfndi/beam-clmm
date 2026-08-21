# Cron / Launchd / Systemd Examples

Run Beam unattended on a schedule.

## Cron (Linux/macOS)

### Every 10 minutes (default scan interval)

```bash
# Edit crontab
crontab -e

# Add line:
*/10 * * * * cd /path/to/beam-clmm && bun run dev >> /var/log/beam.log 2>&1
```

### Every hour (conservative)

```bash
0 * * * * cd /path/to/beam-clmm && bun run dev >> /var/log/beam.log 2>&1
```

### With log rotation

```bash
# Use logrotate for /var/log/beam.log
# /etc/logrotate.d/beam
/var/log/beam.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

## Launchd (macOS)

Create `~/Library/LaunchAgents/com.beam.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.beam.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>run</string>
        <string>dev</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/beam-clmm</string>
    <key>StartInterval</key>
    <integer>600</integer>
    <key>StandardOutPath</key>
    <string>/var/log/beam.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/beam.error.log</string>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.beam.agent.plist
launchctl start com.beam.agent
```

## Systemd (Linux)

Create `/etc/systemd/system/beam-clmm.service`:

```ini
[Unit]
Description=Beam CLMM Trading Agent
After=network.target

[Service]
Type=simple
User=beam
WorkingDirectory=/path/to/beam-clmm
ExecStart=/usr/local/bin/bun run dev
Restart=always
RestartSec=600
StandardOutput=append:/var/log/beam.log
StandardError=append:/var/log/beam.error.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable beam-clmm
sudo systemctl start beam-clmm
```

## Docker (Optional)

```dockerfile
FROM oven/bun:1.4.0
WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "run", "dev"]
```

```bash
docker build -t beam-clmm .
docker run -d --env-file .env -v $(pwd)/beam.db:/app/beam.db beam-clmm
```

## Monitoring

Check if the agent is running:

```bash
# Cron
ps aux | grep "bun run dev"

# Launchd
launchctl list | grep com.beam.agent

# Systemd
sudo systemctl status beam-clmm
```
