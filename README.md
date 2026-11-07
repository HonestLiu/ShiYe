# 拾页 · 稍后读与离线存档

桌面版：新扩展 `exporter-extension` 1.9.2 配合[拾页客户端 0.16.8](desktop-client/README.md)，支持正文富文本编辑、草稿与历史恢复、一次保存原貌快照与正文、客户端切换阅读、整页离线收藏、划词高亮、阅读笔记、选区/图片/链接收藏与 PDF 导出，无需启动下面的 Python 服务。PDF 弹窗选择“拾页客户端”默认后台生成并由浏览器下载，也可在客户端设置为应用选择保存位置；选择“PDF 服务”才使用本机/远程 HTTP 服务。以下为原服务版的部署说明。

将 ChatGPT 对话导出为 PDF、Markdown、TXT、CSV、JSON，或复制到剪贴板。PDF 渲染、图片处理、设置备份与导出记录由本机或自行部署的服务器完成，无需原开发商的服务器、账号或订阅。

项目基于原扩展 `6.13.2` 构建独立副本，当前版本标记为 **Service 4.1.2（Long webpage capture）**。支持 macOS 本机运行，以及 Linux 独立服务器部署。

## 长对话导出（4.1）

此前“部分已选消息尚未在网页中加载”的错误发生在扩展前端：它要求每条消息同时匹配到网页节点，尚未提交 PDF 内容就会终止。长对话的虚拟列表、旧/新消息结构混用及嵌套消息 ID 都可能触发该判断。

4.1 合并识别这些节点，按消息 ID 索引匹配，并尝试滚动逐段捕获、恢复原滚动位置。当前 DOM 中确实不存在的消息，使用完整会话 Markdown 补全，由同一个 Chromium 引擎排版；支持标题、表格、代码与 KaTeX 公式，无需手动切换 Pandoc。4.1.2 修正滚动容器识别，允许跨越超长回答与未选中消息，向下遍历后再反向检查，并等待末尾延迟加载；采集安全上限为 5 分钟。仍有缺失时先显示数量并询问是否接受会话正文重新排版，取消则不提交导出。后台任务中也保留网页捕获/会话补全统计。若网页和会话数据两边都无法读取某条消息，会明确报告序号，不静默跳过。

网页独有的交互图表需要在页面可读取时才能保留；会话补全的排版与网页可能不同。目录页仍默认关闭，标题书签保留。

大载荷自动拆为每块 512 KiB 上传，避免单条扩展消息或 HTTP 请求的大小限制；默认总载荷上限为 256 MiB。服务端默认提供 600 秒渲染时间，前端等待任务最长 30 分钟；PDF/HTML 文件以流式方式下载。上限是载荷大小，并非保证任意页数和图片数量都能在固定时间内完成。

本机升级：先运行 `npm --prefix local-pdf-server ci --ignore-scripts` 安装新增依赖，停止并重新启动服务，再在扩展管理页重新加载 `local-extension`，刷新 ChatGPT 页面。

回归检查覆盖 1,000 条消息、162 页 PDF、1,000 个标题书签及每条正文结尾；另有循环复用 3 个节点的虚拟列表捕获、70 MiB 载荷重组和完整服务链路检查。运行命令：

```sh
node local-pdf-server/verify-long-conversation.mjs
python3 local-pdf-server/verify-transfers.py
```

## 功能

- **网页原貌 PDF**：冻结选中回答的网页样式，使用本机 Chromium 渲染，保留字体、公式、代码、表格和 SVG 图示的位置与样式。
- **标题导航**：识别回答中的 H1–H6 标题，生成分级 PDF 书签；可选生成可点击的目录页。
- **Pandoc 排版**：使用 Pandoc + XeLaTeX 重新排版，适合 Markdown 和打印文档。
- **Web 管理后台**：查看任务与用量，下载历史 PDF/HTML 快照，上传或粘贴 Markdown 生成 PDF，管理偏好、资料、备份、选择器和反馈。
- **其他导出格式**：复用扩展原有的消息选择、Markdown、TXT、CSV、JSON 和剪贴板功能。
- **持久化记录**：任务、文件及设置保存在配置的服务器，服务重启后仍可查看和下载。

