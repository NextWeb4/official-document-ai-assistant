/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/* eslint-disable react-refresh/only-export-components */

/**
 * useDocumentConfig — 公文格式配置 Context
 *
 * 管理所有排版参数（页边距、字体、字号、行距、版头版记等），
 * 设置变更即时反映到 A4 预览。配置持久化到 localStorage。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

export interface MarginConfig {
  top: number;    // cm
  bottom: number;
  left: number;
  right: number;
}

export interface TitleConfig {
  fontFamily: string;
  fontSize: number;      // pt
  bold: boolean;
  align: 'center' | 'left' | 'right';
}

export interface HeadingConfig {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  indent: number;        // em
}

export interface BodyConfig {
  fontFamily: string;
  asciiFontFamily: string;
  fontSize: number;
  lineSpacing: number;    // pt
  firstLineIndent: number; // em
  align: 'justify' | 'left' | 'right';
}

export interface HeaderConfig {
  enabled: boolean;
  orgName: string;        // 发文机关名称
  docNumber: string;      // 发文字号
  signer: string;         // 签发人
}

export interface FooterNoteConfig {
  enabled: boolean;
  cc: string;             // 抄送
  printer: string;        // 印发机关
  printDate: string;      // 印发日期
}

export interface PageNumberConfig {
  show: boolean;
  format: 'dash';         // — N —
}

export interface DocumentConfig {
  margins: MarginConfig;
  title: TitleConfig;
  heading1: HeadingConfig;
  heading2: HeadingConfig;
  heading3: HeadingConfig;
  body: BodyConfig;
  header: HeaderConfig;
  footerNote: FooterNoteConfig;
  pageNumber: PageNumberConfig;
}

/* ------------------------------------------------------------------ */
/*  默认值（GB/T 9704 标准）                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_CONFIG: DocumentConfig = {
  margins: { top: 3.7, bottom: 3.5, left: 2.8, right: 2.6 },
  title: { fontFamily: '方正小标宋简体', fontSize: 22, bold: false, align: 'center' },
  heading1: { fontFamily: '黑体', fontSize: 16, bold: false, indent: 2 },
  heading2: { fontFamily: '楷体_GB2312', fontSize: 16, bold: false, indent: 0 },
  heading3: { fontFamily: '仿宋_GB2312', fontSize: 16, bold: true, indent: 0 },
  body: { fontFamily: '仿宋_GB2312', asciiFontFamily: 'Times New Roman', fontSize: 16, lineSpacing: 28.95, firstLineIndent: 2, align: 'justify' },
  header: { enabled: false, orgName: '', docNumber: '', signer: '' },
  footerNote: { enabled: false, cc: '', printer: '', printDate: '' },
  pageNumber: { show: true, format: 'dash' },
};

/* ------------------------------------------------------------------ */
/*  Reducer                                                            */
/* ------------------------------------------------------------------ */

type Action =
  | { type: 'patch'; payload: Partial<DocumentConfig> }
  | { type: 'reset' }
  | { type: 'load'; payload: DocumentConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge<T extends object>(base: T, overlay: Partial<T>): T {
  const baseRecord = base as Record<string, unknown>;
  const overlayRecord = overlay as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseRecord };

  for (const key of Object.keys(overlayRecord)) {
    const val = overlayRecord[key];
    const baseVal = baseRecord[key];
    if (isRecord(val) && isRecord(baseVal)) {
      result[key] = deepMerge(baseVal, val);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }

  return result as T;
}

function reducer(state: DocumentConfig, action: Action): DocumentConfig {
  switch (action.type) {
    case 'patch':
      return deepMerge(state, action.payload);
    case 'reset':
      return { ...DEFAULT_CONFIG };
    case 'load':
      return deepMerge(DEFAULT_CONFIG, action.payload);
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface ConfigContextValue {
  config: DocumentConfig;
  patch: (partial: Partial<DocumentConfig>) => void;
  reset: () => void;
}

const DocumentConfigContext = createContext<ConfigContextValue | null>(null);

const STORAGE_KEY = 'gongwen_doc_config';

function loadFromStorage(): DocumentConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function DocumentConfigProvider({ children }: { children: ReactNode }) {
  const [config, dispatch] = useReducer(reducer, null, loadFromStorage);

  // 持久化
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const patch = useCallback((partial: Partial<DocumentConfig>) => dispatch({ type: 'patch', payload: partial }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const value = useMemo(() => ({ config, patch, reset }), [config, patch, reset]);

  return (
    <DocumentConfigContext.Provider value={value}>
      {children}
    </DocumentConfigContext.Provider>
  );
}

export function useDocumentConfig(): ConfigContextValue {
  const ctx = useContext(DocumentConfigContext);
  if (!ctx) throw new Error('useDocumentConfig must be used within DocumentConfigProvider');
  return ctx;
}
