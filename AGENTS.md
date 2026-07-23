# AGENTS.md

## 1. 项目结构
- `backend/`: FastAPI 后端，端口默认 `8765`；核心处理在 `backend/core/`，API 路由在 `backend/api/routes/`，AI Provider 在 `backend/ai/`。
- `backend/core/document/`: 公文解析、结构模型、生成、格式转换；`DocumentModel` 是文档处理中间表示。
- `backend/core/rules/`: YAML 规则加载、合并、检查、修复；规则文件来自 `rules/official/`，用户/自定义规则来自 `data/` 下运行时目录。
- `backend/core/template/`: 模板样式管理与 `.docx/.dotx` 生成；模板定义来自 `templates/official/`。
- `backend/core/document/template_applier.py`: 用户上传 `.docx/.dotx` 模板作为格式基底的导出逻辑；内容来自文档模型，格式来自模板文件。
- `frontend/`: Electron + React + Vite 前端；Vite 只服务 Electron 开发调试，不提供独立网页版入口；页面在 `frontend/src/pages/`，API 封装在 `frontend/src/api/`，Electron 入口在 `frontend/electron/`。
- `frontend/src/components/layout/`: 应用外壳采用“桌面窄图标轨道 + 顶部上下文栏、移动端底部导航”；页面不得自行复制全局导航或署名入口。
- `tests/`: pytest 测试；`tests/conftest.py` 已把 `backend/` 加入 `sys.path`，测试必须从项目根目录运行。
- `rules/official/` 与 `templates/official/`: 官方规则和模板数据，修改后必须同步跑相关规则/文档测试。
- `office-plugin/`: Word/VBA 插件桥接代码，避免与 Electron/FastAPI 生命周期混改。
- `.github/workflows/`: CI 与发布自动化；公开发布前必须保持 Linux/Debian 工作流与 Windows 本机构建职责分离。
- `release-assets/`: 仅作为本机 Release 上传暂存目录；生成 SHA-256 后上传，默认不得提交到源码仓库。

## 2. 运行命令
- 后端：`cd backend && pip install -r requirements.txt && python main.py`
- Electron 开发：`cd frontend && npm install && npm run electron:dev`
- Windows 一键启动：双击或运行 `启动应用.bat`
- Windows 发布构建：`cd frontend && npm run package:win`；该命令生成 offline/online 两套 `.exe/.msi`，只能在作者、许可证和资源审计完成后执行。

## 3. 测试命令
- 全量后端/规则/文档测试：`pytest tests/ -v --tb=short`
- 规则相关测试：`pytest tests/rules/ -v`
- 单文件示例：`pytest tests/backend/test_rule_engine.py -v`
- Debian 打包门禁测试：`cd frontend && node --test scripts/verify-debian-validation.test.mjs`
- 便携打包器测试：`pytest tests/packaging/test_portable_debian_builder.py -q`
- 规则字段覆盖测试：`pytest tests/rules/test_checker_field_coverage.py -q`
- 当前未发现 React 组件单元测试命令；前端改动至少运行 `cd frontend && npm run lint` 和 `cd frontend && npm run build`。
- 发布前源码清单：`git status --short`、`git ls-files`、`git check-ignore -v <path>`；发布资产校验：`Get-FileHash release-assets/* -Algorithm SHA256`。
- 前端依赖安全门禁：`cd frontend && npm audit --audit-level=high`；高危或严重漏洞未清零时不得发布。

