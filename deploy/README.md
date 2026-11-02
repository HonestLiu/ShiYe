# Linux / Docker 部署

服务端支持 Linux `amd64` 和 `arm64`。镜像内置 Python、Node.js、Chromium、Pandoc、XeLaTeX、Pillow 和 Noto 中文字体，宿主机只需 Docker 与 Compose 插件。镜像首次构建包含浏览器和 TeX，体积较大。

网页原貌模式会嵌入可读取的网页字体；系统字体无法从页面读取时，使用服务器上的回退字体。因此 Linux 与 macOS 的系统字体显示可能有细微差异。

## 使用预构建镜像

仓库的 [GitHub Actions 工作流](../.github/workflows/docker.yml) 在测试通过后发布：

```text
ghcr.io/honestliu/chatgpt-exporter-server:latest
```

首次使用前，需要先将工作流推送到 GitHub 并完成构建。若希望任何用户匿名拉取，在 GitHub Packages 中将该镜像包设为 Public；私有包需要先 `docker login ghcr.io`。Fork 仓库默认发布到 Fork 所有者的同名镜像，需相应修改 `.env` 的 `EXPORTER_IMAGE`。

在项目根目录准备配置：

```sh
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

编辑 `.env`，将生成的令牌填入 `LOCAL_EXPORT_API_TOKEN`，并填写浏览器实际访问的地址：

```dotenv
LOCAL_EXPORT_PUBLIC_URL=https://export.example.com
LOCAL_EXPORT_API_TOKEN=在这里填写生成的随机令牌
EXPORTER_BIND_IP=127.0.0.1
EXPORTER_PORT=8765
EXPORTER_IMAGE=ghcr.io/honestliu/chatgpt-exporter-server:latest
```

地址只接受 HTTP(S) 的完整 origin，不带 `/api`、子目录、查询参数或账号密码。非本机监听必须配置公开地址及至少 24 字符的访问令牌。`.env` 不会进入 Git 或镜像构建上下文。

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=50 exporter
```

Compose 默认将端口发布到服务器的 `127.0.0.1:8765`，供同机 HTTPS 反向代理访问。数据保存在 `exporter-data` 命名卷中。普通 `docker compose down` 保留数据；`docker compose down -v` 会删除该卷。

## 配置 HTTPS 反向代理

将域名 DNS 指向服务器，使用 Caddy 等反向代理提供 HTTPS。Caddy 示例见 [Caddyfile.example](Caddyfile.example)：

```caddyfile
export.example.com {
    request_body {
        max_size 64MB
    }
    reverse_proxy 127.0.0.1:8765
}
```

将域名替换为自己的域名，并将站点配置加入现有 Caddy 配置。反代需保留原始 Host，并转发 Authorization、Cookie；浏览器实际访问的 origin 应与 `LOCAL_EXPORT_PUBLIC_URL` 一致。服务直接使用该配置生成下载链接，不依赖任意客户端提供的转发头。

若 Caddy 自身运行在容器里，请使用容器网络连接后端并调整反代地址，不能把 Caddy 容器的 `127.0.0.1` 当作宿主机。

在可信内网直接使用 HTTP 时，可将 `.env` 中的地址设为 `http://服务器IP:8765`，同时设置 `EXPORTER_BIND_IP=0.0.0.0`。公网部署使用 HTTPS，避免访问令牌和聊天内容以明文传输。

## 插件连接独立服务器

1. 在扩展管理页重新加载新版 `local-extension`，刷新 ChatGPT 页面。
2. 打开插件弹窗中的“服务设置”，或 PDF 导出窗口中的“配置服务器连接”。
3. 在“服务器连接”填写 `https://export.example.com` 和 `.env` 中的访问令牌。
4. 点击“保存并连接”，允许浏览器访问所填服务器域名，再刷新 ChatGPT 页面。

扩展默认仍连接 `http://127.0.0.1:8765`。切换到远程服务后，所选聊天、图片、生成文件及资料会在该服务器处理或保存。地址和令牌只存储在当前浏览器，不进入导出设置备份，也不会附带到 OpenAI 静态资源请求中。

直接在浏览器打开服务器地址，可用同一访问令牌登录 Web 后台。Web 登录使用 HttpOnly 会话 Cookie；API 使用 Bearer 令牌。PDF、图片及快照下载使用有效期 15 分钟、绑定到单个路径的临时签名链接，链接中不包含长期访问令牌。链接过期后刷新任务列表即可取得新链接。

这是单一信任域的服务实例，不提供多用户隔离：持有同一访问令牌的用户可以查看该实例的资料和导出记录。需要互相隔离的用户应部署独立实例与数据卷。

## 从源码构建

