# ChatGPT Exporter 本地服务版

> 当前版本已支持 Linux、Docker 和独立服务器。安装入口见[根目录 README](../README.md)，远程部署及访问令牌配置见 [Linux / Docker 指南](../deploy/README.md)。本文件同时保留较早版本的实现与修复记录。

在原版 `6.13.2_0` 的基础上构建独立副本 `local-extension`，原版文件保持不变。PDF、图片、账号状态、用量、配置、设置备份与反馈均使用本机服务；Markdown、TXT、CSV、JSON 和剪贴板继续由浏览器生成。无需原开发商的服务器、登录或订阅。

网页原貌模式使用本机 Python 3、Node.js、现有 Chrome/Chromium 和 playwright-core。当前机器已找到 Node、Google Chrome 和已有的 playwright-core 1.58.2，无需重新下载浏览器。Pandoc 模式使用 Pandoc 3.13、XeLaTeX 和 macOS 系统字体。

## Web 管理后台（3.4）

启动服务后，直接用浏览器打开 **http://127.0.0.1:8765/**。无需从扩展页面进入，也不需要额外安装前端依赖。

- 查看服务/引擎状态、用量、最近 100 个 PDF 任务及生成错误；处理中任务自动更新。
- 下载历史 PDF 或已冻结的 HTML 快照，服务重启后仍可查看记录。
- 粘贴 Markdown 或读取 `.md` / `.txt` 文件，直接使用 Pandoc 生成 PDF；本次目录页默认关闭。
- 保存默认引擎和目录页开关、资料、选择器、设置备份与反馈。网页原貌捕获仍从 ChatGPT 扩展发起。

Web 后台保存的导出偏好会在刷新 ChatGPT 页面或重新打开扩展时同步。浏览器尚未同步的本地修改优先，以免被远端快照覆盖；随后本地修改会备份回本机服务。扩展内部的管理页与浏览器后台共用界面和数据库。

后台仍只监听 127.0.0.1。静态资源仅开放 HTML/JS/CSS 白名单，写操作验证同源及页面 CSRF 令牌，扩展请求沿用原有通信方式；数据库与源码路径不会通过 Web 开放。

```sh
node local-pdf-server/verify-web-admin.mjs
```

该检查启动临时端口和隔离数据库，用真实 Chromium 验证表单、Markdown 上传、PDF 与快照下载、窄屏布局及重启后的历史记录，不写入日常服务数据。

## 网页原貌模式（Local Service 3）

PDF 默认使用“网页原貌”，也可以在 PDF 对话框或本地管理页切换“Pandoc 排版”。网页原貌捕获已选消息当前的 DOM，冻结计算后的字体、颜色、间距、公式和代码样式，将图片、画布和可读取的网页字体打包为数据资源，然后由本机 Chromium 输出 PDF。SVG 保持浏览器矢量渲染，不再经过 Markdown/LaTeX。

Chromium 使用 screen 媒体、打印背景并等待字体和图片就绪；按原文宽度排版后缩放到纸张可打印宽度。纸张、方向、页边距、页码、目录及每问分页生效，字体、字号、配色、正文内容跟随网页；额外用户/时间等排版元信息请使用 Pandoc 模式。PDF 仍有纸张分页，与连续网页不会逐像素完全相同。

### 分级标题导航（3.2）

网页原貌模式自动识别回答中已渲染的 H1–H6 和语义标题，保留层级并生成 PDF 侧栏书签。“目录”开关默认关闭，不增加目录页；用户主动打开后，才会在正文前插入可点击的分级目录。关闭开关仍保留书签。3.3 首次升级会关闭一次旧版本的目录默认值，之后保留用户手动选择。链接直接定位到标题，同名标题各自有独立目标。用户提问、代码块、隐藏的角色标签和普通加粗文本不作为回答标题。

回答本身需要包含标题：可要求 ChatGPT“请用 Markdown 的 # 一级标题、## 二级标题、### 三级标题组织回答”。扩展读取网页实际标题，不会按字号猜测或自动改写回答。本次分级标题导航适用于“网页原貌”模式。

真实 Chromium 导航回归检查（macOS PDFKit 验证书签与内部跳转目标）：

```sh
node local-pdf-server/verify-heading-navigation.mjs
```

