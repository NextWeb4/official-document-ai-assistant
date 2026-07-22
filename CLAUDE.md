# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI 公文智能优化助手 (AI Official Document Optimization Assistant) — a desktop application for Chinese government document formatting based on **GB/T 9704** standards. Users upload `.docx` files, the system checks formatting against YAML-defined rules, and auto-fixes issues.

**Stack**: Electron 35 + React 19 (frontend) ↔ FastAPI + python-docx (backend) ↔ SQLite
**Version**: 1.4.7 | **Port**: 8765 | **Language**: Python 3.12+, Node 20+

## Commands

### Backend
```bash
cd backend
pip install -r requirements.txt
python main.py                          # starts on http://127.0.0.1:8765
```

### Frontend
```bash
cd frontend
npm install
npm run electron:dev                    # Concurrent Vite + Electron (hot reload)
npm run lint                            # ESLint
npm run build                           # tsc + vite build
```

### Full Desktop Build
```bash
cd frontend
npm run package:win                     # offline/online Windows NSIS .exe + MSI
bash scripts/build-debian-packages.sh   # Debian .deb, run on target Debian 10.x CPU architecture
npm run package:debian:docker           # Windows Docker Desktop/buildx path for Debian 10.10 containers
npm run package:debian:wsl              # Windows WSL Debian path for native-arch debs
npm run package:debian:docker:sh        # Linux/GitHub Actions Docker buildx path
npm run package:debian:portable         # Windows-only portable x64/arm64/armv7l deb assembly without Docker/WSL
npm run verify:packages -- --require-debian  # verify Windows plus x64/arm64/armv7l deb packages
MODE=offline ARCH=x64 bash scripts/verify-debian-runtime.sh  # run on Debian 10.x target machine
```
The Windows build runs `python build_backend.py` first, then packages offline and online variants. Debian PyInstaller builds must run on the target Debian 10.x Linux architecture because PyInstaller cannot cross-compile the Python backend. The Docker paths use a Debian 10.10 container and copy the workspace internally so Linux `node_modules` are not written back to Windows. The portable Debian path assembles Linux Electron, python-build-standalone, and Linux wheels on Windows; armv7l uses Python 3.11 with piwheels. Set `ALLOW_NON_DEBIAN=1` only for deliberate compatibility test builds outside Debian 10.x.

### Tests
```bash
cd <project-root>                       # run from project root, NOT from backend/
pytest tests/                           # all tests
pytest tests/backend/test_rule_engine.py -v   # single file
pytest tests/rules/ -v                 # rule tests only
pytest -k "test_name" -v              # single test by name
```
The `tests/conftest.py` adds `backend/` to `sys.path` automatically.

## Architecture

```
Electron Shell (main.ts)
  ├── Spawns Python backend (dev: python main.py / prod: backend_server.exe)
  ├── Health-checks http://127.0.0.1:8765/api/health before loading UI
  └── React UI → Axios → REST API (port 8765) → FastAPI → Core Engine → SQLite
```

### Core Pipeline: Parse → Model → Manipulate → Generate

All document processing flows through a **DocumentModel** (Pydantic intermediate representation). No module operates directly on python-docx objects.

```
.docx file
  → parser.parse_docx()        → DocumentModel
  → RuleEngine.check_and_fix() → fixed DocumentModel
  → generator.generate_docx()  → output .docx
```

### Backend Module Map

| Directory | Role |
|-----------|------|
| `backend/api/` | 9 FastAPI routers: documents, check, optimize, ai, settings, templates, template_download, rules, office |
| `backend/core/document/` | Parser, Generator, Modifier, Validator, FontUtils, StructureAnalyzer |
| `backend/core/rules/` | Loader, Manager (3-tier merge), Checker, Fixer, Engine |
| `backend/core/template/` | StyleManager (3-tier), Generator (.docx/.dotx) |
| `backend/ai/` | AIProvider ABC → local Ollama entry point; legacy provider classes remain for compatibility |
| `backend/db/` | SQLAlchemy models: Document, DocumentVersion, CheckResult, AIConfig, Rule |
| `backend/services/` | DocumentService orchestrates check/optimize flows |
| `backend/config.py` | PyInstaller-aware path resolution (`sys.frozen` detection) |

