/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Modifications (c) 2026 HaoXiang Huang (https://nextweb4.github.io/)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { ExternalLink, HardDrive, Languages, Moon, Sun } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDomTranslation } from '@/i18n/useDomTranslation';
import Sidebar from './Sidebar';

interface AppLayoutProps {
  children: ReactNode;
}

type ThemeMode = 'dark' | 'light';

interface RouteMeta {
  index: string;
  title: string;
  description: string;
}

const routeMeta: Array<{ match: (path: string) => boolean; meta: RouteMeta }> = [
  {
    match: path => path === '/' || path === '/workspace',
    meta: { index: '01', title: '工作台', description: '文档、规则与本机服务概览' },
  },
  {
    match: path => path === '/document/process',
    meta: { index: '02', title: '文档处理', description: '导入、识别并生成规范公文' },
  },
  {
    match: path => path === '/document/check',
    meta: { index: '03', title: '校审中心', description: '核对规则问题与智能建议' },
  },
  {
    match: path => path.startsWith('/templates') || path === '/rules',
    meta: { index: '04', title: '模板与规则', description: '管理格式基底和校审规则' },
  },
  {
    match: path => path === '/settings/ai',
    meta: { index: '05', title: '本机 AI', description: '配置 Ollama 模型与连接状态' },
  },
  {
    match: path => path.includes('preview'),
    meta: { index: '06', title: '文档预览', description: '检查排版与导出效果' },
  },
  {
    match: path => path === '/about',
    meta: { index: '07', title: '关于', description: '产品、作者与开源许可' },
  },
];

function getStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  return window.localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  window.localStorage.setItem('theme', theme);
}

function getRouteMeta(path: string): RouteMeta {
  return routeMeta.find(item => item.match(path))?.meta ?? {
    index: '00',
    title: '公文工作台',
    description: '本机文档处理空间',
  };
}

export default function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const { i18n } = useTranslation();
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const meta = getRouteMeta(location.pathname);

  useDomTranslation();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <Sidebar />

      <main className="app-main">
        <header className="app-context-bar">
          <div className="app-route-context">
            <span className="app-route-index" aria-hidden="true">{meta.index}</span>
            <div className="min-w-0">
              <h1>{meta.title}</h1>
              <p>{meta.description}</p>
            </div>
          </div>

          <div className="app-context-actions">
            <span className="app-local-state" title="文档处理在本机完成">
              <HardDrive aria-hidden="true" />
              <span>本机处理</span>
            </span>
            <a
              className="app-author-link"
              href="https://nextweb4.github.io/"
              target="_blank"
              rel="noreferrer"
              title="访问 HaoXiang Huang 的个人网站"
            >
              <span>HaoXiang Huang</span>
              <ExternalLink aria-hidden="true" />
            </a>
            <button
              type="button"
              className="app-language-button"
              onClick={() => void i18n.changeLanguage(i18n.resolvedLanguage === 'en' ? 'zh' : 'en')}
              aria-label={i18n.resolvedLanguage === 'en' ? '切换到中文' : 'Switch to English'}
              title={i18n.resolvedLanguage === 'en' ? '切换到中文' : 'Switch to English'}
            >
              <Languages aria-hidden="true" />
              <span>{i18n.resolvedLanguage === 'en' ? '中文' : 'EN'}</span>
            </button>
            <button
              type="button"
              className="app-icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            >
              {theme === 'dark' ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </button>
          </div>
        </header>

        <div className="app-content-scroll">
          <div className="app-content-frame">{children}</div>
        </div>
      </main>
    </div>
  );
}