## 4. 构建命令
- 前端构建：`cd frontend && npm run build`
- Electron Windows 双版本打包：`cd frontend && npm run package:win`，输出 `release/offline-windows/` 与 `release/online-windows/` 下的 `.exe/.msi`
- Debian deb 打包：必须在目标 CPU 架构的 Debian 10.x/Linux 环境执行 `cd frontend && bash scripts/build-debian-packages.sh`；PyInstaller 后端不能从 Windows 交叉编译到 Linux/ARM，非 Debian 10.x 测试构建必须显式设置 `ALLOW_NON_DEBIAN=1`。
- Windows 上如已安装 Docker Desktop/buildx/QEMU，可执行 `cd frontend && npm run package:debian:docker`，该脚本使用 Debian 10.10 容器并把源码复制到容器内部构建，避免把 Linux `node_modules` 写回 Windows 工作区。
- Windows 上如 WSL Debian 已可用，可执行 `cd frontend && npm run package:debian:wsl` 构建 WSL 本机架构 deb；脚本固定并校验 Node 20.19.5/Python 3.12.7，在 WSL `/var/tmp` ext4 staging 中构建，禁止直接复用 Windows `node_modules`。WSL 不是 Debian 10.x 时只允许显式传入 `-AllowNonDebian` 做兼容性试构建。
- Windows 上无 Docker/WSL 时，可执行 `cd frontend && npm run package:debian:portable` 组装 `x64/arm64` 便携 deb；该链路使用 Linux Electron、python-build-standalone 和 manylinux wheels，并在入包前扫描全部 wheel ELF。ARMv7 便携构建已禁用，不能绕过门禁恢复 piwheels 的通用 `linux_armv7l` 轮子。
- Linux/GitHub Actions 上如已安装 Docker buildx/QEMU，可执行 `cd frontend && npm run package:debian:docker:sh`；手动工作流 `.github/workflows/package-debian.yml` 使用同一入口，发布默认只构建 `x64,arm64`。ARMv7 只有在匹配架构的 Debian 10 构建链生成全部原生依赖且独立校验通过后才能重新进入发布矩阵。
- 安装包产物验证：`cd frontend && npm run verify:packages` 校验 Windows 产物、appMode、福建模板和 locale；当前 Debian 发布架构运行 `npm run verify:packages -- --require-debian`，显式验证 ARMv7 时必须传 `--debian-arch=armv7l`。
- Debian 10.10 目标机安装运行验收：把产物放在 `frontend/release/*-debian/` 后，在目标 Debian 10.x/目标 CPU 上运行 `cd frontend && MODE=offline ARCH=x64 bash scripts/verify-debian-runtime.sh`；当前发布 `ARCH` 为 `x64` 或 `arm64`，在线版改 `MODE=online`，不要假设目标机已安装 Node/npm。非 Debian 10 默认必须失败，`ALLOW_NON_RELEASE_OS=1` 只能用于明确标记的非发布检查。
- 后端独立打包资源准备：`python build_backend.py`
- CI 中前端类型检查必须同时运行：`cd frontend && npx tsc --noEmit` 与 `npx tsc -p tsconfig.electron.json --noEmit`；根 tsconfig 不覆盖 Electron main/preload。

## 5. 代码风格
- Python 代码以现有类型标注、Pydantic 模型和 pathlib 路径风格为准；不要引入未配置的格式化器。
- TypeScript/React 使用 Vite + React 19 + ESLint flat config；前端提交前运行 `npm run lint`。
- 当前未发现 lint / format 命令：后端无单独 lint/format 配置；前端有 `npm run lint`，未发现 format 命令。
- 前端 API 响应经过 `frontend/src/api/client.ts` 拦截器解包，页面代码不要再写 `response.data.xxx`。
- Electron 使用 `HashRouter` 适配 `file://`，不要改成 `BrowserRouter`。
- 界面保持中性纸墨色基底、青绿色主操作和朱红色风险提示；不要恢复参考仓库的暖棕橙配色、240px 分组侧栏或 1440px 右侧信息面板。
- 产品署名统一写作 `HaoXiang Huang`，个人网站统一为 `https://nextweb4.github.io/`；上游 Jose AI 的 MIT 版权声明必须保留。
- 面向用户的界面文案必须由集中式中英资源提供；语言开关状态使用 `localStorage` 持久化，业务数据、文件名和规则 key 不得被翻译层改写。

