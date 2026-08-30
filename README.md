# DSH Feedback Bridge

**中文名称：DSH 社区反馈**

DSH Feedback Bridge 是一个 DeepSeek Harness 插件，帮助你把插件需求、功能建议、错误情况和其他意见整理成清晰的社区反馈。你可以先检查和修改最终内容，再将其提交到 DeepSeek Harness 官方 GitHub Discussions，或者导出为 Markdown 文件后手动提交。

## 主要功能

- 从 DSH Web 左侧栏的“社区反馈”进入。
- 从当前对话中选择需要使用的消息和诊断信息。
- 使用当前对话选择的模型协助整理反馈。
- 查找可能相关的官方 Discussions、插件和文档。
- 使用中文或英文编辑并预览最终内容。
- 复制或导出准确的 Markdown 草稿。
- 通过 GitHub 登录或本机 GitHub CLI 账号提交。
- 每次提交前显示最终内容和 GitHub 账号，并要求明确确认。
- 自动保存未完成的草稿，在刷新页面或重启 DSH 后恢复。
- 在本地保存成功提交的链接，方便以后重新打开。

## 系统要求

- DeepSeek Harness `>=0.1.1-rc.2 <0.2.0`
- DSH `web` profile
- WSL2 Ubuntu 或 Windows

WSL2 Ubuntu 是主要测试环境。Windows 支持相同的产品功能。

## 安装

直接通过 DSH 从 npm 安装：

```sh
dsh plugin --profile web add dsh-feedback-bridge
```

然后启动 DSH Web：

```sh
dsh --profile web --no-open --port 3080
```

打开 DSH Web，在左侧栏点击“社区反馈”。

安装指定版本：

```sh
dsh plugin --profile web add dsh-feedback-bridge@0.1.0
```

