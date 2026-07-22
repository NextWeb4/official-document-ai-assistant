/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */

/**
 * EnhancedA4Preview — 增强版 A4 预览页面
 *
 * 左侧：格式设置面板（边距/字体/版头版记/规则预览）
 * 右侧：实时 A4 预览（设置改动即时反映）
 *
 * 入口：
 * - ?docId=123  → 从后端加载已上传文档
 * - ?templateId=notice → 从后端加载模板规则生成预览
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Settings2, Eye, RotateCcw, Download, ChevronLeft,
  ZoomIn, ZoomOut, FileText, Loader2, Wand2, Upload, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiClient, downloadPostFile } from '@/api/client';
import {
  DocumentConfigProvider, useDocumentConfig, DEFAULT_CONFIG,
  type DocumentConfig,
} from '@/hooks/useDocumentConfig';
import { useToast } from '@/components/ui/toast';

/* ------------------------------------------------------------------ */
/*  字体映射                                                           */
/* ------------------------------------------------------------------ */

const FONT_MAP: Record<string, string> = {
  '方正小标宋简体': '"方正小标宋简体", "FZXiaoBiaoSong-B05S", serif',
  '方正小标宋_GBK': '"方正小标宋简体", "FZXiaoBiaoSong-B05S", serif',
  '黑体': '"黑体", "SimHei", sans-serif',
  '楷体_GB2312': '"楷体_GB2312", "KaiTi", serif',
  '楷体': '"楷体", "KaiTi", serif',
  '仿宋_GB2312': '"仿宋_GB2312", "FangSong", serif',
  '仿宋': '"仿宋", "FangSong", serif',
  '宋体': '"宋体", "SimSun", serif',
  'Times New Roman': '"Times New Roman", serif',
};

function ff(name?: string): string {
  if (!name) return '"仿宋_GB2312", "FangSong", serif';
  return FONT_MAP[name] || `"${name}", serif`;
}

function mmToCm(value: number | null | undefined, fallbackCm: number): number {
  return value == null ? fallbackCm : value / 10;
}

/* ------------------------------------------------------------------ */
/*  段落数据结构                                                        */
/* ------------------------------------------------------------------ */

interface DocParagraph {
  text: string;
  role?: string;
  is_heading: boolean;
  heading_level?: number;
  format: {
    alignment?: string;
    first_line_indent_pt?: number;
    font_name?: string;
    font_size_pt?: number;
    line_spacing_pt?: number;
  };
}

interface DocTableCellPara {
  text: string;
  format: { alignment?: string; font_name?: string; font_size_pt?: number; bold?: boolean };
}

interface DocTableCell {
  row: number;
  col: number;
  text: string;
  paragraphs: DocTableCellPara[];
}

interface DocTable {
  index: number;
  rows: number;
  cols: number;
  cells: DocTableCell[];
  insert_after_index?: number;
}

interface PreviewResponse {
  paragraphs?: DocParagraph[];
  tables?: DocTable[];
  page_setup?: {
    margin_top_mm?: number | null;
    margin_bottom_mm?: number | null;
    margin_left_mm?: number | null;
    margin_right_mm?: number | null;
  };
}

interface UploadedTemplateFile {
  id: string;
  name: string;
  original_filename?: string;
  created_at?: string;
  size?: number;
}

type ApiError = {
  response?: {
    data?: {
      detail?: string;
    };
  };
  message?: string;
};

function getErrorDetail(error: unknown, fallback: string) {
  const apiError = error as ApiError;
  return apiError.response?.data?.detail || apiError.message || fallback;
}

/* ------------------------------------------------------------------ */
/*  独立表单组件（定义在组件外部，避免重渲染导致输入失焦）                    */
/* ------------------------------------------------------------------ */

const SettingsSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <h4 className="text-xs font-semibold text-primary-500 uppercase tracking-wider mb-2">{title}</h4>
    <div className="space-y-2">{children}</div>
  </div>
);

const NumberField = ({ label, value, onChange, min, max, step = 1, suffix }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) => (
  <div className="flex items-center gap-2">
    <label className="text-xs text-primary-600 w-10 shrink-0">{label}</label>
    <input
      type="number" value={value}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      min={min} max={max} step={step}
      className="flex-1 border border-primary-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent"
    />
    {suffix && <span className="text-xs text-primary-400">{suffix}</span>}
  </div>
);