成功提示仅保留结果说明和“完成”按钮，适配明暗主题；可按 Esc 或点击遮罩关闭。文件导出提示浏览器已接收下载，剪贴板导出提示可以粘贴，原有静默提示设置继续生效。[浅色预览](output/ui/success-dialog-4.1.1-light.png) · [深色预览](output/ui/success-dialog-4.1.1-dark.png)

## Linux 独立服务器部署

推荐使用 Docker Compose，镜像包含 Chromium、Pandoc、XeLaTeX 和中文字体。部署配置和完整操作步骤见 **[Linux / Docker 部署指南](deploy/README.md)**。

```sh
cp .env.example .env
# 编辑 .env：填写服务器 URL 与随机访问令牌后启动
docker compose pull
docker compose up -d
```

镜像地址：`ghcr.io/honestliu/chatgpt-exporter-server:latest`。首次需将仓库工作流推送到 GitHub、通过测试并发布镜像；尚未发布时可以先 `docker build -t chatgpt-exporter-server:local .`，将 `.env` 的 `EXPORTER_IMAGE` 改为该名称，再执行 `docker compose up -d --pull never`。

GitHub Actions 在 PR 上构建和测试；默认分支、版本标签和手动触发通过后向 GHCR 发布 amd64/arm64 镜像，同时提供扩展 ZIP 构建产物。未配置匿名访问的私有镜像包需要先登录 GHCR。

在插件弹窗打开“**服务设置 → 服务器连接**”，填写服务器 URL 和访问令牌，点击“保存并连接”并允许访问所填域名。PDF 导出窗口也提供“配置服务器连接”入口。默认地址仍为 `http://127.0.0.1:8765`。

## 快速开始

以下命令均在项目根目录执行。

### 1. 准备依赖

| 用途 | 依赖 |
| --- | --- |
| 本地 HTTP 服务、Web 后台、SQLite 存储 | Python 3，服务代码仅使用标准库 |
| 网页原貌 PDF | Node.js、Chrome/Chromium、`playwright-core` |
| Pandoc PDF、后台 Markdown 转 PDF | Pandoc、XeLaTeX、可用的中文字体及所需 TeX 宏包 |

安装项目锁定版本的 `playwright-core`：

```sh
npm --prefix local-pdf-server ci --ignore-scripts
```

当前声明的版本为 `1.58.2`。渲染器使用已有的 Chrome/Chromium，无需下载 Playwright 的附加浏览器。若未在项目目录安装依赖，代码也会尝试复用本机 `rea-agents` 目录中已有的 `playwright-core`。

仅使用网页原貌模式不需要 Pandoc 或 XeLaTeX。仅有 Pandoc 则不足以生成 PDF：本项目的 Pandoc 模式还依赖 XeLaTeX。[字体配置](local-pdf-server/header.tex) 在 macOS 使用系统字体，在 Linux 使用 Noto CJK；官方镜像已安装这些字体和 GIF/WebP 转换所需的 Pillow。

### 2. 启动本地服务

macOS 可直接双击 `local-pdf-server/start.command`，或执行：

```sh
./local-pdf-server/start.command
```

也可以使用 Python 启动；此时请确保 Node、Pandoc 和 XeLaTeX 等所需程序在 `PATH` 中：

```sh
python3 local-pdf-server/server.py
```

保持启动终端打开，在该终端按 `Ctrl+C` 停止服务。

- Web 管理后台：<http://127.0.0.1:8765/>
- 健康检查：<http://127.0.0.1:8765/health>

```sh
curl http://127.0.0.1:8765/health
```