## 6. 模块边界
- 文档处理链路必须保持：`.docx -> parser -> DocumentModel -> RuleEngine/Modifier -> generator -> .docx`。
- `backend/core/document/modifier.py` 是 `DocumentModel` 的单一修改点；规则修复应通过 fixer/modifier，不要在 API 路由或页面层直接改模型字段。
- 字体设置必须走 `backend/core/document/font_utils.py`，保证 Word XML 的 `w:ascii`、`w:hAnsi`、`w:eastAsia`、`w:cs` 同步设置。
- 套用上传模板导出时，必须保持“正文内容、表格数量/维度/单元格内容来自源文档，页边距/页眉页脚/段落和字体格式来自模板，模板原件只读不改写”的边界；生成后必须复核全部段落和表格。
- AI 服务商接入必须实现 `backend/ai/base.py` 的 Provider 边界，并经 `backend/ai/manager.py` 创建。
- 本地版 AI 对用户只暴露 `ollama`，Base URL 必须是 `localhost` 或 `127.0.0.1`；不要在前端默认值、检查页或状态检测中回落到 `openai/deepseek/claude/custom`。
- AI 分析只能使用请求中明确指定且 `is_active=true` 的同名配置；缺失/停用配置不得回落到其他 Provider，`__saved__` 只能读取同一 Provider 的密钥，连接测试不得改变激活状态。
- 官方 YAML 中的每个 `check_rules.field` 必须在 `checker.py` 中有真实 `DocumentModel` 处理器或进入显式 unsupported 集合；禁止未知字段静默通过。
- 页码必须写成 Word `PAGE` 动态域；`has_page_number=true` 时不能只写字面量 `1`。
- 福建省政府模板由 `backend/api/routes/templates.py` 的 `_FUJIAN_TEMPLATE_SPECS`、`rules/official/fujian_province.yaml`、`templates/official/fujian_province.yaml` 三处共同维护，新增/改名必须同步更新测试。
- 前端页面只负责交互和展示；文档解析、规则判断、模板生成逻辑必须留在后端核心模块。
- 全局导航、主题切换和产品署名只由 `frontend/src/components/layout/` 维护；具体页面通过路由内容区渲染，不直接控制 Electron 窗口外壳。
- 发布作者元数据的单一来源是 `frontend/package.json`：姓名 `HaoXiang Huang`、邮箱 `Rays688888@Gmail.com`、主页 `https://nextweb4.github.io/`、许可证 `MIT`；Electron、README、About、安装包脚本与 Release Notes 必须与其一致。
- Debian 的 `/opt` 安装目录固定为无空格的 `/opt/official-document-ai-assistant-{offline|online}`；用户可见名称继续由 `.desktop` 的 `Name=HaoXiang Document Assistant {Offline|Online}` 提供，不能用带空格的 `productName` 作为 Linux 安装目录。
- Debian 容器 GUI 验收允许仅在隔离测试容器上授予 Chromium 创建命名空间所需的 `SYS_ADMIN` 与非默认 seccomp；不得因此给正式桌面入口追加 `--no-sandbox`。
- 后端端口可用性探测必须保留 `SO_REUSEADDR` 后再尝试绑定 `127.0.0.1:8765`，避免把正常重启后的 `TIME_WAIT` 误判成不可信端口占用；实际监听进程仍必须通过 `/proc`/PID 与 `/api/health` 身份校验。

## 7. 禁止事项
- 不允许把运行时用户数据写入 `rules/official/`、`templates/official/` 或打包资源目录；可写数据应走 `APP_DATA_DIR` 下目录。
- 规则和样式模板写操作只允许 `user/custom` 来源；`official` 与 `all` 永远不可写。自定义样式模板位于 `APP_DATA_DIR/custom_templates/`。
- 上传的 `.docx/.dotx` 模板必须保存到 `APP_DATA_DIR/uploaded_template_files/`，`.dotx` 只能转换为内部 `.docx` 工作副本，不能覆盖用户上传原件或官方模板。
- 不允许绕过 `backend/config.py` 自行拼接生产/开发路径。
- 不允许在没有测试覆盖的情况下大范围重写规则引擎、文档模型、生成器或 Electron 后端生命周期。
- 不允许为了修复局部 bug 引入新依赖，除非先完成许可证、维护状态、离线/联网边界和复杂度审计。
- 不允许新增隐式联网行为；AI Provider、模型健康检查等联网行为必须可配置、可解释。
- 不提供局域网网页访问开关，不再创建或读取 `APP_DATA_DIR/network_config.json`；后端启动入口只能绑定 `127.0.0.1`。
- 本地版不得在 UI 中展示在线模型服务商或默认远端 Base URL；离线模式 API 必须拒绝非 `ollama` provider 和非 loopback Base URL。
- Linux `--force` 清理旧后端后必须重新验证 `127.0.0.1:8765` 可绑定；无法定位或终止占用进程时必须停止启动并报告端口占用。
- API 传入的 rule key、template id、document_type、Office 文件名写入磁盘前必须做白名单校验或文件名净化，禁止直接拼接到路径。
- Debian 安装包不得在 `Pre-Depends`、`Depends`、`Recommends`、`Suggests` 或 `Enhances` 中声明任何 LibreOffice 包；LibreOffice 仅由用户在需要旧格式转换时独立安装，公文校审主程序必须可独立安装和启动。
- 不允许删除或覆盖 `LICENSE` 中的上游 MIT 版权声明；新增作者信息必须作为修改者署名并与上游来源并列说明。
- 不允许重新引入与参考仓库同构的“可折叠宽侧栏 + 主内容 + 固定右面板”应用骨架。
- 不允许把用户提供的访问令牌、密钥、Cookie 或个人目录写入源码、git 配置、README、Release Notes、日志或构建参数；远程认证只能使用短生命周期环境变量或受管凭据。
- 第三方 TTF/OTF/TTC 字体不得进入源码提交或 Release 资产；`TTF/` 永久作为本地目录排除，打包脚本和 UI 不得恢复字体复制或下载接口。
- 不允许上传 `frontend/release/`、`frontend/.cache/`、`dist/`、`data/`、`docs/archive/`、根目录旧 `.exe` 或 `release-assets/` 到源码仓库。

