# Just Workspace

English · [한국어](README.md)

Just Workspace is a collaboration workspace you install on your own server. Files, mail, chat, calendar/contacts/tasks, document editing with a wiki and boards, video meetings, code hosting and an AI assistant share one account and one web app. It runs on a single Linux server with Docker, and you turn on only the features you need, one "zone" at a time.

> **The first release (1.0.0) is being prepared.** Prebuilt images and the update channel are not published yet. For now you install by building the images from source — see [Project status](#project-status).

Most of the documentation is written in Korean. Issues and pull requests in English are welcome.

## What's included

Features are grouped into zones. The **Core** zone is always installed. The others are chosen during installation or switched on and off later from the admin screen. Turning a zone off does not delete its data.

| Zone | What it gives you | Recommended memory | Ports opened |
|---|---|---|---|
| **Core** (always) | Sign-in, admin, dashboard, files | 4 GB | 80, 443 |
| Mail | Built-in mail server or external relay | +1 GB | 25, 465, 587, 993 |
| Chat | Channels, DMs, voice channels (needs Meetings) | — | — |
| Calendar, contacts, tasks | Includes CalDAV/CardDAV sync | — | — |
| Documents, wiki, boards | Co-edit documents, sheets and slides | +2 GB | — |
| Meetings | Video calls, screen share, recording, lossless audio | +1 GB | 7881, 7882-7892/udp, 3478/udp, 4433/udp (lossless audio) |
| Code hosting | Git hosting (Gitea) | +0.5 GB | 2222 |
| AI assistant | External AI provider, web search, code sandbox, MCP connector | +1 GB | — |

Optional add-ons:

| Add-on | What it gives you | Recommended memory | Ports opened |
|---|---|---|---|
| SSO and LDAP provider | Let other services sign in with workspace accounts | +0.5 GB | 636, and 389 (bound to the server itself by default) |
| Isolated browser | Open internal web UIs in an isolated browser | +0.1 GB | — |

These values come from [`backend/app/zones.json`](backend/app/zones.json). The setup wizard offers three presets: **Minimal** (Core only), **Collaboration** (mail, chat, calendar, documents) and **Full** (all seven zones).

Components made by others — the document editor (OnlyOffice), the meeting server (LiveKit), code hosting (Gitea), the database (PostgreSQL) and so on — are **not redistributed inside this project's images**. They are pulled from their original publishers when a zone is turned on, pinned by image digest, and each remains under its own license. See [License](#license).

## Requirements

| | Minimum | Notes |
|---|---|---|
| Operating system | Linux, x86_64 | Docker Desktop on Windows or macOS is not supported |
| Docker Engine | 24.0 or later | |
| CPU | 2 cores | |
| Memory | 4 GB | The recommended memory of the zones you pick must fit in the server's memory |
| Free disk space | 10 GB | A warning is shown below 20 GB. Plan space for files and mail separately |
| Network | Port 80 free (and 443 when this server terminates TLS) | Automatic certificates need the access address (a domain) to point at this server |

The installer checks all of this before it starts (preflight). Memory is judged against the recommended values above: 4 GB for Minimal, 7 GB for Collaboration, 9.5 GB for Full. In testing, the Full preset plus the SSO and LDAP add-on ran on a server with 12 GB of memory.

## Quick start

Start the installer from a terminal on the server.

```bash
docker run -d --name jw-installer --restart unless-stopped \
  -p 8443:8443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/just-workspace:/data \
  -e JW_HOST_DIR=/opt/just-workspace \
  -e JW_INSTALLER_VERSION=1.0.0 \
  ghcr.io/just-workspace/just-workspace-installer:1.0.0

docker logs jw-installer
```

Open the address printed in the log (`https://<server address>:8443/?token=…`) in a browser to start the setup wizard. The installer uses a self-signed certificate, so the browser shows a warning; compare the SHA-256 fingerprint in the log before continuing.

- The host folder in `-v` and `JW_HOST_DIR` must be the **same path**. This is the install folder.
- Set `JW_INSTALLER_VERSION` to the same version as the image tag — it is the product version the installer installs.
- The image above will be published with the first release. Until then, build from source — [docs/install.md](docs/install.md#소스에서-빌드해-설치).
- To install without the wizard, use an answers file: `docker exec jw-installer jw apply --answers /data/answers.json`.
- You can also run the stack by hand with `docker compose`, without the installer — [docs/deployment.md](docs/deployment.md).

Preparation (domain, ports, certificates, storage) and a walkthrough of every wizard screen are in [docs/install.md](docs/install.md).

## After installation

Everything is done from the admin screen. Details are in [docs/operate.md](docs/operate.md).

- **Zones** — Admin › Zones (관리 › 구역).
- **Updates** — Admin › Updates (관리 › 업데이트). Manual (default) or automatic, on the Stable or Beta channel. A backup is taken right before each update and a failed update is rolled back. Servers without internet access can update from an offline bundle.
- **Backups** — Admin › Storage & backup (관리 › 저장소·백업). A single backup file (`.jwbak`) is enough to move to a new server, using "Restore from backup" in the setup wizard.
- **Certificates** — reissue or replace the certificate from the certificate card under Admin › Security & SSL (관리 › 보안·SSL).

## Documentation

| For | Document | Contents |
|---|---|---|
| Installing | [docs/install.md](docs/install.md) | Preparation, wizard steps, quick install, unattended install, troubleshooting |
| | [docs/deployment.md](docs/deployment.md) | Installing by hand, without the installer |
| Operating | [docs/operate.md](docs/operate.md) | Zones, updates, backup/restore/migration, storage, certificates, mail DNS records, logs |
| | [docs/update-system.md](docs/update-system.md) | What an update does and what happens when it fails |
| | [docs/data-safety.md](docs/data-safety.md) | Schema versions, backup format, restore |
| | [docs/CONFIG.md](docs/CONFIG.md) | Environment variables |
| | [SECURITY.md](SECURITY.md) | Security model, reporting vulnerabilities |
| Understanding the design | [docs/architecture.md](docs/architecture.md) | Components and structure |
| | [docs/installer.md](docs/installer.md) | Installer internals, API, what has been verified |
| | [docs/update-api.md](docs/update-api.md) · [docs/releases.md](docs/releases.md) | Internal update API · releases, channels and image builds |
| Feature notes | [docs/CONNECTOR.md](docs/CONNECTOR.md) | MCP connector |
| | [docs/chat-permissions.md](docs/chat-permissions.md) | Chat roles and permissions |
| | [docs/rbi.md](docs/rbi.md) | Isolated browser |
| | [docs/voice-lossless.md](docs/voice-lossless.md) | Lossless audio |
| | [apps/README.md](apps/README.md) · [apps/desktop/README.md](apps/desktop/README.md) | Mobile and desktop apps |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, tests, commits and pull requests |
| | [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md) | Plugins |
| Everyone | [docs/glossary.md](docs/glossary.md) | Glossary (Korean terms with English equivalents) |
| | [CHANGELOG.md](CHANGELOG.md) | Changelog |
| | [docs/licensing.md](docs/licensing.md) · [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | Licensing |

## Project status

The version is 1.0.0 and the first public release is being prepared.

**Verified end to end on a dedicated test server** ([docs/installer.md](docs/installer.md), section 13):

- Installation from an answers file and through the setup wizard — the Minimal, Collaboration and Full presets, the SSO and LDAP add-on, NFS storage, and running behind a front proxy.
- Turning zones on and off after installation, retrying from the failed step, and reinstalling.
- Updates — manual, automatic, stepping through intermediate versions, rollback on failure, restoring to a restore point, the Beta channel, and offline bundles. Releases were produced with the release tool and served from a test channel inside the server.
- A minimal stack started by hand, without the installer.

**Not verified yet:**

- Updates against the real distribution channel and signing key, and an actual run of the image build workflow.
- Real Let's Encrypt issuance and renewal (only the "issuance failed → continue with a temporary certificate" path was checked).
- Code hosting sign-in integration with a trusted certificate, the isolated browser add-on, lossless audio, external SMTP and AI provider connections, and storage in a custom host folder.
- Servers behind a home router or a real front proxy, distributions with SELinux enabled, and non-x86_64 servers.

## License

Just Workspace is distributed under the **GNU Affero General Public License, version 3 or (at your option) any later version** (`AGPL-3.0-or-later`). The full text is in [LICENSE](LICENSE) and the copyright notice in [NOTICE](NOTICE).

```
Copyright (C) 2026 Just-Workspace

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3 of the
License, or (at your option) any later version. This program is distributed WITHOUT ANY WARRANTY.
```

- **Running it unmodified** requires nothing further.
- If you **modify it and let others use it over a network**, you must offer those users the source of your modified version. The "Source code" link in the product is the place for that; change its address with `JW_SOURCE_URL`.
- **There is no plugin exception.** A plugin that calls into this program's code and is distributed is generally understood to need AGPL-compatible terms.

Third-party software used with it stays under its own license.

- **Components inside our images** — the IMAP client `aioimaplib` (GPL-3.0) plus pandoc (GPL) in the backend image, LibreOffice and the HWP extension H2Orestart (GPL-3.0) in the document conversion image, the mail server image (derived from docker-mailserver, which contains GPL programs), and others. Distributing an image is distribution, so those licenses' obligations apply.
- **Components pulled from their original publishers** — OnlyOffice Document Server and SearXNG (AGPL-3.0), Redis 8 (your choice of RSALv2, SSPLv1 or AGPL-3.0) and others. They are not included in our images.

What goes into which image and which obligations follow is described in [docs/licensing.md](docs/licensing.md) (Korean); the full list is in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Contributing and security reports

- Bug reports, feature requests and code contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Please do not open public issues for security vulnerabilities. Use GitHub's private vulnerability reporting: [SECURITY.md](SECURITY.md)