### Frontend Module Map

| Directory | Role |
|-----------|------|
| `frontend/electron/` | main.ts (backend lifecycle, window, tray), preload.ts (contextBridge) |
| `frontend/src/api/` | client.ts (axios instance + interceptors), documents.ts, check.ts |
| `frontend/src/pages/` | Workspace, DocumentProcess, CheckCenter, Templates, TemplateRules, Rules, AISettings, About |
| `frontend/src/components/ui/` | 15 Radix-based UI primitives |
| `frontend/src/components/layout/` | AppLayout, Sidebar, PageHeader |

### Three-Tier Priority System

Both rules and templates use: **official < custom < user**

- Rules: `rules/official/` < `rules/custom/` < `data/user_rules/`
- Templates: `templates/official/` < `templates/custom/` < `data/templates/user/`
- Deep-merge semantics: lists are concatenated, dicts recursively merged

### Rule YAML Structure

Each document type has a YAML file in `rules/official/`. `_common.yaml` is the base layer (all types inherit from it). Structure:

```yaml
document_type: "notice"
check_rules:
  - id: CHK-N001          # Convention: CHK-{TypePrefix}{NNN}
    severity: P0           # P0=format error, P1=minor, P2=suggestion
    field: "title.font"    # dot-path into DocumentModel
    expected: "方正小标宋简体"
fix_rules:
  - id: FIX-N001
    action: set_font       # set_font|set_size|set_alignment|set_indent|set_margins|remove_extra_spaces|remove_extra_blank_lines
    target: title          # title|body|signature|page_setup|all
    value: "方正小标宋简体"
```

### AI Provider Architecture

The local desktop app exposes Ollama only. Legacy provider classes remain in the registry for compatibility, but UI/API defaults must not expose online providers in offline mode.

Manager (`backend/ai/manager.py`) provides `create_provider()` factory and `fetch_models()`.

## Critical Implementation Details

### Font Handling (P0 critical)

Chinese documents require all 4 Word XML font attributes (`w:ascii`, `w:hAnsi`, `w:eastAsia`, `w:cs`). Using only `run.font.name` causes Word to fall back to MS Gothic/MS Mincho. All font operations go through `font_utils.py` → `set_run_font()` which sets all 4 attributes via OXML manipulation.

Standard fonts: title=方正小标宋简体, body=仿宋_GB2312, latin=Times New Roman.

### DocumentModifier is the Single Mutation Point

`core/document/modifier.py` is the ONLY module allowed to mutate `DocumentModel`. The fixer translates YAML rules into modifier calls. Never modify DocumentModel directly in other code.

### API Response Unwrapping

The axios response interceptor in `src/api/client.ts` automatically unwraps `response.data`. Frontend code receives the payload directly — do NOT use `response.data.xxx`, just use `response.xxx`.

### Electron Backend Lifecycle

- Dev mode: spawns `python backend/main.py`
- Production: spawns PyInstaller-bundled `backend_server.exe` from `process.resourcesPath/backend_server/`
- Health check polls `/api/health` at 500ms intervals, 20s timeout
- Shutdown: SIGTERM → 3s wait → `taskkill /F /T /PID`

### Path Resolution

`backend/config.py` uses `sys.frozen` to detect PyInstaller mode. `BASE_DIR` resolves to:
- Dev: project root (parent of `backend/`)
- Prod: `resources/` directory (parent of `backend_server/`)

### HashRouter

Frontend uses `HashRouter` (required for Electron's `file://` protocol). Vite is used by `npm run electron:dev` only as a desktop-shell development server, not as an independent web app entry.

### API Key Encryption

API keys stored encrypted via Fernet (`backend/utils/crypto.py`). Encryption key auto-generated at `data/.encryption_key`. Frontend shows masked keys (e.g., `sk-xxxx****xxxx`).

## Known Gaps

- **Workspace page** uses hardcoded mock data (no live API)
- **TemplateRules save** is not implemented (TODO alert only)
- **Inconsistent API patterns**: some pages call `apiClient` directly, others use typed modules in `src/api/`
- **Navigation**: some pages use `window.location.href` instead of React Router's `useNavigate`
- **No global state management**: each page manages own state with useState/useEffect