## 8. 完成标准
- 后端或规则改动：至少运行相关 `pytest`，能全量跑时运行 `pytest tests/ -v --tb=short`。
- 前端改动：至少运行 `cd frontend && npm run lint` 和 `cd frontend && npm run build`。
- 全局布局、导航或主题改动：除 lint/build 外，必须在 Electron 或 Vite 调试环境检查桌面与移动视口；确认导航、内容滚动、外部个人网站链接和长文本均无重叠。
- 公开 Release 前必须验证：源码清单无敏感/缓存文件、README 含中英文项目说明、作者/邮箱/主页贯通 UI 和安装包、Release 资产的 SHA-256 完整、安装包元数据不含旧作者。
- Electron/打包改动：运行对应 `npm run electron:compile`、`npm run package:win`、或在 Linux 目标架构运行 `bash scripts/build-debian-packages.sh`；未运行的目标必须说明原因。
- Debian 打包或启动链路改动：必须检查包元数据不强制安装 LibreOffice，并在 Debian 10.x 上实际执行 Electron GUI 启动；缺少 `xvfb-run` 不得被当作 GUI 验收通过。
- Debian 产物结构校验必须覆盖包内全部 ELF 的架构与 glibc 上限；目标机验收必须执行 `ldd` 缺库检查。只抽查 Electron、Python 或单个扩展不能作为发布证据。
- 便携 Debian 运行时缓存键必须包含上游版本/完整资产名；Python 与 Electron 归档必须使用仓库内固定的上游 SHA-256 校验，不能只凭 ZIP/TAR 可解压判断缓存有效。
- 修改规则/模板后，应验证受影响文种的 fixtures 或生成文档路径。
- 修改福建省政府模板后，必须运行 `pytest tests/backend/test_fujian_templates.py -q`。
- 修改上传模板套用链路后，必须验证“模板格式 + 源文档内容”同时成立，至少检查生成 `.docx` 的文本、页边距和关键字体 XML。
- 修改上传模板表格链路后，必须同时覆盖源表格比模板大、比模板小、源无表格和非法单元格坐标，不能把越界写入仅记录为 warning。
- 修复 bug 必须说明不变量、最小复现、根因、最小修改点和回归测试。
- 修改 AI 建议应用、文本替换、数字替换等内容变更链路后，必须用真实 `.docx` 复核生成结果；部分替换失败时 API 和前端都必须提示未完成项。
- 修改数字/西文字体链路后，必须解压生成 `.docx` 复核 `word/document.xml` 中 `w:ascii` 与 `w:hAnsi` 已写入目标字体，不能只看前端预览。
- 修改页码链路后，必须解压 `.docx` 并确认 footer XML 包含 `w:instrText` 的 `PAGE` 以及 `begin/separate/end` 域节点。

