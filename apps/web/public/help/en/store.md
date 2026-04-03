# Config Store

The Config Store is a package manager for workflow-control configuration assets.
It lets you search, install, update, and publish reusable workflow building blocks
from a central registry (`workflow-control-registry` on GitHub).

Packages are tracked via a lockfile (`.wfctl-registry.lock`) inside `apps/server/`,
so team members always get the same versions after a fresh clone.

## Package Types

Every package has a **type** that determines where its files land in the `config/` directory:

| Type | Config Path | Description |
|------|-------------|-------------|
| `pipeline` | `config/pipelines/<name>/` | Complete pipeline definition (YAML + prompt files) |
| `skill` | `config/skills/<name>.md` | Standalone skill prompt (single `.md` file) |
| `fragment` | `config/prompts/fragments/<name>.md` | Reusable prompt fragment injected via `{{fragment:name}}` |
| `hook` | `config/hooks/<name>.yaml` | Lifecycle hook configuration |
| `gate` | `config/gates/<name>.ts` | Gate script (TypeScript) |
| `script` | `config/scripts/<name>/` | Custom script with entry point |

Packages may declare **dependencies** on other packages (skills, fragments, hooks, scripts).
When you install a package, all its dependencies are resolved and installed automatically.
Additionally, all `fragment`-type packages are always installed because any pipeline may reference them.

## CLI Commands

All commands are run via:

```bash
npx tsx src/cli/registry.ts <command> [args...] [--flags]
```

### search

Search the registry by keyword and optionally filter by package type.

```bash
registry search                     # list all packages
registry search "bugfix"            # search by keyword
registry search --type=pipeline     # filter by type
registry search "react" --type=fragment
```

The search matches against package name, description, and tags.

### install

Install one or more packages from the registry. Supports `name` or `name@version` syntax.

```bash
registry install pipeline-generator
registry install claude-bugfix claude-text
```

- Dependencies are resolved and installed automatically.
- All fragment packages are pulled in regardless of what you install.
- If a target file or directory already exists and was not previously installed by the registry, the install is skipped to avoid overwriting your local work (use `bootstrap` to force).

### update

Update installed packages to the latest registry version.

```bash
registry update                # update all installed packages
registry update pipeline-generator  # update a specific package
```

During update, old files are removed and replaced with the new version. Files inside `.local/` subdirectories are preserved so your local overrides survive updates.

### list

List packages currently installed (tracked in the lockfile).

```bash
registry list                  # all installed packages
registry list --type=fragment  # only fragments
```

### outdated

Show installed packages that have a newer version available in the registry.

```bash
registry outdated
```

Outputs a table with package name, installed version, latest version, and type.

### uninstall

Remove installed packages and clean up their files.

```bash
registry uninstall claude-bugfix
registry uninstall skill-a fragment-b
```

Empty directories left behind after file removal are automatically cleaned up.

### publish

Publish a local package to the registry. Collects files from `config/`,
generates a `manifest.yaml`, and pushes to the registry GitHub repository
via `gh` CLI. Requires `gh auth login` authentication (no `GITHUB_TOKEN` needed).

```bash
registry publish <directory>
```

### bootstrap

Install all official packages from the registry, overwriting any existing files. This is the recommended command after a fresh clone.

```bash
registry bootstrap
```

Bootstrap calls `install` with `force: true`, so it will overwrite files even if they were not previously tracked by the registry.

## Web UI

The **Store** page in the web dashboard provides a graphical interface for the same operations:

- **Browse** all available packages with type filtering and keyword search.
- **Install** packages with a single click; dependencies are resolved automatically.
- **Publish** local config packages (pipelines, skills, hooks, etc.) to the remote registry.
- **Bootstrap** to bulk-install all official packages after a fresh clone.
- **View installed** packages and their versions.
- **Check for updates** and upgrade outdated packages.

Local packages (created via Config page but not in the registry) appear with a "local" badge
and can be published directly from the Store page.

## Lockfile

The file `apps/server/.wfctl-registry.lock` is a JSON file that records every installed package:

```json
{
  "lockVersion": 1,
  "packages": {
    "pipeline-generator": {
      "version": "1.0.0",
      "type": "pipeline",
      "author": "workflow-control",
      "installed_at": "2025-01-15T10:00:00.000Z",
      "files": [
        "config/pipelines/pipeline-generator/pipeline.yaml",
        "config/pipelines/pipeline-generator/prompts/global-constraints.md"
      ]
    }
  }
}
```

Commit this file to version control so that all collaborators share the same package versions.

## Bootstrap Flow for Fresh Clones

After cloning the repository for the first time:

1. `npm install` (or `pnpm install`) to get Node dependencies.
2. `npx tsx src/cli/registry.ts bootstrap` to install all official config packages.
3. The lockfile is created/updated and all pipeline, fragment, skill, hook, gate, and script packages are written into `config/`.
4. You are ready to run workflows.

Alternatively, open the web UI and click **Bootstrap** on the Store page.
