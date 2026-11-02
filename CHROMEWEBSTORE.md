# 本地开发版说明

此目录当前产物是个人本机使用的解压扩展，不准备向 Chrome Web Store 发布。原包 `6.13.2_0` 保持不变。

本地版名称：ChatGPT Exporter - Local Service。版本标记：6.13.2 Local Service 3.1 (Divider fix)。

修复：SVG data URL 先栅格化再上传本机，避免被直接跳过；按 viewBox 补齐百分比尺寸，保留 DOM 中的内联图示。增加 UTF-8/Base64 SVG 回归检查。

权限：保留 `storage`、`activeTab` 用于保存导出设置和当前聊天交互；额外主机权限包括 `http://127.0.0.1:8765/*` 及 `https://*.oaistatic.com/*`、`https://*.oaiusercontent.com/*`、`https://cdn.openai.com/*`；静态域用于在页面 CORS 限制时补取导出需要的 OpenAI 字体/图片资源，补取不携带登录凭据。本机权限，用于本机 PDF、图片、资料、设置、用量与反馈接口。聊天内容脚本仍只匹配 ChatGPT 域名。移除原开发商网站内容脚本、host_permissions、externally_connectable、更新地址。

数据：所选聊天和图片发送给本机服务；PDF、图片和本机资料保存在 `local-pdf-server/data`。原厂后台被本地 worker 取代，前端统计初始化停用并拦截原服务与遥测传输。反馈仅保存本机。读取聊天和原始图片仍访问 ChatGPT。无真实云账户或订阅。

发布状态：未申请上架；若未来发布，需要独立评估原包再分发权利、隐私政策、权限披露、截图、浏览器实机测试与商店审核要求。

2.2 修复：按实际保存网页的新消息标记恢复 API 正文中缺失的 DIL 图示；按分组消息 ID 限定已选消息，适配新 DOM 回退识别。实际 HTML 两张 SVG 经真实后端生成 PDF，单条选择隔离测试通过。

2.3 修复：恢复的渲染图按相邻段落/标题/图注插回正文，取消统一追加到消息末尾；XeLaTeX 图像按 H 位置排版，保持图文顺序。实际 HTML 顺序断言、重复短句和重复图片保护检查通过。

3.0：默认网页原貌模式，保留选中 DOM 的计算样式及图片/字体资源，使用本机 Chromium 的屏幕媒体输出 PDF；保留 Pandoc 备用。增加引擎切换、静态资源权限、失败任务 HTML 快照恢复与依赖/实际启动状态区分。沙箱内实际 Chrome 启动失败，未声称完成视觉实机验证。

3.1：补存 background-clip/background-origin，恢复分隔线的内容区绘制范围；维持原始留白。实际 Chromium 验证明暗模式由 17px 灰条恢复为 1px 线条，并生成真实 PDF。