健康接口的 `version: 4` 是服务接口版本。`available` 表示依赖已找到；Chromium 的 `startupVerified` 表示最近一次渲染结果成功。实际任务是否完成，以导出结果和任务状态为准。启用访问令牌时，健康接口也需要登录会话或 `Authorization: Bearer <令牌>` 请求头。

### 3. 加载浏览器扩展

1. 打开 Chrome 的 `chrome://extensions` 页面并启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择项目中的 **`local-extension`** 目录。
3. 关闭原版扩展，避免重复出现导出按钮。
4. 刷新 ChatGPT 页面，选择消息并开始导出。

`6.13.2_0` 是保留的原始扩展目录，实际使用的是 `local-extension`。已有本地版时，点击“重新加载”即可，无需删除后重新安装。

## PDF 导出

### 网页原貌模式（默认）

在 ChatGPT 页面选择消息，打开 PDF 导出窗口，选择“网页原貌（推荐）”。扩展捕获已选消息当前的 DOM 和计算样式，嵌入图片、画布及可读取字体，再交给本机 Chromium 输出 PDF。

页面中的 SVG 由浏览器直接渲染，保留在对应正文位置。纸张、方向、页边距、页码及按提问分页等选项用于 PDF 输出；字体、颜色和正文样式跟随网页。PDF 存在纸张分页，不能保证与连续滚动网页逐像素一致。

优先保留页面中已渲染的选中消息。长对话会尝试滚动收集节点，经用户确认后才用会话内容补全仍缺失的消息；详情见上方“长对话导出”。

### 标题书签与目录页

- **标题书签始终生成**，可在支持书签的 PDF 阅读器侧栏中分级浏览并点击跳转。
- **目录页默认关闭**，默认导出直接从正文开始。需要额外目录页时，在导出设置中打开“目录”；也可在 Web 后台修改该偏好。
- 同名标题具有各自的跳转目标。普通加粗文字、代码块、用户提问及隐藏的角色标签不计入回答标题。

回答本身需要包含标题。例如，可以要求 ChatGPT：

> 请使用 Markdown 的 # 一级标题、## 二级标题和 ### 三级标题组织回答。

扩展读取网页实际渲染的标题，不会自动改写回答。上述 H1–H6 分级导航适用于网页原貌模式。首次从旧版本升级到目录可选版时，会关闭一次旧的目录默认值，之后记住用户手动选择。

### Pandoc 模式

在 PDF 导出窗口选择“Pandoc 排版”，或在 Web 后台上传、粘贴 Markdown 后生成 PDF。该模式重新排版正文，支持中文、公式、代码、表格及已上传的图片，效果与网页原貌模式不同。

Web 后台的 Markdown 转 PDF 使用 Pandoc，不能替代 ChatGPT 页面中的网页原貌捕获。

## Web 管理后台

服务启动后，直接打开 <http://127.0.0.1:8765/>，无需从扩展内部进入。

| 功能 | 说明 |
| --- | --- |
| 导出记录 | 查看最近 100 个 PDF 任务、状态、生成时间和错误；处理中任务自动刷新 |
| 文件下载 | 下载已完成 PDF，以及网页原貌任务保存的 HTML 快照 |
| 生成 PDF | 读取 `.md`、`.markdown`、`.txt` 文件或粘贴正文，使用 Pandoc 生成 PDF |
| 导出偏好 | 修改默认引擎和目录页开关 |
| 设置备份 | 下载和导入 JSON 格式的导出设置 |
| 本地资料与配置 | 修改显示名称、邮箱和页面选择器覆盖 |
| 反馈记录 | 将问题和建议保存在本机，供自己查看 |

后台保存的导出偏好会在刷新 ChatGPT 页面或重新打开扩展时同步。浏览器中尚未同步的本地修改优先保留，并会再次备份到本机服务。升级扩展后需重新加载扩展，才能使用新版同步逻辑。

## 数据保存与网络访问