如果无法访问 npm，也可以从 [GitHub Releases](https://github.com/yx222yx/DSH-Feedback-Bridge/releases) 下载 `dsh-feedback-bridge-0.1.0.tgz`，然后运行：

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.0.tgz
```

## 使用方法

1. 打开“社区反馈”。
2. 填写反馈内容，或者选择当前对话中的相关信息。
3. 根据需要使用模型整理内容并检查相似结果。
4. 检查最终预览，删除不希望公开的信息。
5. 复制或导出 Markdown 草稿，或者登录 GitHub 后直接提交。
6. 直接提交前，再次确认公开内容和所使用的 GitHub 账号。

插件只会向 `deepseek-ai/deepseek-harness` 官方 Discussions 提交，不会创建 GitHub Issue，也不会向其他仓库提交。

## GitHub 授权

发布包默认提供两种方式：

- **Sign in with GitHub**：适合普通用户。插件会显示 GitHub 的设备登录页面和一次性代码，不需要 Client Secret 或项目服务器。
- **GitHub CLI**：适合已经使用 `gh auth login` 登录的用户。

GitHub 授权过期时，插件会尝试自动续期。无法续期时会要求重新登录，草稿不会丢失。

如果只需要导出草稿，可以在 DSH profile 配置中设置：

```yaml
github:
  auth:
    provider: none
```

## 隐私说明

- 只有你确认选择的对话内容才会用于模型辅助整理。
- 提交前可以查看和修改所有公开内容。
- 插件不会自动提交；每次写入 GitHub 都需要单独的最终确认。
- 草稿和提交链接保存在本地 `<DSH_HOME>/dsh-feedback-bridge/`。
- GitHub access token 和 refresh token 只在 DSH Host 端使用，不会发送给模型或浏览器客户端。
- DSH 本地凭据存储不等同于操作系统级安全存储。
- 相似性检查会读取官方 Discussions、插件信息和允许访问的官方文档。
- 隐私提醒只提供建议，不会自动删除或改写内容。

## 当前限制

- v0.1 只支持 DSH Web。
- 同一时间只保存一份未完成草稿。
- 只提交到官方 DeepSeek Harness Discussions。
- 本地提交记录只保存链接和基本信息，不跟踪后续回复或状态。
- 不支持向第三方插件仓库提交反馈。

## 开发

生产代码使用 TypeScript，位于 `src/`；`lib/` 是构建产物。

```sh
pnpm install
pnpm typecheck
pnpm test
```

本项目使用 [MIT License](LICENSE)。

---

## English

DSH Feedback Bridge is a DeepSeek Harness plugin for turning plugin requests, feature ideas, bug reports, and other suggestions into clear community feedback. You can review and edit the final content before submitting it to the official DeepSeek Harness GitHub Discussions, or export it as Markdown for manual submission.

### Features

- Open “社区反馈” from the DSH Web sidebar.
- Select relevant messages and diagnostic information from the current conversation.
- Use the model already selected in the conversation to improve the draft.
- Find possibly related official Discussions, plugins, and documentation.
- Prepare and preview feedback in Chinese or English.
- Copy or export the exact Markdown draft.
- Submit through GitHub Device Flow or an existing GitHub CLI login.
- Review the final content and GitHub account before every submission.
- Restore an unfinished draft after a page refresh or DSH restart.
- Reopen successfully submitted Discussions from local records.

### Requirements

- DeepSeek Harness `>=0.1.1-rc.2 <0.2.0`
- DSH `web` profile
- WSL2 Ubuntu or Windows

WSL2 Ubuntu is the primary test environment. Windows supports the same product behavior.

### Install

Install directly from npm through DSH:

```sh
dsh plugin --profile web add dsh-feedback-bridge
```

Then start DSH Web:

```sh
dsh --profile web --no-open --port 3080
```

Open DSH Web and select “社区反馈” from the sidebar.

To install a specific version:

```sh
dsh plugin --profile web add dsh-feedback-bridge@0.1.0
```

If npm is unavailable, download `dsh-feedback-bridge-0.1.0.tgz` from [GitHub Releases](https://github.com/yx222yx/DSH-Feedback-Bridge/releases) and run:

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.0.tgz
```

### Use

1. Open “社区反馈”.
2. Enter the feedback or select relevant information from the current conversation.
3. Optionally use the selected model to improve the draft and check related results.
4. Review the final preview and remove anything you do not want to publish.
5. Copy or export the Markdown, or sign in to GitHub and submit it directly.
6. Before direct submission, confirm the public content and GitHub account again.

The plugin submits only to the official `deepseek-ai/deepseek-harness` Discussions. It does not create GitHub Issues or submit to other repositories.

### GitHub authorization

The release package enables two methods by default:

- **Sign in with GitHub** uses GitHub Device Flow. It requires no Client Secret or project-operated server.
- **GitHub CLI** uses an account already authorized through `gh auth login`.

The plugin renews an expiring GitHub authorization when possible. If renewal is no longer possible, it asks you to sign in again without losing the draft.

For an export-only installation, set this in the DSH profile configuration:

```yaml
github:
  auth:
    provider: none
```

### Privacy

- Only conversation sources you confirm are used for model-assisted drafting.
- All public content remains visible and editable before submission.
- The plugin never submits automatically; every GitHub write requires a separate final confirmation.
- Drafts and submission links are stored under `<DSH_HOME>/dsh-feedback-bridge/`.
- GitHub access and refresh tokens remain on the DSH Host and are never sent to the model or browser client.
- DSH local credential storage is not an operating-system security boundary.
- Similarity checks read official Discussions, plugin information, and allowlisted official documentation.
- Privacy findings are advisory and never remove or rewrite content automatically.

### Current limitations

- v0.1 supports only DSH Web.
- Only one unfinished draft is stored at a time.
- Direct submission targets only the official DeepSeek Harness Discussions.
- Local submission records store links and basic details; they do not monitor later replies or status changes.
- Third-party plugin repositories are not supported.

### Development

TypeScript production source is stored in `src/`. The `lib/` directory is generated.

```sh
pnpm install
pnpm typecheck
pnpm test
```

This project is licensed under the [MIT License](LICENSE).