尚未发布镜像，或要验证当前修改时：

```sh
docker build -t chatgpt-exporter-server:local .
```

将 `.env` 中的 `EXPORTER_IMAGE` 改为 `chatgpt-exporter-server:local`，再执行：

```sh
docker compose up -d --pull never
```

镜像以 UID/GID `10001:10001` 运行。默认命名卷可直接使用；若改为宿主目录绑定挂载，需要让该用户可写。

Compose 启用 Chromium 沙箱、非 root 用户、裁剪的容器能力和 1 GiB 共享内存。请保留 [chromium-seccomp.json](chromium-seccomp.json) 挂载配置；它基于 Moby 的默认策略，按 Playwright 的 Docker 指南补充 Chromium 所需的用户命名空间调用。宿主机也需要允许非特权用户命名空间，禁用时 Chromium 会明确报错，不会自动关闭沙箱。

直接 `docker run` 的等价示例（同样需要配置 URL 和令牌）：

```sh
docker run -d --name chatgpt-exporter --restart unless-stopped --init \
  --env-file .env \
  -p 127.0.0.1:8765:8765 \
  -v exporter-data:/data \
  --shm-size=1g --cap-drop=ALL \
  --security-opt seccomp=./deploy/chromium-seccomp.json \
  ghcr.io/honestliu/chatgpt-exporter-server:latest
```

## GitHub Actions

- PR：构建 Linux 镜像，运行真实容器集成测试及扩展检查，不发布镜像。
- 推送 `main` / `master`、`v*` 标签或手动触发：测试后构建并发布 `linux/amd64`、`linux/arm64` 镜像。
- 默认分支发布 `latest`，同时支持分支、版本标签和提交 SHA 标签。
- 使用仓库自带的 `GITHUB_TOKEN` 推送 GHCR，不需要 Docker Hub 凭据或服务器访问令牌。
- 构建产物中提供可解压加载的扩展 ZIP。

工作流在 amd64 容器中实际检查：令牌/Origin/CSRF/会话鉴权、临时下载链接、PNG/GIF/WebP 上传、三种中文字体的 Pandoc PDF，以及 Chromium 的图片、SVG、标题书签和可选目录。多架构镜像通过后续 Buildx 构建发布。

本地运行相同集成检查：

```sh
docker run --rm --init --shm-size=1g --cap-drop=ALL \
  --security-opt seccomp=./deploy/chromium-seccomp.json \
  -v "$PWD/local-pdf-server/verify-deployment.py:/checks/verify-deployment.py:ro" \
  chatgpt-exporter-server:local \
  python3 /checks/verify-deployment.py --server-dir /app
```

## Linux 原生运行

Debian/Ubuntu 可安装以下运行依赖，再启动服务：

```sh
sudo apt-get update
sudo apt-get install python3 python3-pil nodejs npm chromium \
  fonts-noto-cjk fonts-noto-color-emoji pandoc \
  texlive-xetex texlive-latex-extra texlive-fonts-recommended lmodern
npm --prefix local-pdf-server ci --omit=dev --ignore-scripts
```

Node.js 需满足 `playwright-core` 要求（当前至少 18）；Docker 镜像使用 Node.js 22。

```sh
export LOCAL_EXPORT_HOST=0.0.0.0
export LOCAL_EXPORT_PUBLIC_URL=https://export.example.com
export LOCAL_EXPORT_API_TOKEN=填写随机生成的访问令牌
export LOCAL_EXPORT_DATA_DIR=/path/to/exporter-data
python3 local-pdf-server/server.py
```

原生运行同样建议放在 HTTPS 反代后。服务需要对数据目录有写权限，并能启动启用沙箱的 Chromium。

## 更新、备份和排查

更新镜像：

```sh
docker compose pull
docker compose up -d
```

备份前先停止服务，将命名卷内容完整备份；数据库、图片和任务文件需要一起保留。切换访问令牌后，扩展需更新令牌，Web 用户需重新登录，旧签名链接也会失效。

- `401`：检查扩展令牌或 Web 登录状态；临时下载链接过期时刷新列表。
- `403 Origin/Host rejected`：检查公开 URL、实际访问域名/端口及反代 Host 是否一致。
- `Chromium sandbox` / `Operation not permitted`：检查 seccomp 策略及宿主用户命名空间支持。
- `font not found`：官方镜像已包含 Noto CJK；自建环境检查字体及 XeLaTeX 依赖。
- 后台显示依赖可用但生成失败：查看具体任务错误与 `docker compose logs`；依赖存在不等于浏览器已经实际启动。

Seccomp 策略来源与许可见 [NOTICE.md](NOTICE.md) 和 [LICENSE.seccomp](LICENSE.seccomp)。
