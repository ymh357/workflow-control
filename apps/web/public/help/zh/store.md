# 配置商店

配置商店是 workflow-control 的配置资产包管理器。
你可以从中央仓库（GitHub 上的 `workflow-control-registry`）搜索、安装、更新和发布可复用的工作流构建模块。

已安装的包通过锁定文件（`apps/server/.wfctl-registry.lock`）追踪，
确保团队成员在 fresh clone 后获得相同的版本。

## 包类型

每个包都有一个**类型**，决定其文件在 `config/` 目录中的位置：

| 类型 | 配置路径 | 说明 |
|------|----------|------|
| `pipeline` | `config/pipelines/<name>/` | 完整的流水线定义（YAML + 提示词文件） |
| `skill` | `config/skills/<name>.md` | 独立技能提示词（单个 `.md` 文件） |
| `fragment` | `config/prompts/fragments/<name>.md` | 可复用的提示词片段，通过 `{{fragment:name}}` 注入 |
| `hook` | `config/hooks/<name>.yaml` | 生命周期钩子配置 |
| `gate` | `config/gates/<name>.ts` | Gate 脚本（TypeScript） |
| `script` | `config/scripts/<name>/` | 自定义脚本（含入口文件） |

包可以声明对其他包的**依赖**（skills、fragments、hooks、scripts）。
安装包时，所有依赖会被自动解析并安装。
此外，所有 `fragment` 类型的包始终会被安装，因为任何流水线都可能引用它们。

## CLI 命令

所有命令通过以下方式运行：

```bash
npx tsx src/cli/registry.ts <command> [args...] [--flags]
```

### search

搜索仓库中的包，可按关键词和包类型过滤。

```bash
registry search                     # 列出所有包
registry search "bugfix"            # 按关键词搜索
registry search --type=pipeline     # 按类型过滤
registry search "react" --type=fragment
```

搜索会匹配包名、描述和标签。

### install

从仓库安装一个或多个包。支持 `name` 或 `name@version` 语法。

```bash
registry install pipeline-generator
registry install claude-bugfix claude-text
```

- 依赖会被自动解析并安装。
- 无论安装什么包，所有 fragment 包都会一并拉取。
- 如果目标文件或目录已存在且不是由仓库安装的，安装会跳过以避免覆盖本地内容（使用 `bootstrap` 可强制覆盖）。

### update

将已安装的包更新到仓库中的最新版本。

```bash
registry update                # 更新所有已安装的包
registry update pipeline-generator  # 更新指定包
```

更新时，旧文件会被删除并替换为新版本。`.local/` 子目录中的文件会被保留，以确保你的本地覆盖在更新后仍然有效。

### list

列出当前已安装的包（锁定文件中记录的）。

```bash
registry list                  # 所有已安装的包
registry list --type=fragment  # 仅显示 fragment
```

### outdated

显示已安装但有新版本可用的包。

```bash
registry outdated
```

输出包名、已安装版本、最新版本和类型的表格。

### uninstall

移除已安装的包并清理相关文件。

```bash
registry uninstall claude-bugfix
registry uninstall skill-a fragment-b
```

文件移除后留下的空目录会被自动清理。

### publish

发布本地包到仓库。从 `config/` 目录收集相关文件，生成 `manifest.yaml`，
并通过 `gh` CLI 推送到仓库的 GitHub 存储库。
需要 `gh auth login` 认证（无需 `GITHUB_TOKEN`）。

```bash
registry publish <directory>
```

### bootstrap

从仓库安装所有官方包，覆盖任何现有文件。这是 fresh clone 后推荐执行的命令。

```bash
registry bootstrap
```

Bootstrap 以 `force: true` 调用 `install`，因此即使文件之前未被仓库追踪也会被覆盖。

## Web UI

Web 控制台中的**商店**页面提供了相同操作的图形界面：

- **浏览**所有可用包，支持类型过滤和关键词搜索。
- **安装**包，一键操作，依赖自动解析。
- **发布**本地配置包（流水线、技能、钩子等）到远程仓库。
- **Bootstrap** 在 fresh clone 后批量安装所有官方包。
- **查看**已安装的包及其版本。
- **检查更新**并升级过期的包。

本地包（通过 Config 页面创建但不在仓库中的）会显示 "local" 标记，
可以直接从商店页面发布。

## 锁定文件

`apps/server/.wfctl-registry.lock` 是一个 JSON 文件，记录每个已安装的包：

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

请将此文件提交到版本控制，以便所有协作者共享相同的包版本。

## Fresh Clone 的 Bootstrap 流程

首次克隆仓库后：

1. `npm install`（或 `pnpm install`）安装 Node 依赖。
2. `npx tsx src/cli/registry.ts bootstrap` 安装所有官方配置包。
3. 锁定文件被创建/更新，所有 pipeline、fragment、skill、hook、gate 和 script 包被写入 `config/`。
4. 即可开始运行工作流。

也可以打开 Web UI，在商店页面点击 **Bootstrap**。
