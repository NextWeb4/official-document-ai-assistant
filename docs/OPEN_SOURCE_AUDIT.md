# Open-source Solution Audit

Date: 2026-07-22

## UI localization

| Option | Source | License | Core capability | Advantages | Disadvantages | Maintenance | Fit | Conflicts | Decision |
|---|---|---|---|---|---|---|---|---|---|
| i18next + react-i18next | npm / GitHub | MIT | Translation resources, language state, React integration | Mature, small runtime surface, local resources work offline | Existing Chinese literals need an adapter during migration | Active | High | No network behavior; compatible with React 19 and Electron | Adopt |
| Lingui | npm / GitHub | MIT | Message extraction and compiled catalogs | Strong extraction workflow | Adds compilation and message-macro migration cost | Active | Medium | Would expand the current Vite toolchain and migration scope | Reject |
| Hand-written dictionary only | Local implementation | Project MIT | Direct key/value lookup | No dependency | Reimplements lifecycle, persistence, interpolation, and React updates | N/A | Low | Higher maintenance cost and incomplete behavior risk | Reject |

Adopted versions: `i18next 26.3.6` and `react-i18next 17.0.10`.

Directly reused: language lifecycle, React provider integration, resource lookup, and language-change events.

Locally adapted: a DOM translation bridge for the existing Chinese-first UI while pages are migrated incrementally. It translates visible text and accessibility attributes only; business data, filenames, rule keys, and editable values are excluded.

Not adopted: remote translation loading, browser language detection, extraction macros, and any network-backed localization service.

Rollback: remove the provider and DOM bridge, then remove both packages. The original Chinese source strings remain the canonical UI content.

## Security and packaging compatibility

- Electron was upgraded from `35.0.0` to `39.8.5` to resolve published desktop-runtime advisories without changing the Electron architecture.
- `concurrently` was upgraded to `9.2.4`; compatible transitive build dependencies were refreshed through npm's audited lockfile update.
- `npm audit` reports zero known vulnerabilities after the update.
- Debian 10 packaging remains separately pinned to Electron `18.3.15` for glibc compatibility. That runtime is end-of-life and remains an explicit, isolated risk; it is not used by the Windows release.
- No dependency adds runtime network calls. i18n resources are bundled locally.
- All adopted packages are MIT-licensed and compatible with this repository's MIT license.

## Font distribution policy

The local workspace contained three proprietary font binaries without redistribution licenses. They are excluded from the public source tree and all package resource paths. The font listing/download API and UI were removed. Release verification fails if a TTF, OTF, or TTC file enters the tracked source or a Windows package; document styles continue to store font family names only. Rollback requires a separate license review and explicit authorization from each font rightsholder.