仅捕获已经在页面中渲染的已选消息。若消息未加载，明确提示滚动加载或切换 Pandoc，不会静默丢掉消息或改用另一种引擎。为保留页面字体/图片，扩展额外允许读取 OpenAI 的 oaistatic.com、oaiusercontent.com 和 cdn.openai.com 静态资源；后台补取资源不携带登录凭据。原开发商服务和遥测仍不使用。

### 升级步骤

1. 停止旧服务，再双击 start.command 启动新版；健康接口应返回 version:4 和 supportsWebDocument:true。
2. 在扩展管理页重新加载同一个 local-extension 目录；浏览器如提示静态资源访问权限，按提示启用更新后的扩展。
3. 刷新 ChatGPT 页面，选中消息，打开 PDF 对话框，选择“网页原貌（推荐）”。

### 依赖与启动诊断

优先使用 local-pdf-server/node_modules/playwright-core；未安装时可复用本机现有 rea-agents 的 playwright-core。若两处均不存在，可在 local-pdf-server 目录执行 npm install --ignore-scripts 安装锁定的 playwright-core，使用现有 Chrome，不下载附加浏览器。

可配置环境变量：LOCAL_EXPORT_CHROMIUM_EXECUTABLE（Chrome/Chromium 可执行文件）、LOCAL_EXPORT_PLAYWRIGHT_MODULE（playwright-core 模块目录）、LOCAL_EXPORT_NODE（Node 路径）。默认 start.command 已补充 ~/.local/bin。

健康接口的 available 只说明依赖文件已找到，startupVerified 才说明实际成功生成过 Chromium PDF。此前受限执行沙箱中 Chrome 曾收到 SIGABRT；当前执行权限已更新，3.1 分隔线回归检查已使用开启沙箱的真实 Chromium 完成明暗主题和 PDF 渲染验证。依赖文件存在仍不等同于每个浏览器/网页都已验证，实际任务状态以导出结果为准。

网页任务在启动浏览器前保存经过清理的 original.html。即使 Chromium 启动失败，也可从本地管理页下载最近网页快照；脚本和事件属性已剔除，打开快照不会请求网络。两种引擎的错误和任务状态持久化在本机。

### 验证

```sh
node local-pdf-server/verify-web-snapshot.mjs
node local-pdf-server/verify-web-runner.mjs
python3 local-pdf-server/verify-chromium.py
```

快照检查覆盖选中消息隔离、原图位置、样式去重、字体和 blob 图片内嵌、控件和脚本清理、未加载消息报错。渲染边界检查覆盖字体/图片等待、原色背景、屏幕媒体、页宽缩放、浏览器沙箱、禁止页面脚本与网络、失败后快照恢复；测试用 mock 标识浏览器边界，不冒充实际渲染成功。

## 从第一版升级（历史说明）

1. 在原服务终端按 Control+C 停止旧服务，重新双击 `start.command`。
2. 在浏览器 `chrome://extensions` 找到已加载的本地版，点“重新加载”。不要删除再安装，浏览器设置会保留。
3. 刷新已有的 ChatGPT 页面，重新打开插件弹窗。
4. 从插件“本地账户”进入本地管理页面，确认连接状态。PDF 导出现在会显示完整的设置窗口。

需要重新生成副本时：

```sh
python3 local-pdf-server/prepare_extension.py --update
```

生成脚本校验补丁数量并在验证补丁匹配后更新生成目录。仅覆盖 `local-extension`，不会修改原版和服务数据。若后续原版升级，必须重新审查补丁。不要把 `local-extension` 目录改名，否则解压扩展的身份可能改变。

## 首次使用

双击 `local-pdf-server/start.command`，或执行：

```sh
cd /Users/lc/Develop/ChromeExt/ilmdofdhpnhffldihboadndccenlnfll
./local-pdf-server/start.command
```

保持终端打开；服务只监听 `127.0.0.1:8765`。在 Chrome/Helium 的扩展页开启开发者模式，加载项目中的 `local-extension`；关闭原版，避免重复按钮。刷新 ChatGPT 页面后使用。

```sh
curl http://127.0.0.1:8765/health
```

新版健康检查包含 `version: 4`。启用访问令牌时需携带 Bearer 令牌或 Web 登录会话。