原生运行默认数据目录是 `local-pdf-server/data/`，Docker 使用 `/data` 数据卷：

```text
data/
├── local.sqlite3          # 资料、设置、用量、反馈及任务状态
├── files/                 # 上传的图片
├── uploads/               # 大载荷分块上传的临时数据
└── jobs/
    └── <jobId>/
        ├── document.pdf   # 成功生成的 PDF
        └── original.html  # 网页原貌任务的静态快照
```

文件不会在服务退出时自动删除。备份完整数据时，先停止服务，再复制整个数据目录。浏览器设置与服务端备份分别存储；Web 后台的“下载设置备份”只导出设置，不包含历史 PDF、图片或聊天快照。

分块上传的临时数据在提交或取消后删除。中断上传超过一小时后，会在后续新建上传时清理。

选中的聊天内容和导出所需图片会发送到你配置的服务器，PDF 和记录保存在该服务器；默认配置使用本机。扩展不使用原开发商的后台或遥测服务。读取未加载的对话、附件和图片仍需要访问 ChatGPT；为嵌入导出资源，扩展还会读取 OpenAI 的静态字体和图片域名。冻结网页交给 Chromium 渲染时，页面脚本和网络访问均被禁用。服务访问令牌不附带到 OpenAI 资源请求中，也不写入设置备份。

默认仅监听 `127.0.0.1`；远程监听必须配置公开 URL 和访问令牌，部署方式见指南。服务校验 Host 和请求 Origin，Web 写操作验证 CSRF 令牌；API 支持 Bearer 鉴权，Web 后台支持登录会话，文件下载使用短时签名链接。静态路由只开放指定资源。每个实例共用资料与导出记录，不提供多用户隔离。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `LOCAL_EXPORT_DATA_DIR` | 自定义持久化数据目录 |
| `LOCAL_EXPORT_CHROMIUM_EXECUTABLE` | Chrome/Chromium 可执行文件路径 |
| `LOCAL_EXPORT_PLAYWRIGHT_MODULE` | `playwright-core` 模块目录 |
| `LOCAL_EXPORT_NODE` | Node.js 可执行文件路径 |
| `LOCAL_EXPORT_HOST` / `LOCAL_EXPORT_PORT` | 监听地址与端口，原生运行默认 `127.0.0.1:8765` |
| `LOCAL_EXPORT_PUBLIC_URL` | 浏览器和扩展访问的完整 origin，反代部署时用于校验请求和生成下载地址 |
| `LOCAL_EXPORT_API_TOKEN` | 服务访问令牌，非本机监听时至少 24 字符 |
| `LOCAL_EXPORT_MAX_PAYLOAD_MB` | 分块导出的总载荷上限，默认 256 MiB |
| `LOCAL_EXPORT_RENDER_TIMEOUT_SECONDS` | 单次渲染时间上限，默认 600 秒 |

例如，将数据存放到其他目录：

```sh
LOCAL_EXPORT_DATA_DIR="$HOME/ChatGPTExporterData" ./local-pdf-server/start.command
```

服务支持 `--host`、`--port`。端口或域名变化后，在扩展的“服务器连接”中更新 URL；服务端还应同步修改 `LOCAL_EXPORT_PUBLIC_URL`。服务地址只支持根 origin，不支持 `/exporter/` 等子路径部署。

## 更新与开发

修改本地扩展的源文件后，重新生成扩展副本：

```sh
python3 local-pdf-server/prepare_extension.py --update
```

该脚本读取 `6.13.2_0`，应用补丁并覆盖 `local-extension`，不会修改原始包或服务数据。直接修改生成目录中的文件会在下次生成时被覆盖。

更新后按顺序操作：停止并重新启动服务，在扩展管理页重新加载本地扩展，再刷新 ChatGPT 页面。继续使用同一个 `local-extension` 路径，以保留现有扩展身份和浏览器设置。若原始扩展版本变化，需要重新检查补丁匹配，不能直接套用。

