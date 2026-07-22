/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Modifications (c) 2026 HaoXiang Huang (https://nextweb4.github.io/)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  FileInput,
  FileText,
  Library,
  ScanSearch,
  ShieldCheck,
  Trash2,
  WifiOff,
} from 'lucide-react';
import apiClient from '@/api/client';
import { detectActiveAI } from '@/lib/ai-status';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';

interface DocumentItem {
  id: number;
  filename: string;
  document_type?: string;
  status: string;
  paragraph_count?: number;
  created_at: string;
}

interface HealthResponse {
  status: string;
  version?: string;
}

interface RulesResponse {
  rules: unknown[];
  total: number;
}

type ApiError = {
  response?: {
    data?: {
      detail?: string;
    };
  };
};

function formatRelativeDate(iso: string, language: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (language === 'en') {
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    if (diffHour < 24) return `${diffHour} hours ago`;
    if (diffDay < 7) return `${diffDay} days ago`;
  } else {
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;
  }
  return date.toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' });
}

function todayLabel(language: string): string {
  return new Date().toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}

function statusInfo(status: string): { label: string; colorClass: string } {
  switch (status) {
    case 'uploaded':
      return { label: '待校审', colorClass: 'is-pending' };
    case 'checked':
      return { label: '已校审', colorClass: 'is-reviewed' };
    case 'optimized':
      return { label: '已优化', colorClass: 'is-complete' };
    case 'error':
      return { label: '处理失败', colorClass: 'is-error' };
    default:
      return { label: status, colorClass: 'is-pending' };
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function checkRouteForDocument(document: Pick<DocumentItem, 'id' | 'document_type'>): string {
  const params = new URLSearchParams({ docId: String(document.id) });
  if (document.document_type?.trim()) params.set('type', document.document_type.trim());
  return `/document/check?${params.toString()}`;
}

export default function Workspace() {
  const { i18n } = useTranslation();
  const { confirm, success, error: showError } = useToast();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [backendVersion, setBackendVersion] = useState('');
  const [ruleCount, setRuleCount] = useState(0);
  const [aiModel, setAiModel] = useState('');
  const [loading, setLoading] = useState(true);
  const stateRef = useRef({ setDocuments, setHealthOk, setBackendVersion, setRuleCount, setAiModel, setLoading });

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      try {
        const [docRes, healthRes, ruleRes, aiRes] = await Promise.allSettled([
          apiClient.get('/api/documents/?skip=0&limit=50'),
          apiClient.get('/api/health'),
          apiClient.get('/api/rules/?source=all'),
          detectActiveAI(),
        ]);

        if (cancelled) return;

        if (docRes.status === 'fulfilled') {
          const data = docRes.value as DocumentItem[] | { documents?: DocumentItem[] };
          const list = Array.isArray(data)
            ? data
            : ((data as Record<string, unknown>).documents as DocumentItem[] | undefined) ?? [];
          stateRef.current.setDocuments(list);
        }

        if (healthRes.status === 'fulfilled') {
          const health = healthRes.value as HealthResponse;
          stateRef.current.setHealthOk(health.status === 'ok');
          stateRef.current.setBackendVersion(health.version ?? '');
        } else {
          stateRef.current.setHealthOk(false);
        }

        if (ruleRes.status === 'fulfilled') {
          const rules = ruleRes.value as RulesResponse;
          stateRef.current.setRuleCount(rules.total ?? 0);
        }

        if (aiRes.status === 'fulfilled') {
          const ai = aiRes.value;
          stateRef.current.setAiModel(
            ai && ai.exists && ai.active ? `${ai.provider ?? 'AI'} / ${ai.model ?? '默认'}` : '',
          );
        }

        stateRef.current.setLoading(false);
      } catch {
        if (!cancelled) stateRef.current.setLoading(false);
      }
    }

    void loadDashboard();
    return () => { cancelled = true; };
  }, []);

  const handleDeleteRecentDocument = async (
    doc: DocumentItem,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!await confirm('删除最近文档', `确认删除“${doc.filename}”？此操作会移除文档记录和本地生成文件。`)) {
      return;
    }
    try {
      await apiClient.delete(`/api/documents/${doc.id}`);
      setDocuments(previous => previous.filter(item => item.id !== doc.id));
      success('已删除', `“${doc.filename}”已从最近文档移除`);
    } catch (error: unknown) {
      const apiError = error as ApiError;
      showError('删除失败', apiError.response?.data?.detail || '请稍后重试');
    }
  };

  const totalDocs = documents.length;
  const reviewedCount = documents.filter(item => item.status === 'checked' || item.status === 'optimized').length;
  const optimizedCount = documents.filter(item => item.status === 'optimized').length;
  const paragraphCount = documents.reduce((sum, item) => sum + (item.paragraph_count ?? 0), 0);
  const hasDocuments = totalDocs > 0;

  const metrics = [
    { label: '文档总量', value: totalDocs, note: '本机记录' },
    { label: '已校审', value: reviewedCount, note: '规则检查完成' },
    { label: '已优化', value: optimizedCount, note: '可直接导出' },
    { label: '段落总量', value: paragraphCount, note: '解析内容统计' },
  ];

  return (
    <div className="workspace-console">
      <section className="workspace-intro">
        <div>
          <span className="workspace-kicker">DOCUMENT DESK / {todayLabel(i18n.resolvedLanguage ?? 'zh')}</span>
          <h2>把待处理的公文，收束成清晰的下一步。</h2>
          <p>从导入、规则校审到规范导出，所有文档都在本机完成。</p>
        </div>
        <div className={`workspace-health ${healthOk === false ? 'is-offline' : ''}`}>
          {healthOk === null ? (
            <><Activity className="animate-pulse" aria-hidden="true" /><span>正在检测服务</span></>
          ) : healthOk ? (
            <><span className="workspace-health-dot" /><span>系统运行正常</span></>
          ) : (
            <><WifiOff aria-hidden="true" /><span>后端未连接</span></>
          )}
        </div>
      </section>

      <section className="workspace-metrics" aria-label="数据概览">
        {metrics.map((metric, index) => (
          <div className="workspace-metric" key={metric.label}>
            <span className="workspace-metric-index">0{index + 1}</span>
            <div>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.note}</small>
            </div>
          </div>
        ))}
      </section>

      <div className="workspace-grid">
        <section className="workspace-documents" aria-labelledby="recent-documents-title">
          <div className="workspace-section-heading">
            <div>
              <span>QUEUE</span>
              <h3 id="recent-documents-title">最近文档</h3>
            </div>
            {hasDocuments && (
              <Link to="/document/process">
                全部记录
                <ArrowRight aria-hidden="true" />
              </Link>
            )}
          </div>

          {loading ? (
            <div className="workspace-empty" role="status">
              <Activity className="animate-spin" aria-hidden="true" />
              <p>正在读取本机文档记录</p>
            </div>
          ) : !hasDocuments ? (
            <div className="workspace-empty">
              <FileText aria-hidden="true" />
              <h4>队列为空</h4>
              <p>导入第一份公文后，校审状态和最近操作会显示在这里。</p>
              <Link className="workspace-inline-action" to="/document/process">
                <FileInput aria-hidden="true" />
                导入公文
              </Link>
            </div>
          ) : (
            <div className="workspace-document-list">
              {documents.slice(0, 8).map(doc => {
                const status = statusInfo(doc.status);
                return (
                  <div className="workspace-document-row" key={doc.id}>
                    <Link to={checkRouteForDocument(doc)} className="workspace-document-link">
                      <FileText aria-hidden="true" />
                      <div className="workspace-document-name">
                        <strong>{doc.filename}</strong>
                        <span>{doc.document_type || '未识别文种'}</span>
                      </div>
                      <span className={`workspace-document-status ${status.colorClass}`}>{status.label}</span>
                      <span className="workspace-document-time">
                        <Clock3 aria-hidden="true" />
                        {formatRelativeDate(doc.created_at, i18n.resolvedLanguage ?? 'zh')}
                      </span>
                      <ArrowRight className="workspace-row-arrow" aria-hidden="true" />
                    </Link>
                    <button
                      type="button"
                      className="workspace-delete-button"
                      title="删除最近文档"
                      aria-label={`删除 ${doc.filename}`}
                      onClick={event => handleDeleteRecentDocument(doc, event)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <aside className="workspace-operations" aria-label="快捷操作与系统状态">
          <div className="workspace-operation-heading">
            <span>START</span>
            <h3>开始一项工作</h3>
          </div>

          <Link className="workspace-primary-operation" to="/document/process">
            <FileInput aria-hidden="true" />
            <div>
              <strong>导入公文</strong>
              <span>.docx / .doc / .wps</span>
            </div>
            <ArrowRight aria-hidden="true" />
          </Link>

          <div className="workspace-operation-links">
            <Link to="/templates">
              <Library aria-hidden="true" />
              <span><strong>选择模板</strong><small>从规范格式开始</small></span>
              <ArrowRight aria-hidden="true" />
            </Link>
            <Link to="/document/check">
              <ScanSearch aria-hidden="true" />
              <span><strong>继续校审</strong><small>查看规则问题</small></span>
              <ArrowRight aria-hidden="true" />
            </Link>
            <Link to="/settings/ai">
              <Bot aria-hidden="true" />
              <span><strong>本机 AI</strong><small>{aiModel || '尚未配置模型'}</small></span>
              <ArrowRight aria-hidden="true" />
            </Link>
          </div>

          <div className="workspace-ledger">
            <div>
              <ShieldCheck aria-hidden="true" />
              <span>校审规则</span>
              <strong>{i18n.resolvedLanguage === 'en' ? `${ruleCount} items` : `${ruleCount} 条`}</strong>
            </div>
            <div>
              <CheckCircle2 aria-hidden="true" />
              <span>应用版本</span>
              <strong>v{__APP_VERSION__}</strong>
            </div>
            <div>
              <Activity aria-hidden="true" />
              <span>后端版本</span>
              <strong>{backendVersion || '未连接'}</strong>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
