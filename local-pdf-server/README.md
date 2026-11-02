# ChatGPT Exporter 本地服务版

在原版 `6.13.2_0` 的基础上构建独立副本 `local-extension`，原版文件保持不变。PDF、图片、账号状态、用量、配置、设置备份与反馈均使用本机服务；Markdown、TXT、CSV、JSON 和剪贴板继续由浏览器生成。无需原开发商的服务器、登录或订阅。

依赖为本机已有的 Python 3、Pandoc 3.13、XeLaTeX，以及 macOS 系统字体。没有额外 Python/npm 运行依赖。

## 从第一版升级

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

新版健康检查应包含 `version: 2`。若仍在运行第一版服务，先停止旧进程再启动新版。

## 功能对应

| 功能 | 本地实现 |
|---|---|
| 消息提取、选择、复制 | 保留原浏览器逻辑，支持当前页面与原有 API/DOM 回退路径 |
| Markdown、TXT、CSV、JSON | 保留原转换器、本地文件和剪贴板输出；成功后记录本机用量 |
| PDF | 所选消息通过扩展后台发给本机，Pandoc + XeLaTeX 生成，再下载 |
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

服务端不下载远程资源，不读取聊天引用的任意本地文件。聊天和图片来自浏览器当前可访问的内容，所以读取未加载消息、附件和图片仍需连接 ChatGPT；可选的外部文档/评价等链接仍可能由用户主动打开。扩展只保留本机 API 的额外主机权限，移除了开发商网站的脚本和外部消息连接。

服务只接受扩展 Origin 或没有 Origin 的本机工具请求，拒绝普通网页 Origin，并校验 Host。内容脚本通过扩展后台转发到本机，避免从 HTTPS 聊天页面直接请求 HTTP 本机服务。它用于个人本机使用，不应直接暴露到公网。

## 兼容性范围

这是以 Pandoc 重新实现的本地版，不能承诺与原服务器逐像素一致。复杂交互组件、任意字体、emoji、超宽表格和极长代码行仍可能需要调整。Mono 是中文字体的近似排版；GIF 只取静态帧。无法读取的图片会显示说明，不阻止文字导出。语言选项设置 PDF 语言元数据，不翻译聊天内容或安装缺失字体。

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

当前执行环境不能监听本机端口，浏览器控制连接也不可用，因此新版尚未完成真实浏览器从点击到下载的整条验证。完成代码测试不等于已经验证全部站点页面、每种聊天组件和每项浏览器交互；请按升级步骤重新启动服务和加载副本。