## 功能对应

| 功能 | 本地实现 |
|---|---|
| 消息提取、选择、复制 | 保留原浏览器逻辑，支持当前页面与原有 API/DOM 回退路径 |
| Markdown、TXT、CSV、JSON | 保留原转换器、本地文件和剪贴板输出；成功后记录本机用量 |
| PDF | 默认冻结网页 HTML/CSS/字体/图片，交由本机 Chromium；可选 Pandoc + XeLaTeX 排版 |
| PDF 设置 | 纸张、横竖、窄/普通/宽边距、明暗、字号、默认/衬线/近似 Mono、页码、目录及角色目录配色、按提问分页、用户/时间/模型信息 |
| 图片 | 浏览器读取可访问图片后上传本机；支持 PNG/JPEG、GIF/WebP 静态转换，浏览器可将 SVG 栅格化；PDF 从本机文件库嵌入 |
| 账户/订阅入口 | 改为本地资料和能力说明；不连接原账号，不模拟付款或真实订阅 |
| 设置 | 仍保存在浏览器中，同时镜像至本机；新副本可恢复缺失设置；服务离线后的变更会在下次连通时重试同步 |
| 配置下发 | 从本机读取选择器覆盖，可在本地管理页修改 |
| 用量 | 本地 SQLite 统计，无远程配额 |
| 反馈、功能建议 | 存入本机记录，在本地管理页查看，不会提交给开发商 |
| 统计和遥测 | 删除原后台，停止前端统计初始化，并拦截原服务/遥测域名的 fetch、XHR、sendBeacon |

本地管理页还提供显示名称/邮箱、导出设置备份下载与导入、连接检查。原导出设置界面继续保留原有控件和保存行为。PDF 中显示姓名、邮箱和时间仍由相应设置控制。

## 数据与网络边界

数据默认位于 `local-pdf-server/data`：

- `local.sqlite3`：本地资料、配置、偏好、用量、反馈和任务状态。
- `files/`：内容哈希命名的上传图片。
- `jobs/`：生成的 PDF，服务重启后仍可查询和下载；转换源文件在任务结束后清理。

这些数据不会在退出时自动删除。可通过环境变量 `LOCAL_EXPORT_DATA_DIR` 指定其他存储目录。备份整个数据目录时先停止服务。浏览器中的设置与服务备份是两份数据。

SVG 修复版（Local Service 2.1）：UTF-8 百分号编码和 Base64 的 SVG data URL 都会先在浏览器转为 PNG，再上传本机嵌入 PDF；只有 viewBox、宽度为百分比的图也会按比例处理。DOM 导出会保留内联 SVG 图示，KaTeX 公式碎片和按钮图标继续走原处理方式。更新后重新加载本地扩展并刷新 ChatGPT 页面即可应用。

服务端不下载远程资源，不读取聊天引用的任意本地文件。聊天和图片来自浏览器当前可访问的内容，所以读取未加载消息、附件和图片仍需连接 ChatGPT；可选的外部文档/评价等链接仍可能由用户主动打开。扩展额外主机权限用于本机 API 和 OpenAI 的静态字体/图片资源；移除了开发商网站的脚本和外部消息连接。

服务校验 Host，接受扩展 Origin、无 Origin 的工具请求，以及配置的服务自身 Origin。Web 写操作需要 CSRF 令牌。远程监听需要公开 URL 和访问令牌；扩展通过后台转发至用户配置的服务器。远程实例的全部记录属于同一个信任域，部署配置见 Linux / Docker 指南。

## 兼容性范围

默认使用 Chromium 网页原貌模式，同时保留 Pandoc 排版，不能承诺与原服务器逐像素一致。复杂交互组件、任意字体、emoji、超宽表格和极长代码行仍可能需要调整。Pandoc 的 Mono 是中文字体的近似排版；GIF 只取静态帧。语言选项设置 PDF 语言元数据，不翻译聊天内容或安装缺失字体。

服务接收结构化 `messages`、`markdown` 或 `localMarkdown`；不是原服务器复杂 `contents`/HTML 渲染引擎的直接复刻。配套副本复用原转换器，转换后再交给本机服务。

## 实际网页漏图修复（2.2）

