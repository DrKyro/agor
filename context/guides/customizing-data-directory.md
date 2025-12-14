# Customizing Agor Data Directory

**Status:** ✅ Guide
**Related:** [[configuration]], [[worktrees]], [[repos]], [[architecture]]

---

## Overview

By default, Agor stores all data (database, configuration, Git repositories, and worktrees) in `~/.agor` (the user's home directory). This guide explains how to customize the data directory location, which is useful for:

- **Team Collaboration:** Sharing data across multiple users
- **Storage Management:** Moving data to a different disk or partition
- **Docker Environments:** Persisting data in a Docker volume or mounted directory
- **Security:** Isolating Agor data in a specific security context

---

## Prerequisites

- Understanding of Agor's [[concepts|core primitives]] (Sessions, Tasks, Worktrees)
- Familiarity with environment variables
- Shell command-line knowledge

---

## Method 1: Using AGOR_HOME Environment Variable (Recommended)

The simplest way to customize the data directory is by setting the `AGOR_HOME` environment variable.

### Setting AGOR_HOME

**For current session:**
```bash
export AGOR_HOME=/var/tmp/agor
pnpm dev
```

**Permanently (add to shell profile):**
```bash
# For bash
echo 'export AGOR_HOME=/var/tmp/agor' >> ~/.bashrc
source ~/.bashrc

# For zsh
echo 'export AGOR_HOME=/var/tmp/agor' >> ~/.zshrc
source ~/.zshrc
```

**For specific command:**
```bash
AGOR_HOME=/var/tmp/agor pnpm dev
```

### Supported Path Formats

AGOR_HOME supports several path formats:

| Format | Example | Expansion |
|--------|---------|-----------|
| Absolute path | `/var/tmp/agor` | `/var/tmp/agor` |
| Relative to home | `~/custom` | `/home/user/custom` |
| Full path | `/full/path/to/dir` | `/full/path/to/dir` |

### Directory Structure

When AGOR_HOME is set, Agor creates this structure:

```
$AGOR_HOME/
├── agor.db              # SQLite database
├── config.yaml          # Agor configuration
├── cli-token            # CLI authentication token
├── repos/               # Git repositories (bare)
│   └── <repo-name>/
└── worktrees/           # Worktree directories
    └── <repo-slug>/
        └── <worktree-name>/
```

---

## Method 2: Configuration File

You can also set the home directory in `config.yaml`:

```yaml
# ~/.agor/config.yaml
home: /var/tmp/agor
```

**Note:** The config file approach is not yet implemented. Use AGOR_HOME environment variable instead.

---

## Method 3: Docker Environment

For Docker deployments, set AGOR_HOME in your docker-compose.yml:

```yaml
services:
  agor-dev:
    environment:
      - AGOR_HOME=/var/tmp/agor
    volumes:
      - agor-home:/var/tmp/agor

volumes:
  agor-home:
```

Or pass it at runtime:

```bash
AGOR_HOME=/var/tmp/agor docker compose up -d
```

---

## Team Collaboration Scenarios

### Scenario 1: Shared Directory with Independent Databases

Each user has their own database but shares Git repositories:

```bash
# User 1
export AGOR_HOME=/var/tmp/agor/alice

# User 2
export AGOR_HOME=/var/tmp/agor/bob
```

**Benefits:**
- ✅ No SQLite concurrency issues
- ✅ Shared repositories save disk space
- ✅ Each user has independent session history

**Directory structure:**
```
/var/tmp/agor/
├── alice/
│   ├── agor.db
│   ├── repos/          # (can be symlinked or copied)
│   └── worktrees/
└── bob/
    ├── agor.db
    ├── repos/
    └── worktrees/
```

### Scenario 2: Shared Directory (All Users)

All users share the same AGOR_HOME:

```bash
# All users
export AGOR_HOME=/var/tmp/agor
```

**Benefits:**
- ✅ Complete data sharing
- ✅ Single source of truth

**Drawbacks:**
- ⚠️ SQLite concurrency issues (database locks)
- ⚠️ Potential for conflicting changes
- ⚠️ Not recommended for production

### Scenario 3: PostgreSQL (Recommended for Teams)

For true multi-user support, use PostgreSQL:

```yaml
# ~/.agor/config.yaml
database:
  dialect: postgresql
  postgresql:
    url: postgresql://agor:password@postgres:5432/agor
```

**Benefits:**
- ✅ True concurrent access
- ✅ Better performance
- ✅ Production-ready
- ✅ No database locks

---

## Migrating Existing Data

To move existing data to a new directory:

### Step 1: Stop Agor

Ensure Agor daemon is not running:

```bash
# Check running processes
ps aux | grep agor

# Kill daemon if running
kill <pid>
```

### Step 2: Copy Data

```bash
# Create new directory
mkdir -p /var/tmp/agor

# Copy existing data
cp -r ~/.agor/* /var/tmp/agor/

# Verify copy
ls -la /var/tmp/agor/
```

### Step 3: Set Environment Variable

```bash
export AGOR_HOME=/var/tmp/agor
```

### Step 4: Verify

```bash
# Check Agor home directory
agor config get

# List sessions
agor session list
```

---

## Troubleshooting

### Issue: "Database not found" Error

**Cause:** AGOR_HOME is not set or pointing to wrong directory.

**Solution:**
```bash
# Verify AGOR_HOME is set
echo $AGOR_HOME

# Check if directory exists
ls -la $AGOR_HOME

# Check if database exists
ls -la $AGOR_HOME/agor.db
```

### Issue: Permission Denied

**Cause:** AGOR_HOME directory doesn't have proper permissions.

**Solution:**
```bash
# Fix permissions
chmod 755 /var/tmp/agor
chown -R $USER:$USER /var/tmp/agor
```

### Issue: Git Operations Fail

**Cause:** Worktrees or repos directories don't exist.

**Solution:**
```bash
# Create directories
mkdir -p $AGOR_HOME/repos
mkdir -p $AGOR_HOME/worktrees

# Or let Agor create them automatically
agor init
```

---

## Advanced Configuration

### Using Different Paths for Repos and Worktrees

Currently, AGOR_HOME affects all Agor data. To customize individual paths:

```bash
# Set main home
export AGOR_HOME=/var/tmp/agor

# Individual paths are relative to AGOR_HOME:
# - repos: $AGOR_HOME/repos
# - worktrees: $AGOR_HOME/worktrees
```

**Future Enhancement:** Direct configuration of repos/worktrees paths may be added. Track progress in [[concepts/models]].

---

## Environment Variable Reference

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `AGOR_HOME` | Agor data directory | `~/.agor` | `/var/tmp/agor` |
| `AGOR_DB_PATH` | Database file path | `$AGOR_HOME/agor.db` | `/var/tmp/agor/db.sqlite` |
| `AGOR_DB_DIALECT` | Database type | `sqlite` | `postgresql` |

---

## Best Practices

1. **Use AGOR_HOME for portability:** Environment variables are easier to manage than config files
2. **Back up regularly:** Especially when using custom directories
3. **Use PostgreSQL for teams:** SQLite has concurrency limitations
4. **Set permissions correctly:** Ensure the Agor user has read/write access
5. **Document your setup:** Keep notes on where data is stored for future reference

---

## Related Documentation

- [[configuration]] - Complete configuration guide
- [[architecture]] - System design and data flow
- [[worktrees]] - Worktree-centric architecture
- [[database]] - Database configuration options
- [[multiplayer]] - Multi-user collaboration features
