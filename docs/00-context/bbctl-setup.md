# Self-Hosted Bridges with bbctl

Run messaging bridges (WhatsApp, Signal, Discord, etc.) on your own VPS or Raspberry Pi using Beeper's bridge manager.

## How it works

bbctl runs bridge processes on your hardware. They connect to your Beeper account via Beeper's Matrix server. You configure each bridge through the Beeper Desktop app. Messages flow through Beeper's servers but the bridge code runs on your machine.

## Prerequisites

- A **Beeper account** (free at beeper.com)
- **Beeper Desktop** app installed on your computer (needed for bridge configuration)
- A **VPS or Raspberry Pi** running Linux (x86_64 or arm64)
- SSH access to the server

## Supported bridges

| Bridge | Identifier | Login method |
|---|---|---|
| WhatsApp | `sh-whatsapp` | QR code or phone number |
| Signal | `sh-signal` | QR code or phone number |
| Telegram | `sh-telegram` | Phone number + code |
| Discord | `sh-discord` | Token |
| Slack | `sh-slack` | Token |
| Instagram | `sh-instagram` / `sh-meta` | Username + password |
| Facebook | `sh-facebook` / `sh-meta` | Username + password |
| LinkedIn | `sh-linkedin` | Cookie-based |
| Google Messages | `sh-gmessages` | QR code |
| Twitter/X | `sh-twitter` | Cookie-based |
| Bluesky | `sh-bluesky` | Username + password |
| iMessage | `sh-imessage` | Requires Mac |

## Setup

### Step 1: Install bbctl on your server

SSH into your VPS or Pi:

```bash
ssh root@your-server-ip
```

Download bbctl:

```bash
# Linux x86_64 (VPS)
curl -L https://github.com/beeper/bridge-manager/releases/latest/download/bbctl-linux-amd64 -o /usr/local/bin/bbctl

# Linux arm64 (Raspberry Pi)
curl -L https://github.com/beeper/bridge-manager/releases/latest/download/bbctl-linux-arm64 -o /usr/local/bin/bbctl

chmod +x /usr/local/bin/bbctl
```

Install dependencies:

```bash
# Debian/Ubuntu/Raspberry Pi OS
apt install -y python3 python3-venv ffmpeg

# CentOS/AlmaLinux/Rocky
dnf install -y python39 ffmpeg

# Fedora
dnf install -y python3 ffmpeg
```

### Step 2: Log in to Beeper

```bash
bbctl login
```

- Enter your Beeper email (e.g. `you@example.com`)
- Check your email for a verification code
- Enter the code

Verify:

```bash
bbctl whoami
```

### Step 3: Start a bridge

```bash
bbctl run sh-whatsapp
```

The bridge will download, initialize, and connect to Beeper's server. You'll see `Bridge started` when it's ready.

### Step 4: Connect in Beeper Desktop

This step requires **Beeper Desktop** (not the mobile app):

1. Open **Beeper Desktop** on your computer
2. Go to **Settings** (gear icon bottom-left)
3. Click **Bridges**
4. You'll see your self-hosted bridge listed (e.g. `sh-whatsapp`)
5. Click the **three dots** menu next to it
6. Click **Bridge** or **Connect**
7. Follow the platform-specific login (QR code, phone number, etc.)

Once connected, the bridge appears under **Settings > Accounts** as e.g. "WhatsApp (sh-whatsapp)".

### Step 5: Keep it running

The bridge runs in the foreground. To keep it running after you disconnect SSH:

**Option A: systemd service (recommended)**

```bash
cat > /etc/systemd/system/bbctl-whatsapp.service << 'EOF'
[Unit]
Description=bbctl WhatsApp bridge
After=network.target

[Service]
Environment=HOME=/root
ExecStart=/usr/local/bin/bbctl run sh-whatsapp
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bbctl-whatsapp
systemctl start bbctl-whatsapp
```

**Option B: tmux/screen**

```bash
tmux new -d -s whatsapp 'bbctl run sh-whatsapp'
```

## Adding more bridges

Each bridge is a separate process. Repeat steps 3-5 for each:

```bash
bbctl run sh-signal      # start Signal bridge
bbctl run sh-discord     # start Discord bridge
bbctl run sh-linkedin    # start LinkedIn bridge
```

Each needs its own systemd service:

```bash
# Create service for any bridge
cat > /etc/systemd/system/bbctl-signal.service << EOF
[Unit]
Description=bbctl Signal bridge
After=network.target

[Service]
Environment=HOME=/root
ExecStart=/usr/local/bin/bbctl run sh-signal
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bbctl-signal
systemctl start bbctl-signal
```

## Managing bridges

```bash
# Check status
bbctl whoami

# Delete a bridge
bbctl delete sh-whatsapp

# View logs (systemd)
journalctl -u bbctl-whatsapp -f

# Stop a bridge (systemd)
systemctl stop bbctl-whatsapp
```

## Notes

- Self-hosted bridges are **separate** from cloud bridges — you link your accounts again
- Self-hosted bridges are **free** and don't count against Beeper account limits
- Messages still flow through Beeper's servers (bridge code runs locally, routing is cloud)
- Each bridge uses ~40-100MB RAM
- If your server restarts, systemd auto-restarts the bridges
- WhatsApp may need re-linking every ~2 weeks (same as WhatsApp Web)
