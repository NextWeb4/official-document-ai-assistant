# HaoXiang Document Assistant

本机公文校审、格式修复与规范导出的 Electron 桌面工作台。界面支持中文/English 切换，数据默认只保存在本机。

This is an Electron desktop workspace for local official-document review, formatting repair, and compliant export. The UI supports Chinese and English, and data stays on the local device by default.

由 [HaoXiang Huang](https://nextweb4.github.io/) 维护。邮箱：`Rays688888@Gmail.com`。

Maintained by [HaoXiang Huang](https://nextweb4.github.io/). Email: `Rays688888@Gmail.com`.

上游 [linhut/document-ai-assistant](https://github.com/linhut/document-ai-assistant) 的 MIT 版权与许可声明保留在 [LICENSE](./LICENSE) 中。

The upstream MIT copyright and license notice for [linhut/document-ai-assistant](https://github.com/linhut/document-ai-assistant) is preserved in [LICENSE](./LICENSE).

## 功能 Features

- 中文/English UI with language preference stored in `localStorage`.
- Import `.docx`, `.doc`, and `.wps` documents, then parse them into a structured document model.
- Rule-based review and repair for official-document typography, spacing, margins, headings, tables, and page fields.
- Local Ollama integration for optional AI analysis. Offline mode accepts loopback URLs only.
- Official and custom templates, template import, A4 preview, and Word export.
- Windows NSIS/MSI packaging, plus Debian packaging scripts for the supported target matrix.

## 技术栈 Stack

- Desktop: Electron 39.8.5, React 19, TypeScript, Vite.
- Backend: FastAPI, Python 3.12+, SQLAlchemy, SQLite, `python-docx`.
- Rules and templates: YAML with `official < custom < user` precedence.

## 安装 Installation

源码开发需要 Node.js 20+、Python 3.12+ 和 npm。

Source development requires Node.js 20+, Python 3.12+, and npm.

```powershell
git clone https://github.com/NextWeb4/official-document-ai-assistant.git
cd official-document-ai-assistant

cd backend
python -m pip install -r requirements.txt
python main.py
```

在另一个终端启动 Electron：

Start Electron in a second terminal:

```powershell
cd frontend
npm ci
npm run electron:dev
```

Windows 用户也可以运行根目录的 `启动应用.bat`。

Windows users can run `启动应用.bat` from the project root.

## 使用 Usage

1. 打开“处理”，导入 Word 文档并选择文种。
2. 在“校审”中查看规则问题，必要时运行本机 AI 分析。
3. 在“模板”中选择或导入格式基底。
4. 在预览页复核页面、字体、表格和页码，再导出 `.docx`。

1. Open Process, import a Word document, and select its document type.
2. Use Review to inspect rule findings and optionally run local AI analysis.
3. Choose or import a formatting template in Templates.
4. Verify pages, fonts, tables, and page fields in Preview before exporting `.docx`.

## 构建 Packaging

```powershell
cd frontend
npm run lint
npx tsc --noEmit
npx tsc -p tsconfig.electron.json --noEmit
npm run build
npm run package:win
```

`package:win` 生成 offline/online 两套 NSIS `.exe` 和 MSI 安装包。发布前还应从 `win-unpacked` 生成 ZIP，并使用 `Get-FileHash -Algorithm SHA256` 生成 `SHA256SUMS.txt`。

`package:win` creates offline and online NSIS `.exe` and MSI installers. Before publishing, create a ZIP from each `win-unpacked` directory and generate `SHA256SUMS.txt` with `Get-FileHash -Algorithm SHA256`.

Debian 10 构建必须使用匹配架构的 Linux/Debian 10 链路；参见 [AGENTS.md](./AGENTS.md) 和 `frontend/scripts/` 中的 Docker、WSL 及便携构建脚本。LibreOffice 不属于主程序依赖，仅在旧 `.doc`/`.wps` 转换时由用户自行安装。

Debian 10 packages must be built with the matching Linux/Debian 10 toolchain. See [AGENTS.md](./AGENTS.md) and the Docker, WSL, and portable builders under `frontend/scripts/`. LibreOffice is not a package dependency; users only need it to convert legacy `.doc`/`.wps` files.

### 字体说明 Font notice

源码仓库和安装包不包含第三方字体文件，也不提供字体下载接口。文档样式仍会记录规范要求的字体名称；用户应自行从合法来源取得并安装所需字体。

The source repository and installers do not include third-party font binaries or a font download API. Document styles may still reference required font family names; users must obtain and install those fonts from properly licensed sources.

## 作者与许可 Author and License

作者 Author: **HaoXiang Huang**  \
主页 Website: <https://nextweb4.github.io/>  \
邮箱 Email: `Rays688888@Gmail.com`

本项目使用 MIT License，并保留上游 Jose AI 的版权声明。详见 [LICENSE](./LICENSE)。

This project is released under the MIT License and preserves the upstream Jose AI copyright notice. See [LICENSE](./LICENSE).