### 目录结构

| 路径 | 内容 |
| --- | --- |
| `6.13.2_0/` | 原始扩展包 |
| `local-extension/` | 生成的、实际加载到浏览器的本地版扩展 |
| `local-pdf-server/server.py` | 本地 HTTP 服务、任务接口、下载与 Web 静态资源 |
| `local-pdf-server/local.html` / `local.js` / `local.css` | Web 后台与扩展内部管理页的共用界面 |
| `local-pdf-server/extension-*.js` | 本地扩展通信桥接与后台实现 |
| `local-pdf-server/web-snapshot.js` | 网页内容和资源冻结 |
| `local-pdf-server/chromium_renderer.py` / `render-webpage.mjs` | Chromium PDF 渲染 |
| `local-pdf-server/web-heading-navigation.mjs` | 标题识别和可点击目录生成 |
| `local-pdf-server/pdf_layout.py` / `header.tex` | Pandoc/XeLaTeX 排版 |
| `Dockerfile` / `compose.yaml` / `deploy/` | Linux 镜像、Compose、反代示例和部署指南 |
| `.github/workflows/docker.yml` | 测试、打包扩展及多架构镜像发布 |
| `output/pdf/` | 回归检查与预览 PDF，不是日常任务存储目录 |

### 验证命令

```sh
# 扩展语法、桥接、图片恢复、设置同步
node local-pdf-server/verify-extension.mjs

# 网页快照与渲染器边界检查
node local-pdf-server/verify-web-snapshot.mjs
node local-pdf-server/verify-web-runner.mjs
python3 local-pdf-server/verify-chromium.py

# 真实 HTTP 与浏览器：后台表单、PDF/快照下载、重启后历史
node local-pdf-server/verify-web-admin.mjs

# 真实 Chromium：分隔线、书签层级与目录内部跳转
node local-pdf-server/verify-divider-browser.mjs
node local-pdf-server/verify-heading-navigation.mjs

# 真实 Pandoc/XeLaTeX：排版、图片及服务接口
python3 local-pdf-server/verify.py
```

真实浏览器检查需要可启动的 Chrome/Chromium 和 Playwright 模块；标题导航检查还使用 macOS Swift/PDFKit。Web 后台集成检查使用临时端口和隔离数据目录。Pandoc 回归检查会更新 `output/pdf/` 下的演示文件。

## 常见问题

**后台无法打开或扩展提示连接失败**：确认服务终端仍在运行，访问 `http://127.0.0.1:8765/health`。若提示端口已占用，检查是否已有旧服务，先停止旧服务再启动新版。

**找到了 Chromium，但 PDF 仍生成失败**：`available` 只表示依赖存在。到后台查看任务错误，检查可执行文件、Node 和模块路径。保留的 HTML 快照可用于排查内容问题。

**图片或部分消息缺失**：4.1.2 会先遍历采集网页，仍缺失时征得确认后才用会话正文补全，任务详情可查看补全数量。仅存在于网页中的图表仍需页面可读取；已经失效的 `blob:` 引用或无法读取的资源可能无法恢复。消息完全不可读取时会报出具体序号。

**PDF 最前面多了目录页**：关闭导出设置中的“目录”，或在后台取消“在正文前生成目录页”。PDF 侧栏书签会继续保留。

**后台修改设置后扩展没变化**：重新加载新版扩展并刷新 ChatGPT 页面。如果浏览器中存在尚未同步的修改，会优先保留该修改。

**想让 PDF 与网页完全一致**：选择网页原貌模式最接近当前页面。纸张分页、超宽内容、特殊交互组件和字体资源仍可能造成差异。

服务实现和历次修复记录见 [服务目录说明](local-pdf-server/README.md)。原包、本地副本及发布状态见 [扩展说明](CHROMEWEBSTORE.md)；未申请 Chrome Web Store 上架。
