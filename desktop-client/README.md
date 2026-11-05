# 拾页 · macOS 桌面阅读客户端（0.1.1 预览版）

Tauri 2 + Rust + SQLite，使用 macOS WKWebView 阅读和生成矢量 PDF，不查找或启动外部 Chrome，不需要用户安装 Python、Node、Pandoc 或 TeX。

这是首个可安装版本，当前安装包面向 **macOS 13+ Apple Silicon（arm64）**。尚未提供 Windows/Linux 发行包，采用本地 ad-hoc 签名，未进行 Apple 开发者证书签名与公证，不能当作已完成公开发行验收的正式版本。

## 安装与首次连接

1. 打开 [安装包](releases/拾页_0.1.1_arm64.dmg)，把“拾页.app”拖到“Applications”，然后从应用程序打开。
2. 在 Chrome/Edge 等浏览器重新加载 `../exporter-extension/`，确认扩展版本为 **1.2.4**，刷新 ChatGPT 页面。
3. 进入扩展“导出设置 → 拾页客户端”，复制当前扩展 ID。
4. 在客户端“连接与备份”粘贴 ID，点击“连接浏览器”。它会为当前用户已有的 Chrome、Edge、Brave、Chromium、Arc、Opera 配置 Native Messaging Host。各浏览器支持情况仍需实机验收。
5. 回到网页直接选择消息并点击“存到拾页”或导出 PDF。“检查客户端连接”只是诊断按钮，不是使用前置步骤。

扩展重载后会自动检查并重新注入已打开的 ChatGPT 页面，恢复已有消息选择；不自动重发进行中的导出，避免重复生成文件。网页导出会自行握手并通过 Native Messaging 请求启动客户端。首次配对仍需完成一次。

配对必须在应用移动到最终安装位置之后进行；若移动应用或更换扩展 ID，请重新配对。首次安装需要上述一次连接设置，后续设计为按需唤起和复用唯一客户端实例。

网页 PDF 弹窗默认选择“拾页客户端”：提交后客户端弹出保存位置窗口，文件实际写入后网页才报告成功。所选原貌同时保存到内容库。若要使用旧后端，在“生成位置”明确选择“PDF 服务”。0.1.0 客户端不支持网页 PDF 任务，请先完全退出旧应用，再用此版替换 Applications 中的拾页并重新打开；原有收藏和配对保留。

原有 PDF 后端导出入口保留。存到拾页只连接本机客户端，不需要启动旧 Python 服务。暂不支持只靠插件安装桌面应用。

## 已实现

- 独立 `.app` 与 `.dmg`，单实例、本机私有 Unix Socket、Native Messaging 启动与连接程序。
- 扩展选择消息 → 网页快照 → 分块与 SHA-256 校验 → 原貌收藏；分块发生在扩展内部消息发送之前。
- 持久 SQLite 内容库及离线快照；相同内容去重，选择范围与消息正文保留。
- 三栏界面、隔离原貌阅读、标题目录、中文子串全文检索、收藏夹、标签、备注、星标、已读、阅读进度、可恢复回收站。
- PDF、离线 HTML、Markdown、TXT、完整归档 JSON；内容库备份与恢复。
- macOS PDF：WKWebView 按安全位置分段生成矢量 PDF，CoreGraphics 合成 A4；正文可提取，代码完整展开，整图避开页边界。
- 原貌阅读不执行网页脚本，默认不请求外部资源；正文文档没有应用命令权限。

界面测试截图：[三栏阅读界面](previews/reader-fixture.png)。这是浏览器内的 UI 回归夹具截图，**不是安装后的原生窗口截图**。

## 当前边界

- 新应用的原生 UI 自动操作未获工具授权，因此安装后启动、首次配对、真实浏览器冷启动及跨浏览器联动尚未完成端到端实机验收。不能把底层测试通过等同于这些流程已通过。
- 原生 PDF API 和 A4 分页通过独立 WKWebView 测试；完整 Tauri 应用里的导出点击流程仍需验收。PDF 目录书签、正文目录页、内部链接、纸张/边距设置尚未与旧后端达到功能一致。
- 原貌收藏暂要求所有所选消息都成功捕获 DOM。未加载消息会停止并提示重试，避免把 Markdown 源码当作原貌保存。
- 完整归档 JSON 支持消息和资源恢复。直接导入 HTML 仅支持其中的内嵌资源；保存页面的 `_files` 相邻目录尚未自动导入。网页独有图表无法在 Markdown/TXT 中原样表达。
- 资源当前仍嵌入快照，尚未实现内容包资源拆分、跨收藏资源去重或压缩；大收藏仍有内存开销。中文搜索使用字面子串，尚无 FTS 分词和搜索命中定位。
- 阅读目录已实现，但图表放大、阅读宽度设置、高亮标注、修订管理、批量导出和自动更新后续开发。文章采集和云同步暂不包含。
- 当前 Native Messaging 按分块调用连接程序，单块 384 KiB，超大内容的启动开销仍需真实浏览器压测；单条收藏上限 256 MiB。
- 界面关闭和完全退出的实际生命周期行为也列入人工验收，未默认设置开机启动。

## 数据与连接

默认数据：`~/Library/Application Support/io.local.archive-reader/`。

- `library.sqlite3`：管理信息、正文搜索字段。
- `items/<UUID>/archive.json`：结构与消息；`snapshot.html`：内嵌资源的网页原貌。
- `incoming/`：未完成分块和 PDF 临时文件，启动时清理超过一天的遗留临时数据。
- `origins.json`：允许连接的扩展来源；`native-host`：指向当前应用的启动器。
- `reader.sock`：仅当前用户可访问的本机 IPC，应用不监听 TCP 端口。

卸载应用不会主动删除内容目录。回收站使用软删除，没有永久删除入口；完整备份可恢复收藏管理信息。迁移前请从“连接与备份”导出备份。当前不做远程同步。

## 构建与检查

开发需要 Rust、Xcode 命令行工具、Node/npm；这些是构建依赖，不是用户使用依赖。

```sh
npm ci
npm run desktop
npm run package:mac
```

`package:mac` 先生成 app，再用无需挂载的磁盘镜像创建方式打包，避免 Finder 布局步骤导致 DMG 卸载占用。

```sh
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
npm run check
npm run check:native-pdf
```

从仓库根目录执行通信检查：

```sh
node desktop-client/scripts/check-extension-transport.mjs
node desktop-client/scripts/check-native-host.mjs
```

UI 检查使用现有 playwright-core 和本机 Chrome，原生 PDF 检查用 Swift 构建独立 WKWebView 探针。它们是开发测试工具，不进入用户客户端的运行依赖。

## 下一阶段验收

1. 人工安装应用并注册真实扩展 ID；关闭客户端后从浏览器保存，确认自动唤起、实际接收、重复保存和错误恢复。
2. 在真实客户端中阅读长对话、导出 PDF，核对公式、中文字体、代码末尾、长图分页与阅读进度。
3. 补全 PDF 目录与书签、导出设置，验证整库备份恢复和异常关闭。
4. 再进入 Windows WebView2 适配、资源拆分去重、自动更新与发布签名。
