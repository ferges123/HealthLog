# Antigravity CLI Deployment Guide

This guide covers deployment and configuration of the Antigravity CLI (`agy`) provider in HealthLog.

## Overview

Antigravity CLI is an optional AI provider that runs locally in the HealthLog container but sends data to Antigravity/Google services for processing.

**Key characteristics**:

- ✅ Runs locally in Docker container
- ✅ Support for images and PDFs
- ❌ No HealthLog function calling (`supportsTools = false`)
- ⚠️ External data processing (sends data to Antigravity/Google)
- ⚠️ Requires separate Antigravity account

## Prerequisites

1. **Antigravity Account**: You need an Antigravity account (account type depends on Antigravity's terms)
2. **Docker Host**: Linux amd64 or arm64 host
3. **Network Access**: Container must reach Antigravity services

## Installation

### Option 1: Built-in CLI (Recommended)

The HealthLog Docker image includes `agy` binary. No additional installation needed.

Verify installation:

```bash
docker compose exec app agy --version
```

### Option 2: External CLI

If you prefer to manage the CLI separately:

1. Install `agy` on the Docker host following [Antigravity CLI installation guide](https://antigravity.google/docs/cli/installation/)
2. Mount the binary into the container:
   ```yaml
   services:
     app:
       volumes:
         - /usr/local/bin/agy:/usr/local/bin/agy:ro
   ```

## Configuration

### 1. Create Profile Directory (Recommended for Multi-user Deploys)

For multi-user deployments, create a dedicated volume for Antigravity profiles:

```yaml
# docker-compose.yml
services:
  app:
    volumes:
      - backups:/var/lib/healthlog/backups
      - antigravity-profiles:/var/lib/healthlog/antigravity # Uncomment this
    environment:
      ANTIGRAVITY_PROFILE_ROOT: /var/lib/healthlog/antigravity

volumes:
  postgres-data:
  pgdata:
  backups:
  antigravity-profiles: # Uncomment this
```

Each user gets an isolated subdirectory under `/var/lib/healthlog/antigravity/<profile-id>`.

### 2. Configure Environment Variable

Set `ANTIGRAVITY_PROFILE_ROOT` in your `.env` or docker-compose.yml:

```bash
# .env
ANTIGRAVITY_PROFILE_ROOT=/var/lib/healthlog/antigravity
```

Or directly in docker-compose.yml:

```yaml
services:
  app:
    environment:
      <<: *healthlog_env
      ANTIGRAVITY_PROFILE_ROOT: /var/lib/healthlog/antigravity
```

### 3. Authenticate Users

Each user must authenticate independently:

1. User opens HealthLog Settings → AI Providers → Antigravity
2. Click "Connect Antigravity"
3. HealthLog generates a profile ID and shows instructions
4. The operator (or user, on the HealthLog host) runs the login in a terminal inside the container:
   ```bash
   docker compose exec -it app agy acp --login --gemini-dir /var/lib/healthlog/antigravity --app-data-dir <profile-id>
   ```
5. The CLI prints a sign-in link. The user opens it, signs in to Antigravity, and pastes the code back into the terminal
6. The user runs "Test connection" in HealthLog. The test starts the CLI on the profile and sends no prompt

The login must run on the host where HealthLog runs. The profile folder lives there, so a login on a laptop does not help the server.

Without `ANTIGRAVITY_PROFILE_ROOT` the provider stays off, because there is no per-user folder to isolate the login in.

8. Add "Antigravity CLI" to the fallback chain in Settings, AI. It is not on by default.

## Security Model

### Credential Storage

- **HealthLog Database**: Stores only the profile ID, the connection status and the last test result
- **CLI Credential Store**: Stores OAuth tokens independently (managed by `agy`)
- **Separation**: HealthLog never sees or stores OAuth tokens

### Profile Isolation

When `ANTIGRAVITY_PROFILE_ROOT` is configured:

- Each user gets a profile folder, `<root>/<profile-id>`. HealthLog passes the root as `--gemini-dir` and the profile ID as `--app-data-dir`. Without `--gemini-dir` the CLI would use `$HOME/.gemini`, which all users would share.
- The CLI also keeps a shared `<root>/config` folder. In a test run with agy 1.5.8 it held `config.json` and `mcp_config.json`. Review what it holds before relying on it.
- Separate `agy` process per call
- Not yet verified: which file the CLI writes the OAuth token to. Check the profile folder after the first real login.

### Workspace Isolation

Every completion runs in:

- Empty temporary workspace (not the HealthLog codebase)
- Deleted after completion
- `--sandbox` flag enabled
- `mcpServers: []` (no external tool access)
- All permission requests rejected

### Data Flow

```
User Request → HealthLog → agy CLI → Antigravity/Google Services
                ↑              ↓
              DB ← Profile ID ← Profile Dir
```

HealthLog never sees:

- OAuth tokens
- API keys
- Prompt/response content (except for debugging)
- CLI stderr (drained without logging)

## Capabilities

### Supported

- ✅ **Images**: PNG, JPEG, WebP (via `promptCapabilities.image`)
- ✅ **PDFs**: Single and multi-page (via `promptCapabilities.resourceBlob`)
- ✅ **Models**: Discovered at runtime from ACP
- ✅ **Thinking Levels**: Model-specific reasoning depth

### Not Supported

- ❌ **Function Calling**: `supportsTools = false` permanently
- ❌ **Audio**: Not implemented
- ❌ **JSON Schema**: No native enforcement
- ❌ **Session Resume**: Each completion gets fresh session

## Monitoring

### Connection Status

Check status via HealthLog API:

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/antigravity/status
```

Returns:

```json
{
  "cliInstalled": true,
  "cliVersion": "1.5.8",
  "profileId": "abc123...",
  "model": "gemini-2.0-flash-exp",
  "connectionStatus": "connected",
  "capabilities": {
    "image": true,
    "resourceBlob": true
  }
}
```

### Logs

**Do NOT log**:

- Full stderr output (may contain sensitive data)
- Prompt content
- Response content
- Attachment data

HealthLog logs only:

- Capability negotiation results
- Connection status changes
- Error codes (not messages)

## Troubleshooting

### CLI Not Found

**Symptom**: `cliInstalled: false`

**Solution**: Ensure you're using the official HealthLog image or mount the CLI binary.

### Authentication Required

**Symptom**: `connectionStatus: "auth_required"`

**Solution**: Run `agy acp --login` as described in Configuration section.

### Profile Isolation Issues

**Symptom**: Users see each other's data

**Cause**: `ANTIGRAVITY_PROFILE_ROOT` not configured

**Solution**:

1. Set `ANTIGRAVITY_PROFILE_ROOT` environment variable
2. Create volume mount as shown above
3. Restart container

### Permission Denied

**Symptom**: "Permission denied" on profile directory

**Solution**: Ensure directory ownership:

```bash
docker compose exec app chown -R nextjs:nodejs /var/lib/healthlog/antigravity
docker compose exec app chmod 755 /var/lib/healthlog/antigravity
```

## Resource Limits

### Process Limits

Each `agy` process:

- **Timeout**: Default 60 seconds (configurable per request)
- **Memory**: Shares container memory limit
- **Concurrency**: One process per active completion

### Profile Storage

- **Per-profile**: Varies with usage (typically < 10 MB for credentials)
- **Cleanup**: Manual (profiles persist until explicitly deleted)

## Legal Considerations

⚠️ **Important**: Antigravity CLI sends data to external services operated by Google/Antigravity. Review their terms of service:

- [Antigravity Terms of Service](https://antigravity.google/terms)
- [Antigravity Privacy Policy](https://antigravity.google/privacy)
- [Antigravity CLI Documentation](https://antigravity.google/docs/cli/)

**HealthLog does NOT**:

- Control data retention by Antigravity
- Verify data handling practices
- Assume liability for external processing

**User responsibility**:

- Verify compliance with local regulations
- Review Antigravity terms before enabling
- Inform end users about external data processing

## Upgrade Path

### Updating CLI Version

1. Check [Antigravity CLI releases](https://github.com/anthropics/antigravity-cli/releases)
2. Update `AGY_VERSION` in Dockerfile
3. Update SHA256 checksums (`AGY_SHA256_AMD64`, `AGY_SHA256_ARM64`)
4. Rebuild image: `docker compose build`
5. Restart: `docker compose up -d`

### No Automatic Updates

HealthLog does **NOT** auto-update the CLI. Operators manually control versions.

## Further Reading

- [Antigravity CLI Architecture](../antigravity-cli-architecture.md)
- [Antigravity Multimodal Support](../antigravity-cli-multimodal.md)
- [Antigravity Transport Decision](../antigravity-cli-transport-decision.md)
- [Integration Plan](../../.local/antigravity-cli-integration-plan.md)