## 9. Review 标准
- 优先审查用户文件是否可能被覆盖、`APP_DATA_DIR` 与 `BASE_DIR` 是否混用、生产打包路径是否仍可解析。
- 优先审查 `DocumentModel` 是否被绕过、字体 XML 是否完整设置、规则合并优先级是否保持 `official < custom < user`。
- 上传模板 Review 必须检查路径白名单、`.dotx` 内容类型转换、模板文件只读、导出后内容复核和模板页边距复核。
- 数字/西文字体 Review 必须检查 `RunFormat.latin_font_name` 是否贯通 parser、generator、API 配置和导出复核，避免退回固定 `Times New Roman`。
- 文本替换 Review 必须检查数字值、跨 run 文本、全角/半角数字、生成后复核和失败提示，不能只检查接口返回成功。
- 前端 Review 必须检查 API 解包、错误态、加载态和 Electron `file://` 路由兼容。
- 界面 Review 必须与参考仓库对照检查信息架构和应用外壳，而不只比较颜色；桌面窄轨道、顶部上下文栏、移动端底部导航和 HaoXiang Huang 署名必须可见且可用。
- 署名 Review 必须同时检查 About 页面、应用外壳、`package.json` 与 `LICENSE`，并确认个人网站由 Electron 外部链接策略打开，上游 MIT 版权未被移除。
- 发布 Review 必须检查根 `.gitignore` 实际覆盖 `.env.*`、token/secret/credentials、`*.key`、`*.pem`、构建目录、缓存、日志、IDE 目录与临时文件；`git check-ignore` 必须有证据。
- 字体 Review 必须检查公开源码与 Release 包不包含任何 TTF/OTF/TTC；文档样式只保存字体名称，不负责提供字体文件。
- 本地版 AI Review 必须检查默认 provider、AI 设置页、校审中心分析入口、`/api/ai/providers` 与 `/api/ai/default` 均不暴露在线模型。
- 规则启停 Review 必须检查独立 PATCH 只修改目标 `(source_type, key)`，列表读取持久化 `enabled`，禁用文件不进入规则合并，并清除所有规则引擎缓存。
- 新依赖 Review 必须检查许可证、体积、维护状态、是否引入网络请求和是否有回滚方案。
- 打包 Review 必须检查 `package.json` 在脚本结束后恢复默认 `appMode: offline`，Windows 产物同时包含 offline/online 的 `.exe` 和 `.msi`，Debian/ARM 产物必须由 Debian 10.x 或 `debian10-builder.Dockerfile` 的匹配架构 Linux 后端二进制支撑，并保留 `homepage` 与 `linux.maintainer/vendor` 以满足 deb 元数据。
- Debian Review 必须确认包元数据与桌面入口都不引用 LibreOffice；启动验收要覆盖桌面入口、主 Electron 进程、无系统托盘环境、后端健康检查和失败日志，不能只验证后端 launcher。
- Debian 结构验证必须区分原生 PyInstaller ELF 后端与便携 shell + embedded Python 后端；两种布局分别校验，不能强制原生包包含 `resources/python/`。
- ARMv7 Review 必须拒绝要求高于 `GLIBC_2.28` 或依赖 Debian 10 不提供的 `libssl.so.3`、`libcrypto.so.3`、`libffi.so.8` 的轮子；在兼容 wheel 链与真实 GUI 证据缺失时不得生成或上传 ARMv7 发布包。

## 10. 常见风险
- 中文注释/字符串在 Windows 控制台中可能显示乱码；判断文件内容时以 UTF-8 读取和测试结果为准。
- `build_backend.py` 会删除并重建构建产物目录，改动前确认目标路径只包含生成物。
- `.docx/.dotx` fixtures 和模板是二进制文件，修改后需要用测试或实际打开验证。
- `frontend/.cache/` 是未跟踪缓存目录，不应纳入提交。
- Debian 结构校验不能证明 Electron 能在目标系统启动；Electron/Chromium 的 glibc、GTK、sandbox 和显示服务兼容性必须在目标 Debian 版本实际验证。
- 当前 ARMv7 便携链不可发布：已观察到 `cffi`、`cryptography`、`pydantic-core`、`watchfiles` 的 piwheels 二进制要求 `GLIBC_2.34`；恢复该架构前必须在 Debian 10 原生构建依赖并重新跑全 ELF 与 GUI 验收。
- `data/.encryption_key` 是设备级运行时密钥，由 `backend/utils/crypto.py` 在 `APP_DATA_DIR` 首次生成；不得复制进源码、安装包或 Release。
- 当前前端源文件大量继承上游 Jose AI 的 MIT 文件头；批量替换文件头会造成许可证风险，只能追加修改者署名或在产品元数据中补充作者。
- 旧 `TTF/` 目录只有第三方字体二进制且无再分发许可证；该目录仅保留为本地材料，不得复制到 PyInstaller、Electron 或 Debian 资源目录。
