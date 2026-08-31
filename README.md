# DSH Feedback Bridge

**中文名称：DSH 社区反馈**

DSH Feedback Bridge 是一个 DeepSeek Harness 插件，帮助你把插件需求、功能建议、错误情况和其他意见整理成清晰的社区反馈。你可以先检查和修改最终内容，再将其提交到 DeepSeek Harness 官方 GitHub Discussions，或者导出为 Markdown 文件后手动提交。

## 主要功能

- 从 DSH Web 左侧栏的“社区反馈”进入。
- 主界面直接呈现反馈文本编辑与预览；**反馈来源**和**模型辅助建议**是顶部按钮式入口，分别进入独立页面。
- **反馈来源**按“一次完整交流”分组：以你的一句话开始、到模型完整输出结束（工具结果与报错并入该交流）作为一条可引用的来源，而不是逐条列出每次交互；支持筛选、确认、移除与引用到字段。
- 每个字段文本框都较小，带**展开**按钮可进入大编辑页面。
- 使用当前对话选择的模型协助整理反馈；**相似性检查**作为操作行按钮，点击弹出结果对话框。
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
dsh plugin --profile web add dsh-feedback-bridge@0.1.3
```

如果无法访问 npm，也可以从 [GitHub Releases](https://github.com/yx222yx/DSH-Feedback-Bridge/releases) 下载 `dsh-feedback-bridge-0.1.3.tgz`，然后运行：

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.3.tgz
```

## 使用方法

1. 打开“社区反馈”，主界面是反馈文本编辑区与预览。
2. 点顶部 **反馈来源** 进入来源页：来源按一次完整交流分组，可筛选、确认或移除；确认后引用到字段或直接填写。
3. 点顶部 **模型辅助建议** 进入建议页，使用当前对话选择的模型生成建议（类型推荐、缺失信息、逐字段应用）。
4. 填写或展开任一字段进入大编辑页；相似性检查在底部操作行，点击弹出结果对话框。
5. 检查最终预览，删除不希望公开的信息。
6. 复制或导出 Markdown 草稿，或者登录 GitHub 后直接提交；直接提交前再次确认公开内容和所使用的 GitHub 账号。

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
- The main view shows the feedback text editing and preview directly; **Feedback sources** and **Model-assisted suggestions** are button entries at the top that open their own pages.
- **Feedback sources** are grouped as one full exchange: from your prompt through the model's complete reply (tool results and errors folded in) is one citable source, instead of listing every interaction row; they can be filtered, confirmed, removed, and quoted into fields.
- Every field is compact with an **expand** button that opens a large editing page.
- Use the model already selected in the conversation to improve the draft; **Similarity check** is an action-row button that opens a results dialog.
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
dsh plugin --profile web add dsh-feedback-bridge@0.1.3
```

If npm is unavailable, download `dsh-feedback-bridge-0.1.3.tgz` from [GitHub Releases](https://github.com/yx222yx/DSH-Feedback-Bridge/releases) and run:

```sh
dsh plugin --profile web add ./dsh-feedback-bridge-0.1.3.tgz
```

### Use

1. Open “社区反馈”; the main view is the feedback text editing area with a live preview.
2. Open **Feedback sources** from the top entry: sources are grouped as one full exchange per prompt, filterable, and can be confirmed, removed, or quoted into fields.
3. Open **Model-assisted suggestions** from the top entry to generate suggestions (type recommendation, missing-info notes, per-field apply) with the conversation's selected model.
4. Fill the fields or expand any field into a large editing page; run the **Similarity check** from the footer actions to open the results dialog.
5. Review the final preview and remove anything you do not want to publish.
6. Copy or export the Markdown, or sign in to GitHub and submit it directly; before direct submission, confirm the public content and GitHub account again.

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