const SelectField = ({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) => (
  <div className="flex items-center gap-2">
    <label className="text-xs text-primary-600 w-10 shrink-0">{label}</label>
    <select value={value} onChange={e => onChange(e.target.value)}
      className="flex-1 border border-primary-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent">
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  </div>
);

type DebouncedTextFieldKey =
  | 'header.orgName'
  | 'header.docNumber'
  | 'header.signer'
  | 'footerNote.cc'
  | 'footerNote.printer'
  | 'footerNote.printDate';

type RegisterPendingTextFlush = (
  key: DebouncedTextFieldKey,
  flush: () => void,
) => () => void;

function applyTextFieldValue(
  config: DocumentConfig,
  key: DebouncedTextFieldKey,
  value: string,
): DocumentConfig {
  const [section, field] = key.split('.') as [
    'header' | 'footerNote',
    keyof DocumentConfig['header'] | keyof DocumentConfig['footerNote'],
  ];

  if (section === 'header') {
    return { ...config, header: { ...config.header, [field]: value } };
  }
  return { ...config, footerNote: { ...config.footerNote, [field]: value } };
}

/** 带防抖的文本输入（解决逐字输入卡顿问题） */
function TextField({ label, value, onChange, placeholder, hint, fieldKey, registerFlush }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  fieldKey: DebouncedTextFieldKey;
  registerFlush: RegisterPendingTextFlush;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localRef = useRef(value);
  const dirtyRef = useRef(false);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // 外部 value 变化时同步到 local
  useEffect(() => {
    if (dirtyRef.current) return;
    localRef.current = value;
    void Promise.resolve().then(() => setLocal(value));
  }, [value]);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onChangeRef.current(localRef.current);
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    localRef.current = v;
    dirtyRef.current = true;
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [flush]);

  useEffect(() => registerFlush(fieldKey, flush), [fieldKey, flush, registerFlush]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-primary-600 w-14 shrink-0">{label}</label>
        <input
          type="text" value={local} onChange={handleChange} onBlur={flush} placeholder={placeholder}
          className="flex-1 border border-primary-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      {hint && <p className="text-[10px] text-primary-400 mt-0.5 ml-14">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  主页面包装器                                                        */
/* ------------------------------------------------------------------ */

export default function EnhancedA4PreviewPage() {
  return (
    <DocumentConfigProvider>
      <EnhancedA4PreviewInner />
    </DocumentConfigProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  内部组件                                                            */
/* ------------------------------------------------------------------ */

function EnhancedA4PreviewInner() {
  const [searchParams] = useSearchParams();
  const docId = searchParams.get('docId');
  const templateId = searchParams.get('templateId');

  const { config, patch, reset } = useDocumentConfig();
  const { error: showError, success } = useToast();

  const [paragraphs, setParagraphs] = useState<DocParagraph[]>([]);
  const [tables, setTables] = useState<DocTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [zoom, setZoom] = useState(85);
  const [activeTab, setActiveTab] = useState<'format' | 'rules'>('format');
  const [converting, setConverting] = useState(false);
  const [sourceFilename, setSourceFilename] = useState('公文预览.docx');
  const [templateFiles, setTemplateFiles] = useState<UploadedTemplateFile[]>([]);
  const [selectedTemplateFileId, setSelectedTemplateFileId] = useState('');
  const [templateUploading, setTemplateUploading] = useState(false);
  const templateFileInputRef = useRef<HTMLInputElement | null>(null);
  const configRef = useRef(config);
  const pendingTextFlushesRef = useRef(new Map<DebouncedTextFieldKey, () => void>());

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const commitTextField = useCallback((key: DebouncedTextFieldKey, value: string) => {
    const nextConfig = applyTextFieldValue(configRef.current, key, value);
    configRef.current = nextConfig;
    if (key.startsWith('header.')) patch({ header: nextConfig.header });
    else patch({ footerNote: nextConfig.footerNote });
  }, [patch]);

  const registerPendingTextFlush = useCallback<RegisterPendingTextFlush>((key, flush) => {
    pendingTextFlushesRef.current.set(key, flush);
    return () => {
      flush();
      if (pendingTextFlushesRef.current.get(key) === flush) {
        pendingTextFlushesRef.current.delete(key);
      }
    };
  }, []);

  const flushPendingTextEdits = useCallback(() => {
    for (const flush of pendingTextFlushesRef.current.values()) flush();
    return configRef.current;
  }, []);

  useEffect(() => () => {
    flushPendingTextEdits();
  }, [flushPendingTextEdits]);

  const handleTabChange = (tab: 'format' | 'rules') => {
    flushPendingTextEdits();
    setActiveTab(tab);
  };

  // 一键优化 Markdown（用 useCallback 稳定引用，避免 SettingsPanel 重建）
  const paragraphsRef = useRef(paragraphs);

  useEffect(() => {
    paragraphsRef.current = paragraphs;
  }, [paragraphs]);

  const handleConvertMarkdown = useCallback(async () => {
    setConverting(true);
    try {
      const resp = await apiClient.post('/api/optimize/convert-markdown', {
        paragraphs: paragraphsRef.current.map(p => ({
          text: p.text, role: p.role, is_heading: p.is_heading,
          heading_level: p.heading_level, format: p.format,
        })),
      }, { timeout: 30000 });
      console.log('[Markdown转换] 响应:', { success: resp.success, paragraphs: resp.paragraphs?.length, tables: resp.tables?.length, tableRows: resp.tables?.[0]?.rows, tableCols: resp.tables?.[0]?.cols });
      if (resp.success && resp.paragraphs) {
        setParagraphs(resp.paragraphs);
        if (resp.tables && resp.tables.length > 0) {
          console.log('[Markdown转换] 设置表格:', resp.tables);
          setTables(resp.tables);
        }
      }
    } catch (err) {
      console.error('[Markdown转换] 失败:', err);
    } finally {
      setConverting(false);
    }
  }, []);

  const loadUploadedTemplateFiles = useCallback(async () => {
    try {
      const resp = await apiClient.get('/api/templates/files/list');
      const list = Array.isArray(resp?.templates) ? resp.templates : [];
      setTemplateFiles(list);
      setSelectedTemplateFileId(current => current || list[0]?.id || '');
    } catch (err) {
      console.error('Load uploaded template files failed:', err);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadUploadedTemplateFiles);
  }, [loadUploadedTemplateFiles]);

  const handleUploadTemplateFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setTemplateUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await apiClient.post('/api/templates/files/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 60000,
      });
      await loadUploadedTemplateFiles();
      if (resp?.template?.id) setSelectedTemplateFileId(resp.template.id);
      success('模板已上传', file.name);
    } catch (err: unknown) {
      showError('模板上传失败', getErrorDetail(err, '请检查模板文件'));
    } finally {
      setTemplateUploading(false);
      event.target.value = '';
    }
  };

  const handleDeleteTemplateFile = async () => {
    if (!selectedTemplateFileId) return;
    const selected = templateFiles.find(item => item.id === selectedTemplateFileId);
    try {
      await apiClient.delete(`/api/templates/files/${selectedTemplateFileId}`);
      await loadUploadedTemplateFiles();
      setSelectedTemplateFileId('');
      success('模板已删除', selected?.name || '上传模板');
    } catch (err: unknown) {
      showError('删除模板失败', getErrorDetail(err, '请稍后重试'));
    }
  };

  const handleExportWithTemplateFile = async () => {
    flushPendingTextEdits();
    if (!selectedTemplateFileId) {
      showError('请选择模板', '请先上传或选择一个 .docx/.dotx 模板');
      return;
    }
    if (paragraphs.length === 0 && tables.length === 0) {
      showError('无法套用模板', '当前没有可导出的文档内容');
      return;
    }
    try {
      await downloadPostFile(
        `/api/templates/files/${selectedTemplateFileId}/apply-preview/download`,
        {
          paragraphs: paragraphs.map(p => ({
            text: p.text,
            role: p.role,
            is_heading: p.is_heading,
            heading_level: p.heading_level,
            format: p.format,
          })),
          tables: tables.length > 0 ? tables : undefined,
          source_filename: sourceFilename,
        },
        '套用模板.docx',
      );
      success('导出完成', '已按模板格式生成新文件');
    } catch (err: unknown) {
      showError('套用模板失败', getErrorDetail(err, '请检查模板格式后重试'));
    }
  };

  const handlePreviewExport = async () => {
    const exportConfig = flushPendingTextEdits();
    try {
      await downloadPostFile('/api/optimize/preview-download', {
        paragraphs: paragraphs.map(p => ({
          text: p.text,
          role: p.role,
          is_heading: p.is_heading,
          heading_level: p.heading_level,
          format: p.format,
        })),
        tables: tables.length > 0 ? tables : undefined,
        page_setup: {
          margin_top_mm: exportConfig.margins.top * 10,
          margin_bottom_mm: exportConfig.margins.bottom * 10,
          margin_left_mm: exportConfig.margins.left * 10,
          margin_right_mm: exportConfig.margins.right * 10,
        },
        format_config: exportConfig,
        source_filename: sourceFilename,
      }, '公文预览.docx');
      success('导出完成', '已生成并下载预览文档');
    } catch (e: unknown) {
      console.error('Preview download failed:', e);
      showError('导出失败', getErrorDetail(e, '字体替换或文档生成失败，请检查后重试'));
    }
  };

  // 从后端加载数据
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        let resp: PreviewResponse;
        let nextSourceFilename = '公文预览.docx';
        if (templateId) {
          resp = await apiClient.post(`/api/templates/${templateId}/preview`, {}, { timeout: 30000 });
          nextSourceFilename = `${templateId}.docx`;
        } else if (docId) {
          const [previewResp, docInfo] = await Promise.all([
            apiClient.get(`/api/documents/${docId}/preview`),
            apiClient.get(`/api/documents/${docId}`),
          ]);
          resp = previewResp;
          nextSourceFilename = docInfo?.filename || `document_${docId}.docx`;
        } else {
          setError('未指定文档或模板');
          return;
        }
        if (cancelled) return;
        setSourceFilename(nextSourceFilename);
        setParagraphs(resp.paragraphs || []);
        setTables(resp.tables || []);
        if (resp.page_setup) {
          patch({
            margins: {
              top: mmToCm(resp.page_setup.margin_top_mm, DEFAULT_CONFIG.margins.top),
              bottom: mmToCm(resp.page_setup.margin_bottom_mm, DEFAULT_CONFIG.margins.bottom),
              left: mmToCm(resp.page_setup.margin_left_mm, DEFAULT_CONFIG.margins.left),
              right: mmToCm(resp.page_setup.margin_right_mm, DEFAULT_CONFIG.margins.right),
            },
          });
        }
      } catch (err: unknown) {
        const detail = err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
        if (!cancelled) setError(detail || '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [docId, templateId, patch]);

  // 分离段落
  const title = paragraphs.find(p => p.role === 'title' || (p.is_heading && p.heading_level === 0));
  const recipient = paragraphs.find(p => p.role === 'recipient');
  const body = paragraphs.filter(p =>
    p.role === 'body' || p.role === 'attachment' ||
    (p.is_heading && p.heading_level && p.heading_level >= 1 && p.role !== 'title')
  );
  const signature = paragraphs.find(p => p.role === 'signature');
  const date = paragraphs.find(p => p.role === 'date');

  /* ---- 渲染单个段落（使用 config 驱动格式） ---- */

  const renderP = (p: DocParagraph, key: number) => {
    let fs = config.body.fontSize;
    let font = ff(config.body.fontFamily);
    const lh = `${config.body.lineSpacing}pt`;
    let indent = config.body.firstLineIndent > 0 ? `${config.body.firstLineIndent * config.body.fontSize}pt` : undefined;
    let align: React.CSSProperties['textAlign'] = config.body.align;
    let bold: boolean | undefined;

    if (p.is_heading && p.heading_level === 0) {
      fs = config.title.fontSize; font = ff(config.title.fontFamily);
      align = config.title.align; indent = undefined; bold = config.title.bold;
    } else if (p.is_heading && p.heading_level === 1) {
      fs = config.heading1.fontSize; font = ff(config.heading1.fontFamily);
      indent = config.heading1.indent > 0 ? `${config.heading1.indent * config.heading1.fontSize}pt` : undefined;
    } else if (p.is_heading && p.heading_level === 2) {
      fs = config.heading2.fontSize; font = ff(config.heading2.fontFamily);
    } else if (p.is_heading && p.heading_level === 3) {
      fs = config.heading3.fontSize; font = ff(config.heading3.fontFamily); bold = config.heading3.bold;
    }

    const style: React.CSSProperties = {
      fontSize: `${fs}pt`, fontFamily: font, lineHeight: lh,
      textAlign: align, textIndent: indent,
      margin: 0, padding: 0, fontWeight: bold ? 'bold' : undefined,
    };
    // 空行处理：无文字时用紧凑行高，避免多余空白
    const isEmpty = !p.text || p.text.trim() === '';
    if (isEmpty) {
      style.lineHeight = '0.6';
      style.minHeight = `${config.body.lineSpacing * 0.5}pt`;
    }
    return <p key={key} style={style}>{p.text || ' '}</p>;
  };

  /* ---- 渲染表格（markdown 转换生成的 Table 对象） ---- */

  const renderTable = (table: DocTable, key: number) => {
    const cellMap: Record<string, DocTableCell> = {};
    for (const c of table.cells) {
      cellMap[`${c.row}-${c.col}`] = c;
    }
    return (
      <table key={`table-${key}`} style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: `${Math.max(config.body.fontSize - 2, 12)}pt`,
        fontFamily: ff(config.body.fontFamily),
        lineHeight: `${config.body.lineSpacing}pt`,
        margin: '0.5em 0',
      }}>
        <tbody>
          {Array.from({ length: table.rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: table.cols }, (_, c) => {
                const cell = cellMap[`${r}-${c}`];
                const cellText = cell?.paragraphs?.map(cp => cp.text).join('') || cell?.text || '';
                const isHeader = r === 0;
                return (
                  <td key={c} style={{
                    border: '1px solid #000',
                    padding: '4pt 6pt',
                    textAlign: isHeader ? 'center' : 'left',
                    fontWeight: isHeader ? 'bold' : undefined,
                    fontFamily: ff(isHeader ? '黑体' : config.body.fontFamily),
                    verticalAlign: 'top',
                  }}>
                    {cellText}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  // 用 ref 绑定 config/patch，让 SettingsPanel 函数引用完全稳定
  /* ---- 设置面板（函数引用稳定，不会导致子组件重建） ---- */

  const renderSettingsPanel = () => {
    const cfg = config;
    const p = patch;
    const rst = reset;
    return (
    <div className="space-y-4 text-sm">
      {/* 一键优化 Markdown */}
      <button
        onClick={handleConvertMarkdown}
        disabled={converting}
        className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
      >
        {converting ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> 正在转换...</>
        ) : (
          <><Wand2 className="h-4 w-4" /> 一键优化 Markdown</>
        )}
      </button>
      <p className="text-[10px] text-primary-400 text-center">
        识别 # 标题、**加粗**、列表等 Markdown 语法并转为公文格式
      </p>

      {/* 页边距 */}
      <SettingsSection title="页边距 (cm)">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="上" value={cfg.margins.top} onChange={v => p({ margins: { ...cfg.margins, top: v } })} min={1} max={5} step={0.1} />
          <NumberField label="下" value={cfg.margins.bottom} onChange={v => p({ margins: { ...cfg.margins, bottom: v } })} min={1} max={5} step={0.1} />
          <NumberField label="左" value={cfg.margins.left} onChange={v => p({ margins: { ...cfg.margins, left: v } })} min={1} max={5} step={0.1} />
          <NumberField label="右" value={cfg.margins.right} onChange={v => p({ margins: { ...cfg.margins, right: v } })} min={1} max={5} step={0.1} />
        </div>
      </SettingsSection>

      {/* 公文标题 */}
      <SettingsSection title="公文标题">
        <SelectField label="字体" value={cfg.title.fontFamily} options={['方正小标宋简体', '黑体', '宋体']} onChange={v => p({ title: { ...cfg.title, fontFamily: v } })} />
        <NumberField label="字号" value={cfg.title.fontSize} onChange={v => p({ title: { ...cfg.title, fontSize: v } })} min={12} max={36} step={1} suffix="pt" />
      </SettingsSection>

      {/* 正文 */}
      <SettingsSection title="正文">
        <SelectField label="字体" value={cfg.body.fontFamily} options={['仿宋_GB2312', '宋体', '楷体_GB2312']} onChange={v => p({ body: { ...cfg.body, fontFamily: v } })} />
        <SelectField label="数字" value={cfg.body.asciiFontFamily} options={['Times New Roman', '仿宋_GB2312', '宋体', '楷体_GB2312', '黑体']} onChange={v => p({ body: { ...cfg.body, asciiFontFamily: v } })} />
        <NumberField label="字号" value={cfg.body.fontSize} onChange={v => p({ body: { ...cfg.body, fontSize: v } })} min={10} max={24} step={1} suffix="pt" />
        <NumberField label="行距" value={cfg.body.lineSpacing} onChange={v => p({ body: { ...cfg.body, lineSpacing: v } })} min={20} max={40} step={0.5} suffix="pt" />
        <NumberField label="缩进" value={cfg.body.firstLineIndent} onChange={v => p({ body: { ...cfg.body, firstLineIndent: v } })} min={0} max={4} step={0.5} suffix="em" />
      </SettingsSection>

      {/* 版头设置 */}
      <SettingsSection title="版头设置">
        <label className="flex items-center gap-2 mb-2">
          <input type="checkbox" checked={cfg.header.enabled} onChange={e => p({ header: { ...cfg.header, enabled: e.target.checked } })} className="w-4 h-4" />
          <span className="font-medium">启用版头</span>
        </label>
        {cfg.header.enabled && (
          <div className="space-y-2 ml-1 pl-3 border-l-2 border-primary-100">
            <TextField fieldKey="header.orgName" registerFlush={registerPendingTextFlush} label="发文机关" value={cfg.header.orgName} onChange={v => commitTextField('header.orgName', v)} placeholder="国务院办公厅文件" hint="全称+文件，红色方正小标宋居中" />
            <TextField fieldKey="header.docNumber" registerFlush={registerPendingTextFlush} label="发文字号" value={cfg.header.docNumber} onChange={v => commitTextField('header.docNumber', v)} placeholder="国办发〔2024〕1号" hint="机关代字〔年份〕序号号，六角括号" />
            <TextField fieldKey="header.signer" registerFlush={registerPendingTextFlush} label="签发人" value={cfg.header.signer} onChange={v => commitTextField('header.signer', v)} placeholder="张三" hint="仅上行文，签发人三字仿宋+姓名楷体" />
          </div>
        )}
      </SettingsSection>

      {/* 版记设置 */}
      <SettingsSection title="版记设置">
        <label className="flex items-center gap-2 mb-2">
          <input type="checkbox" checked={cfg.footerNote.enabled} onChange={e => p({ footerNote: { ...cfg.footerNote, enabled: e.target.checked } })} className="w-4 h-4" />
          <span className="font-medium">启用版记</span>
        </label>
        {cfg.footerNote.enabled && (
          <div className="space-y-2 ml-1 pl-3 border-l-2 border-primary-100">
            <TextField fieldKey="footerNote.cc" registerFlush={registerPendingTextFlush} label="抄送" value={cfg.footerNote.cc} onChange={v => commitTextField('footerNote.cc', v)} placeholder="XX局，XX办" hint="抄送机关名称" />
            <TextField fieldKey="footerNote.printer" registerFlush={registerPendingTextFlush} label="印发机关" value={cfg.footerNote.printer} onChange={v => commitTextField('footerNote.printer', v)} placeholder="XX市人民政府办公室" hint="版记最下方左侧" />
            <TextField fieldKey="footerNote.printDate" registerFlush={registerPendingTextFlush} label="印发日期" value={cfg.footerNote.printDate} onChange={v => commitTextField('footerNote.printDate', v)} placeholder="2026年1月1日" hint="版记最下方右侧，与印发机关同行" />
          </div>
        )}
      </SettingsSection>

      {/* 恢复默认 */}
      <Button variant="outline" size="sm" className="w-full" onClick={rst}>
        <RotateCcw className="h-3 w-3 mr-1" /> 恢复默认（GB/T 9704）
      </Button>
    </div>
    );
  };

  /* ---- 规则预览 ---- */

  const renderRulesPanel = () => {
    const rules = [
      { label: '标题', font: config.title.fontFamily, size: `${config.title.fontSize}pt`, align: config.title.align },
      { label: '正文', font: config.body.fontFamily, size: `${config.body.fontSize}pt`, spacing: `${config.body.lineSpacing}pt`, indent: `${config.body.firstLineIndent}em` },
      { label: '一级标题', font: config.heading1.fontFamily, size: `${config.heading1.fontSize}pt` },
      { label: '二级标题', font: config.heading2.fontFamily, size: `${config.heading2.fontSize}pt` },
      { label: '三级标题', font: config.heading3.fontFamily, size: `${config.heading3.fontSize}pt`, bold: config.heading3.bold ? '加粗' : '' },
      { label: '页边距', value: `上${config.margins.top} 下${config.margins.bottom} 左${config.margins.left} 右${config.margins.right} cm` },
      ...(config.header.enabled ? [{ label: '版头', value: config.header.orgName || '（未填写）' }] : []),
      ...(config.footerNote.enabled ? [{ label: '版记', value: `抄送: ${config.footerNote.cc || '无'}` }] : []),
    ];
    return (
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 px-2 bg-primary-50 rounded text-xs">
            <span className="font-medium text-primary-700">{r.label}</span>
            <span className="text-primary-500 text-right">
              {r.font && `${r.font} `}
              {r.size && `${r.size} `}
              {r.spacing && `行距${r.spacing} `}
              {r.indent && `缩进${r.indent} `}
              {r.align && `${r.align} `}
              {r.bold && `${r.bold} `}
              {r.value}
            </span>
          </div>
        ))}
      </div>
    );
  };

  /* ---- 主渲染 ---- */

  if (loading) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-primary-50">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-primary-50">
        <div className="text-center">
          <FileText className="h-12 w-12 text-primary-300 mx-auto mb-3" />
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-primary-50 overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-primary-200 shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setPanelOpen(!panelOpen)}>
            {panelOpen ? <ChevronLeft className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
          </Button>
          <span className="font-semibold text-primary-900">A4 实时预览</span>
          <Badge variant="outline">{paragraphs.length} 段落</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setZoom(z => Math.max(50, z - 10))}><ZoomOut className="h-4 w-4" /></Button>
          <span className="text-xs text-muted-foreground w-10 text-center">{zoom}%</span>
          <Button variant="ghost" size="sm" onClick={() => setZoom(z => Math.min(150, z + 10))}><ZoomIn className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" onClick={handlePreviewExport} title="下载预览文档">
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧设置面板 */}
        {panelOpen && (
          <div className="w-80 border-r border-primary-200 bg-white overflow-y-auto shrink-0">
            <div className="flex border-b border-primary-200 sticky top-0 bg-white z-10">
              <button className={`flex-1 py-2 text-sm font-medium ${activeTab === 'format' ? 'text-accent border-b-2 border-accent' : 'text-primary-500'}`} onClick={() => handleTabChange('format')}>
                <Settings2 className="h-3.5 w-3.5 inline mr-1" /> 格式设置
              </button>
              <button className={`flex-1 py-2 text-sm font-medium ${activeTab === 'rules' ? 'text-accent border-b-2 border-accent' : 'text-primary-500'}`} onClick={() => handleTabChange('rules')}>
                <Eye className="h-3.5 w-3.5 inline mr-1" /> 规则预览
              </button>
            </div>
            <div className="p-3">
              {docId && (
                <div className="mb-3 pb-3 border-b border-primary-100 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-primary-500 uppercase tracking-wider">模板基底</span>
                    <input
                      ref={templateFileInputRef}
                      type="file"
                      accept=".docx,.dotx"
                      className="hidden"
                      onChange={handleUploadTemplateFile}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={templateUploading}
                      onClick={() => templateFileInputRef.current?.click()}
                    >
                      {templateUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  <select
                    value={selectedTemplateFileId}
                    onChange={event => setSelectedTemplateFileId(event.target.value)}
                    className="w-full border border-primary-200 rounded px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="">未选择上传模板</option>
                    {templateFiles.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name || item.original_filename || item.id}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="flex-1 h-8"
                      disabled={!selectedTemplateFileId}
                      onClick={handleExportWithTemplateFile}
                    >
                      <Download className="h-3.5 w-3.5 mr-1" /> 套用导出
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-primary-400 hover:text-status-error"
                      disabled={!selectedTemplateFileId}
                      onClick={handleDeleteTemplateFile}
                      title="删除上传模板"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
              {activeTab === 'format' ? renderSettingsPanel() : renderRulesPanel()}
            </div>
          </div>
        )}

        {/* 右侧 A4 预览 */}
        <div className="flex-1 overflow-auto bg-gray-200 p-6">
          <div style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center' }}>
            <div style={{
              width: '210mm', minHeight: '297mm',
              padding: `${config.margins.top}cm ${config.margins.right}cm ${config.margins.bottom}cm ${config.margins.left}cm`,
              background: 'white', boxShadow: '0 2px 16px rgba(0,0,0,0.2)',
              margin: '0 auto', position: 'relative',
              fontFamily: ff(config.body.fontFamily), fontSize: `${config.body.fontSize}pt`,
              lineHeight: `${config.body.lineSpacing}pt`, color: '#000',
            }}>
              {/* === 版头区域（GB/T 9704-2012 标准，间距对齐 gongwen 项目） === */}
              {config.header.enabled && (
                <div style={{ marginBottom: `${config.body.lineSpacing * 2}pt` }}>
                  {/* 发文机关标志 — 红色方正小标宋简体，居中，30pt */}
                  {config.header.orgName && (
                    <p style={{
                      fontSize: '30pt',
                      fontFamily: ff('方正小标宋简体'),
                      color: '#E00000',
                      textAlign: 'center',
                      margin: '0',
                      padding: '0',
                      lineHeight: '1.4',
                      letterSpacing: '0',
                    }}>
                      {config.header.orgName}
                    </p>
                  )}

                  {/* 发文字号 + 签发人 — 标志下空二行 */}
                  {(config.header.docNumber || config.header.signer) && (
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      marginTop: `${config.body.lineSpacing * 2}pt`, // 下空二行
                      marginBottom: '4pt', // 反线上方紧凑间距
                      fontSize: `${config.body.fontSize}pt`,
                      lineHeight: `${config.body.lineSpacing}pt`,
                      fontFamily: ff(config.body.fontFamily),
                      // 有签发人时发文字号居左空一字，无签发人时居中
                      paddingLeft: config.header.signer ? '1em' : '0',
                    }}>
                      {/* 左侧：发文字号 */}
                      <span style={{ textAlign: config.header.signer ? 'left' : 'center', flex: 1 }}>
                        {config.header.docNumber}
                      </span>
                      {/* 右侧：签发人（仅上行文） */}
                      {config.header.signer && (
                        <span style={{ whiteSpace: 'nowrap', paddingRight: '1em' }}>
                          <span style={{ fontFamily: ff(config.body.fontFamily) }}>签发人：</span>
                          <span style={{ fontFamily: ff('楷体_GB2312') }}>{config.header.signer}</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* 红色反线（版头与正文的分隔线）— 反线下空二行到标题 */}
                  <hr style={{ border: 'none', borderTop: '2px solid #E00000', margin: '0' }} />
                </div>
              )}

              {/* 正文 + 表格（按 insert_after_index 交错渲染） */}
              {title && renderP(title, -1)}
              {recipient && renderP(recipient, -2)}
              {(() => {
                // 构建 insert_after_index → tables 映射
                const tableMap: Record<number, DocTable[]> = {};
                for (const t of tables) {
                  const idx = t.insert_after_index ?? -1;
                  if (!tableMap[idx]) tableMap[idx] = [];
                  tableMap[idx].push(t);
                }
                const elements: React.ReactNode[] = [];
                body.forEach((p, i) => {
                  elements.push(renderP(p, i));
                  // 在该段落之后插入对应的表格
                  if (tableMap[i]) {
                    for (const t of tableMap[i]) {
                      elements.push(renderTable(t, i));
                    }
                  }
                });
                // 插入在文档开头的表格（insert_after_index = -1）
                if (tableMap[-1]) {
                  for (const t of tableMap[-1]) {
                    elements.push(renderTable(t, -1));
                  }
                }
                // 插入在文档末尾的表格（insert_after_index 超出 body 范围）
                const maxIdx = body.length - 1;
                for (const [key, tList] of Object.entries(tableMap)) {
                  if (Number(key) > maxIdx && Number(key) !== -1) {
                    for (const t of tList) {
                      elements.push(renderTable(t, Number(key)));
                    }
                  }
                }
                return elements;
              })()}
              {/* 表格提示信息 */}
              {tables.length > 0 && (
                <div style={{ margin: '0.5em 0', padding: '4px 8px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '4px', fontSize: '10pt', color: '#0369a1', textAlign: 'center' }}>
                  已识别 {tables.length} 个表格（共 {tables.reduce((s, t) => s + t.rows, 0)} 行 × {tables[0]?.cols || 0} 列）
                </div>
              )}

              {(signature || date) && (
                <div style={{ marginTop: '3em' }}>
                  {signature && renderP({ ...signature, format: { ...signature.format, alignment: 'right' } }, -3)}
                  {date && renderP({ ...date, format: { ...date.format, alignment: 'right' } }, -4)}
                </div>
              )}

              {/* 版记 — GB/T 9704: 四号仿宋，抄送左空一字 */}
              {config.footerNote.enabled && (
                <div style={{ marginTop: '1em' }}>
                  <hr style={{ border: 'none', borderTop: '2px solid #000', margin: '0 0 0.5em 0' }} />
                  {config.footerNote.cc && (
                    <p style={{ fontSize: `${config.body.fontSize - 2}pt`, fontFamily: ff(config.body.fontFamily), paddingLeft: '1em', margin: 0, lineHeight: `${config.body.lineSpacing}pt` }}>
                      抄送：{config.footerNote.cc}
                    </p>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.3em' }}>
                    {config.footerNote.printer && (
                      <span style={{ fontSize: `${config.body.fontSize - 2}pt`, fontFamily: ff(config.body.fontFamily), paddingLeft: '1em' }}>
                        {config.footerNote.printer}
                      </span>
                    )}
                    {config.footerNote.printDate && (
                      <span style={{ fontSize: `${config.body.fontSize - 2}pt`, fontFamily: ff(config.body.fontFamily), paddingRight: '1em' }}>
                        {config.footerNote.printDate}
                      </span>
                    )}
                  </div>
                  <hr style={{ border: 'none', borderTop: '1px solid #000', margin: '0.5em 0 0 0' }} />
                </div>
              )}

              {/* 页码 — GB/T 9704: 四号宋体/Times New Roman，奇数页居右 */}
              {config.pageNumber.show && (
                <div style={{
                  position: 'absolute', bottom: `${config.margins.bottom - 0.7}cm`,
                  left: `${config.margins.left}cm`, right: `${config.margins.right + 0.35}cm`, textAlign: 'right',
                  fontSize: '14pt', fontFamily: '"宋体", "SimSun", "Times New Roman", serif',
                  letterSpacing: '0.5pt',
                }}>
                  — 1 —
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