实际 ChatGPT DIL 渲染图可能只存在于页面，API 的 fallbackMarkdown 中没有对应图片。PDF 现在按已选消息及其分组消息 ID，补入对应渲染图；支持 data-dil-message-id 与 data-chatgpt-search-message-ids，不再只依赖旧的 section/data-turn-id。DOM 回退也兼容新消息结构。只选单条回答时只取该条的图，不扫描导出其他消息的图。

可用本机已安装的测试解析工具验证保存网页：

```sh
node local-pdf-server/verify-saved-html.mjs /absolute/path/to/saved-chat.html
```

该检查读取完整保存 HTML，执行真实 bridge 的消息识别/图片恢复逻辑，再以 macOS 图像渲染器生成 PNG、调用真实后端生成 PDF；它不是浏览器点击测试。测试解析依赖使用本机 rea-agents 已安装的 parse5/xmldom（可用 LOCAL_TEST_NODE_MODULES 指定目录），不增加扩展或服务运行依赖。回归样例输出在 output/pdf/actual-chat-diagrams.pdf。保存 HTML 内仅剩 blob: 引用的附件无法从文件离线恢复，内嵌 SVG data URL 可完整恢复。

## 图文原位排版（2.3）

从 API 正文恢复的图示，会根据网页中相邻的段落、标题和图注定位，插回对应文字之间，保留原图注在图片下方。定位时忽略 Markdown 样式和标点，并用前文区分重复的短句；正文中已有同一图时不再插入。若上下文无法可靠匹配，才保留在消息末尾，避免漏图或放进错误段落。PDF 的 figure 使用原位排版，不能放下时整体换页，不允许后文越过图片。实际保存网页的两张图已验证位于原图注之前、后续计算步骤之前。

## 分隔线修复（3.1）

网页分隔线使用 background-clip:content-box，让上下 padding 保持透明。快照现在同时保存 background-clip 与 background-origin，避免 1px 线条和上下各 8px 留白一起被涂成 17px 灰条；不改变段落间距。实际 Chromium 已复现修复前 17px 灰条，并验证明暗两种主题均恢复为 1px，普通 HR 不受影响，真实 PDF 渲染通过。可运行 node local-pdf-server/verify-divider-browser.mjs 复查。

## 接口

| 路径 | 请求 |
|---|---|
| `/health` | GET：依赖与版本 |
| `/api/account` | GET，或 POST `getinfo` / `update` 本地资料 |
| `/api/usage` | GET，或 POST `get` / `record`，记录的 `payload.format` 为 md/txt/csv/json；PDF 成功生成时由服务记录 |
| `/api/config/v3` | GET，或 POST `{cmd:"update",payload:{selectors:{...}}}` |
| `/api/settings` | GET，或 POST `{settings:{...}}`，仅接收导出偏好白名单 |
| `/api/feedback/v1` | GET 查看，POST 保存本地记录 |
| `/api/file/u/v1` | POST multipart `file` 图片，单张最多 16 MiB |
| `/api/file/<hash>.png或jpg` | GET 图片 |
| `/api/pdf/v1` | POST `{cmd:"create",payload:{markdown:"...",options:{...}}}` |
| `/api/pdf/v1/<jobId>` | GET 状态；完成后返回 `downloadUrl` |
| `/api/pdf/v1/<jobId>/download` | GET 下载 |

## 验证

```sh
python3 local-pdf-server/verify.py
node local-pdf-server/verify-extension.mjs
```

后端检查直接运行真实 HTTP 处理器和 Pandoc/XeLaTeX，不监听端口；覆盖持久化资料/配置/反馈/偏好、图片上传与读取、任务重启恢复、中文公式代码表格及图片 PDF、深色 A5 横向、目录与分页、错误来源和路径拒绝。前端检查覆盖生成包语法、对话框保留、后台转发、图片本地化、遥测拦截、断线恢复与设置重同步、非法备份保护。

样例位于 `output/pdf/local-export-demo.pdf` 与 `output/pdf/local-layout-demo.pdf`，排版示例已逐页检查。

Web 后台已经使用真实 HTTP 服务和 Chromium 验证表单、PDF/快照下载及重启恢复。验证脚本输出区分 mock 边界检查与真实渲染；通过这些检查不代表覆盖所有 ChatGPT 页面、交互组件和浏览器环境。
