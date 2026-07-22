/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Modifications (c) 2026 HaoXiang Huang (https://nextweb4.github.io/)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { Link, useLocation } from 'react-router-dom';
import {
  Bot,
  CircleHelp,
  FileInput,
  LayoutDashboard,
  Library,
  ScanSearch,
} from 'lucide-react';

const navigation = [
  { label: '工作台', path: '/workspace', icon: LayoutDashboard },
  { label: '处理', path: '/document/process', icon: FileInput },
  { label: '校审', path: '/document/check', icon: ScanSearch },
  { label: '模板', path: '/templates', icon: Library },
  { label: 'AI', path: '/settings/ai', icon: Bot },
  { label: '关于', path: '/about', icon: CircleHelp },
];

function isItemActive(pathname: string, path: string) {
  if (path === '/workspace') return pathname === '/' || pathname === '/workspace';
  if (path === '/templates') return pathname.startsWith('/templates') || pathname === '/rules';
  return pathname === path;
}

export default function Sidebar() {
  const location = useLocation();

  return (
    <aside className="nav-rail" aria-label="主导航">
      <Link className="nav-brand" to="/workspace" aria-label="HaoXiang 公文工作台" title="HaoXiang 公文工作台">
        <span className="nav-brand-mark">Hx</span>
        <span className="nav-brand-rule" aria-hidden="true" />
      </Link>

      <nav className="nav-rail-items">
        {navigation.map(({ label, path, icon: Icon }) => {
          const active = isItemActive(location.pathname, path);
          return (
            <Link
              key={path}
              to={path}
              className={`nav-rail-item${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              title={label}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <a
        className="nav-author-mark"
        href="https://nextweb4.github.io/"
        target="_blank"
        rel="noreferrer"
        aria-label="HaoXiang Huang 个人网站"
        title="HaoXiang Huang"
      >
        HH
      </a>
    </aside>
  );
}
