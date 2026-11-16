# Just Workspace

English · [한국어](README.md)

## Overview

Just Workspace is a self-hosted collaboration workspace. Files, mail, chat, calendar/contacts/tasks, document editing with a wiki and boards, video meetings, code hosting and an AI assistant are provided under a single account and a single web application. The software is installed on one Linux server running Docker, and only the required features are enabled, in units called "zones".

> **The first release (1.0.0) is in preparation.** Prebuilt images and the update channel have not been published. At present, installation requires building the images from source — see [Project Status](#project-status).

Most of the documentation is written in Korean. Issues and pull requests may be submitted in English.

## Features

Features are organized into zones. The **Core** zone is always installed. The remaining zones are selected during installation or enabled and disabled afterwards from the administration screen. Disabling a zone does not delete its data.

| Zone | Description | Recommended memory | Ports opened |
|---|---|---|---|
| **Core** (always) | Sign-in, administration, dashboard, files | 4 GB | 80, 443 |
| Mail | Built-in mail server or external relay | +1 GB | 25, 465, 587, 993 |
| Chat | Channels, direct messages, voice channels (requires Meetings) | — | — |
| Calendar, contacts, tasks | Includes CalDAV/CardDAV synchronization | — | — |
| Documents, wiki, boards | Collaborative editing of documents, sheets and slides | +2 GB | — |
| Meetings | Video calls, screen sharing, recording, lossless audio | +1 GB | 7881, 7882-7892/udp, 3478/udp, 4433/udp (lossless audio) |
| Code hosting | Git hosting (Gitea) | +0.5 GB | 2222 |
| AI assistant | External AI provider, web search, code sandbox, MCP connector | +1 GB | — |

Optional add-ons:

| Add-on | Description | Recommended memory | Ports opened |
|---|---|---|---|
| SSO and LDAP provider | Sign-in to other services with workspace accounts | +0.5 GB | 636, and 389 (bound to the server itself by default) |
| Isolated browser | Access to internal web interfaces through an isolated browser | +0.1 GB | — |

These values are taken from [`backend/app/zones.json`](backend/app/zones.json). The setup wizard provides three presets: **Minimal** (Core only), **Collaboration** (mail, chat, calendar, documents) and **Full** (all seven zones).

Third-party components — the document editor (OnlyOffice), the meeting server (LiveKit), code hosting (Gitea), the database (PostgreSQL) and others — are **not redistributed inside this project's images**. They are pulled directly from their original publishers when a zone is enabled, pinned by image digest, and each remains under its own license. See [License & Distribution](#license--distribution).

## System Requirements

| Item | Minimum | Notes |
|---|---|---|
| Operating system | Linux, x86_64 | Docker Desktop on Windows or macOS is not supported |
| Docker Engine | 24.0 or later | |
| CPU | 2 cores | |
| Memory | 4 GB | The total recommended memory of the selected zones must not exceed the server's memory |
| Free disk space | 10 GB | A warning is issued below 20 GB. Capacity for files and mail is to be planned separately |
| Network | Port 80 unused (and 443 when this server terminates TLS) | Automatic certificate issuance requires the access address (a domain) to resolve to this server |

The installer verifies these conditions at startup (preflight). Memory is evaluated against the recommended values above: 4 GB for Minimal, 7 GB for Collaboration, 9.5 GB for Full. In verification, the Full preset with the SSO and LDAP add-on was run on a server with 12 GB of memory.

## Installation & Configuration

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

Opening the address printed in the log (`https://<server address>:8443/?token=…`) in a browser starts the setup wizard. The installer uses a self-signed certificate, and the browser therefore displays a warning; the SHA-256 fingerprint printed in the log is to be compared before proceeding.

- The host folder given to `-v` and `JW_HOST_DIR` must be the **same path**. This folder is the install folder.
- `JW_INSTALLER_VERSION` must be set to the same version as the image tag; it is the product version that the installer installs.
- The image above will be published with the first release. Until then, the images are built from source — [docs/install.md](docs/install.md#소스에서-빌드해-설치).
- Unattended installation uses an answers file: `docker exec jw-installer jw apply --answers /data/answers.json`.
- Starting the stack directly with `docker compose`, without the installer, is also supported — [docs/deployment.md](docs/deployment.md).

Prerequisites (domain, ports, certificates, storage) and a description of each wizard screen are given in [docs/install.md](docs/install.md).

## Operation & Maintenance

All operational tasks are performed from the administration screen. Details are given in [docs/operate.md](docs/operate.md).

- **Zones** — Admin › Zones (관리 › 구역).
- **Updates** — Admin › Updates (관리 › 업데이트). Manual (default) or automatic, on the Stable or Beta channel. A backup is created immediately before each update, and a failed update is rolled back. Servers without internet access are updated from an offline bundle.
- **Backups** — Admin › Storage & backup (관리 › 저장소·백업). A single backup file (`.jwbak`) is sufficient to migrate to a new server, using "Restore from backup" in the setup wizard.
- **Certificates** — Certificates are reissued or replaced from the certificate card under Admin › Security & SSL (관리 › 보안·SSL).

## Documentation

| Audience | Document | Contents |
|---|---|---|
| Installers | [docs/install.md](docs/install.md) | Prerequisites, wizard steps, quick installation, unattended installation, troubleshooting |
| | [docs/deployment.md](docs/deployment.md) | Manual installation without the installer |
| Operators | [docs/operate.md](docs/operate.md) | Zones, updates, backup/restore/migration, storage, certificates, mail DNS records, logs |
| | [docs/update-system.md](docs/update-system.md) | Update behavior and failure handling |
| | [docs/data-safety.md](docs/data-safety.md) | Schema versions, backup format, restore |
| | [docs/CONFIG.md](docs/CONFIG.md) | Environment variables |
| | [SECURITY.md](SECURITY.md) | Security model, vulnerability reporting |
| Architecture reviewers | [docs/architecture.md](docs/architecture.md) | Components and structure |
| | [docs/installer.md](docs/installer.md) | Installer structure, API and scope of verification |
| | [docs/update-api.md](docs/update-api.md) · [docs/releases.md](docs/releases.md) | Internal update API · releases, channels and image builds |
| Feature notes | [docs/CONNECTOR.md](docs/CONNECTOR.md) | MCP connector |
| | [docs/chat-permissions.md](docs/chat-permissions.md) | Chat roles and permissions |
| | [docs/rbi.md](docs/rbi.md) | Isolated browser |
| | [docs/voice-lossless.md](docs/voice-lossless.md) | Lossless audio |
| | [apps/README.md](apps/README.md) · [apps/desktop/README.md](apps/desktop/README.md) | Mobile and desktop applications |
| Developers | [CONTRIBUTING.md](CONTRIBUTING.md) | Development environment, tests, commits and pull requests |
| | [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md) | Plugins |
| General | [docs/glossary.md](docs/glossary.md) | Glossary (Korean terms with English equivalents) |
| | [CHANGELOG.md](CHANGELOG.md) | Changelog |
| | [docs/licensing.md](docs/licensing.md) · [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | Licensing |

## Project Status

The first public release (1.0.0) is in preparation; the project is currently in its Beta phase. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

**Verified end to end on a dedicated verification server** ([docs/installer.md](docs/installer.md), section 13):

- Installation from an answers file and through the setup wizard — the Minimal, Collaboration and Full presets, the SSO and LDAP add-on, NFS storage, and operation behind a front proxy.
- Enabling and disabling zones after installation, retrying from the failed step after an installation failure, reinstallation, and restoring a full backup onto the same server (`jw restore`).
- Certificates issued by a private CA: the code hosting sign-in integration is established when the CA certificate is uploaded together with the certificate, or when the CA certificate alone is uploaded afterwards.
- Isolated browser: the target page is rendered inside the session in both mirror and pixel mode. The noise suppression toggle in meetings changes the noise suppression setting of the microphone track (Chromium).
- Updates — manual, automatic, stepping through intermediate versions, rollback on failure, restoring to a restore point, the Beta channel, and offline bundles. Releases were produced with the release tool and served from a test channel inside the server.
- A minimal stack started directly, without the installer.

**Not yet verified:**

- Updates against the actual distribution channel and signing key. The image build workflow has run once, on the first Beta tag; the build target of the backend image was changed afterwards and has not yet been run in that workflow (see "알려진 제한 사항" in [docs/releases.md](docs/releases.md)).
- Actual Let's Encrypt issuance and renewal (only the "issuance failed → continue with a temporary certificate" path was verified).
- Code hosting sign-in integration with a public CA certificate, and the document editor under a private CA or temporary certificate.
- Input (keyboard, IME, clipboard), downloads and uploads in the isolated browser and a target on an actual LAN, the actual audio quality of noise suppression and browsers other than Chromium, lossless audio, external SMTP and AI provider connections, and storage in a designated host folder.
- Servers behind a home router (NAT) or an actual front proxy, distributions with SELinux enabled, and non-x86_64 servers.

## License & Distribution

This software is distributed under the **GNU Affero General Public License, version 3 or (at your option) any later version** (`AGPL-3.0-or-later`). The full text is provided in [LICENSE](LICENSE) and the copyright notice in [NOTICE](NOTICE).

```
Copyright (C) 2026 Just-Workspace

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3 of the
License, or (at your option) any later version. This program is distributed WITHOUT ANY WARRANTY.
```

- **Operating the software unmodified** creates no further obligation.
- A party that **modifies the software and provides it to others as a network service** must offer those users the source code of the modified version. The "Source code" link in the product serves this purpose; its address is changed with `JW_SOURCE_URL`.
- **There is no plugin exception.** A plugin that calls into this software's code and is distributed is generally understood to require AGPL-compatible terms.

Third-party software used together with this software remains under its own license.

- **Components included in the images built by this project** — the IMAP client `aioimaplib` (GPL-3.0) and pandoc (GPL) in the backend image, LibreOffice and the HWP extension H2Orestart (GPL-3.0) in the document conversion image, the mail server image (derived from docker-mailserver, which contains GPL programs), and others. Publishing an image constitutes distribution, and the obligations of those licenses therefore apply.
- **Components pulled directly from their original publishers (third-party images)** — OnlyOffice Document Server and SearXNG (AGPL-3.0), Redis 8 (a choice of RSALv2, SSPLv1 or AGPL-3.0) and others. These are not included in the images built by this project.

The components included in each image and the resulting obligations are described in [docs/licensing.md](docs/licensing.md) (Korean); the full list is given in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Limitation of Liability

To the extent permitted by applicable law, this software is provided "AS IS", without warranty of any kind, either expressed or implied (AGPL-3.0, section 15). Unless required by applicable law or agreed to in writing, neither the copyright holder nor any party that modifies or conveys the software is liable for damages arising out of the use of, or inability to use, the software (AGPL-3.0, section 16). The exact terms are those of the full text in [LICENSE](LICENSE).

## Contributing

The procedures for bug reports, feature requests and code contributions are set out in [CONTRIBUTING.md](CONTRIBUTING.md). Code contributions are subject to the [contribution terms](CONTRIBUTING.md#기여-조건) (the same license, together with a grant permitting the project's copyright holder to distribute them under other terms as well).

## Security Reporting

Security vulnerabilities are not to be reported in public issues. They are to be submitted through GitHub's private vulnerability reporting, as set out in [SECURITY.md](SECURITY.md).
