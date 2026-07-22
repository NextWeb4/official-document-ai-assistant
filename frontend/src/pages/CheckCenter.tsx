/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * CheckCenter - 校审中心
 * 左侧：问题列表（点击选中 + 筛选 + 批量操作）
 * 右侧：AI 分析结果面板（调用已启用的 AI 配置进行智能分析）
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Download, Loader2, CheckSquare, Square, FileText,
  AlertCircle, AlertTriangle, Info, Sparkles, Send,
  Zap, Cpu, Settings2,
} from 'lucide-react';
import PageHeader from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { apiClient, downloadFile } from '@/api/client';
import { useToast } from '@/components/ui/toast';
import { detectActiveAI, type AIStatus } from '@/lib/ai-status';
import A4PreviewModal from '@/components/A4PreviewModal';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CheckIssue {
  id: number;
  severity: 'P0' | 'P1' | 'P2';
  check_type: string;
  rule_id?: string;
  location: string;
  original_text: string;
  suggested_fix: string;
  reason: string;
}

interface RuleIssueGroup {
  key: string;
  severity: string;
  check_type: string;
  rule_id?: string;
  reason: string;
  suggested_fix: string;
  issues: CheckIssue[];
}

interface DocumentMetadata {
  status: string;
  document_type?: string;
}

type CheckViewState = 'loading' | 'failed' | 'never-run' | 'verified-zero' | 'issues';

interface AIResult {
  success: boolean;
  provider: string;
  issues: AIssue[];
  raw_response: string;
  message?: string;
}

interface AIssue {
  type?: string;
  severity?: string;
  location?: string;
  original?: unknown;
  suggestion?: unknown;
  reason?: string;
  description?: string;
  message?: string;
  text?: string;
}

interface FailedSuggestion {
  index?: number;
  reason?: string;
  original?: unknown;
}

interface OptimizePayload {
  document_type: string;
  apply_fixes: boolean;
  selected_rule_ids?: string[];
}

type ApiError = {
  response?: {
    status?: number;
    data?: {
      detail?: string;
      message?: string;
    };
  };
  message?: string;
};

function getApiErrorDetail(error: unknown, fallback: string) {
  const apiError = error as ApiError;
  return apiError.response?.data?.detail || apiError.response?.data?.message || apiError.message || fallback;
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveDocumentType(queryType?: string | null, storedType?: string | null): string {
  return queryType?.trim() || storedType?.trim() || 'notice';
}

// eslint-disable-next-line react-refresh/only-export-components
export function deriveCheckViewState(documentStatus: string, issueCount: number): CheckViewState {
  if (documentStatus === 'error') return 'failed';
  if (issueCount > 0) return 'issues';
  if (documentStatus === 'uploaded') return 'never-run';
  return 'verified-zero';
}

// eslint-disable-next-line react-refresh/only-export-components
export function groupIssuesByRule(items: CheckIssue[]): RuleIssueGroup[] {
  const groups = new Map<string, RuleIssueGroup>();
  for (const issue of items) {
    const ruleId = issue.rule_id?.trim() || undefined;
    const key = ruleId ? `rule:${ruleId}` : `issue:${issue.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        severity: issue.severity,
        check_type: issue.check_type,
        rule_id: ruleId,
        reason: issue.reason,
        suggested_fix: issue.suggested_fix,
        issues: [],
      });
    }
    groups.get(key)!.issues.push(issue);
  }
  return Array.from(groups.values());
}

/* ------------------------------------------------------------------ */
/*  错误码中文解释映射                                                  */
/* ------------------------------------------------------------------ */

function getErrorExplanation(raw: string): { title: string; cause: string; fix: string } | null {
  const s = raw.toLowerCase();

  // HTTP 状态码
  if (s.includes('[401]') || s.includes('401') || s.includes('unauthorized'))
    return { title: '认证失败（401）', cause: 'API Key 无效、已过期或格式不正确', fix: '请到「AI 设置」页面重新输入正确的 API Key 并保存' };
  if (s.includes('[403]') || s.includes('403') || s.includes('forbidden'))
    return { title: '访问被拒绝（403）', cause: 'API Key 权限不足，或账户未开通该模型的访问权限', fix: '请检查 API Key 对应的账户是否有权限使用该模型' };
  if (s.includes('[404]') || s.includes('404') || s.includes('not found'))
    return { title: '接口不存在（404）', cause: 'Base URL 或模型名称配置错误', fix: '请到「AI 设置」页面检查 Base URL 是否正确（如 http://localhost:11434/v1）' };
  if (s.includes('[429]') || s.includes('429') || s.includes('rate limit') || s.includes('too many'))
    return { title: '请求频率超限（429）', cause: '短时间内请求次数过多，本机 AI 服务忙碌', fix: '请等待 1-2 分钟后重试，或检查是否有多余的请求占用资源' };
  if (s.includes('[500]') || s.includes('500') || s.includes('internal server'))
    return { title: '服务器内部错误（500）', cause: '本机 AI 服务异常', fix: '请重启本机 AI 服务后重试' };
  if (s.includes('[502]') || s.includes('502') || s.includes('bad gateway'))
    return { title: '网关错误（502）', cause: '本机 AI 服务网关异常', fix: '请检查本机 AI 服务是否正常运行' };
  if (s.includes('[503]') || s.includes('503') || s.includes('service unavailable'))
    return { title: '服务不可用（503）', cause: '本机 AI 服务暂时不可用', fix: '请稍后重试，或检查 Ollama 是否启动' };

  // AI 服务常见错误
  if (s.includes('invalid_api_key') || s.includes('invalid api key') || s.includes('incorrect api key'))
    return { title: 'API Key 无效', cause: '输入的 API Key 格式不正确或已失效', fix: '请到「AI 设置」页面重新输入正确的 API Key' };
  if (s.includes('insufficient_quota') || s.includes('quota') || s.includes('billing'))
    return { title: '本机服务拒绝请求', cause: '本机 AI 服务返回额度或权限相关错误', fix: '请检查本机模型服务配置' };
  if (s.includes('model') && (s.includes('not found') || s.includes('does not exist') || s.includes('unavailable')))
    return { title: '模型不可用', cause: '配置的模型名称不存在或已下线', fix: '请到「AI 设置」页面点击「获取模型」更新列表，选择一个可用的模型' };
  if (s.includes('context_length') || s.includes('token') && s.includes('exceed'))
    return { title: '文档内容过长', cause: '文档内容超出模型的最大 Token 限制', fix: '请尝试上传较短的文档，或联系开发者调整分段策略' };
  if (s.includes('timeout') || s.includes('timed out') || s.includes('etimedout'))
    return { title: '请求超时', cause: '本机 AI 服务响应时间过长，可能是模型未加载或服务繁忙', fix: '请确认 Ollama 已启动并稍后重试' };
  if (s.includes('econnrefused') || s.includes('econnreset') || s.includes('network') || s.includes('fetch failed'))
    return { title: '连接失败', cause: '无法连接到本机 AI 服务地址', fix: '请检查：①Ollama 是否启动 ②Base URL 是否为 localhost/127.0.0.1 ③端口是否正确' };
  if (s.includes('dns') || s.includes('enotfound'))
    return { title: '地址解析失败', cause: '无法解析 AI 服务地址', fix: '请使用 localhost 或 127.0.0.1 作为本机服务地址' };
  if (s.includes('后端服务未启动') || s.includes('econnrefused') || s.includes('127.0.0.1'))
    return { title: '后端服务未连接', cause: '本地后端服务（127.0.0.1:8765）未启动', fix: '请先启动公文智能校审助手桌面应用，确保后端服务正在运行' };

  return null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SEV: Record<string, { icon: typeof AlertCircle; label: string; badge: string; border: string; bg: string }> = {
  P0: { icon: AlertCircle, label: '严重', badge: 'bg-severity-p0-bg text-severity-p0', border: 'border-l-severity-p0', bg: 'bg-severity-p0-bg/30' },
  P1: { icon: AlertTriangle, label: '瑕疵', badge: 'bg-severity-p1-bg text-severity-p1', border: 'border-l-severity-p1', bg: 'bg-severity-p1-bg/30' },
  P2: { icon: Info, label: '建议', badge: 'bg-severity-p2-bg text-severity-p2', border: 'border-l-severity-p2', bg: 'bg-severity-p2-bg/30' },
};

/* ------------------------------------------------------------------ */
/*  CheckCenter Component                                              */
/* ------------------------------------------------------------------ */

export default function CheckCenter() {
  const { success, error: showError, warning, confirm } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<string>('all');
  const [issues, setIssues] = useState<CheckIssue[]>([]);
  const [checkState, setCheckState] = useState<CheckViewState>('loading');
  const [docId, setDocId] = useState<number | null>(null);
  const [documentType, setDocumentType] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isApplying, setIsApplying] = useState(false);
  const [isOptimized, setIsOptimized] = useState(false);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());

  // AI 分析状态
  const [aiResult, setAiResult] = useState<AIResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string>('');
  const [aiElapsed, setAiElapsed] = useState(0);
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [selectedAiIds, setSelectedAiIds] = useState<Set<number>>(new Set());
  const [isApplyingAi, setIsApplyingAi] = useState(false);
  const [showA4Preview, setShowA4Preview] = useState(false);
  const [a4RefreshKey, setA4RefreshKey] = useState(0);
  const aiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadRequestRef = useRef(0);
  const aiRequestRef = useRef(0);

  const fetchResults = useCallback(async (id: number, status: string, requestId: number) => {
    try {
      setCheckState('loading');
      setErrorMessage('');
      setSelectedRuleIds(new Set());
      const resp = await apiClient.get(`/api/check/${id}/results`);
      if (requestId !== loadRequestRef.current) return;
      if (!Array.isArray(resp)) throw new Error('校审结果响应格式无效');
      const nextIssues = resp as CheckIssue[];
      setIssues(nextIssues);
      setCheckState(deriveCheckViewState(status, nextIssues.length));
    } catch (error: unknown) {
      if (requestId !== loadRequestRef.current) return;
      setIssues([]);
      setErrorMessage(getApiErrorDetail(error, '获取检查结果失败'));
      setCheckState('failed');
    }
  }, []);

  const loadDocument = useCallback(async (
    id: number,
    queryType: string | null,
    requestId: number,
  ) => {
    try {
      setCheckState('loading');
      setErrorMessage('');
      const metadata = await apiClient.get(`/api/documents/${id}`) as DocumentMetadata;
      if (requestId !== loadRequestRef.current) return;
      const status = metadata.status || 'uploaded';
      setDocumentType(resolveDocumentType(queryType, metadata.document_type));
      setIsOptimized(status === 'optimized');
      await fetchResults(id, status, requestId);
    } catch (error: unknown) {
      if (requestId !== loadRequestRef.current) return;
      setIssues([]);
      setErrorMessage(getApiErrorDetail(error, '获取文档信息失败'));
      setCheckState('failed');
    }
  }, [fetchResults]);

  /* ---- 初始化 ---- */
  useEffect(() => {
    const requestId = ++loadRequestRef.current;
    ++aiRequestRef.current;
    if (aiTimerRef.current) {
      clearInterval(aiTimerRef.current);
      aiTimerRef.current = null;
    }
    const docIdParam = searchParams.get('docId');
    const parsedId = docIdParam ? Number.parseInt(docIdParam, 10) : Number.NaN;
    const queryType = searchParams.get('type');

    void Promise.resolve().then(() => {
      if (requestId !== loadRequestRef.current) return;
      setSelectedRuleIds(new Set());
      setSelectedAiIds(new Set());
      setAiResult(null);
      setAiError('');
      setAiLoading(false);
      detectActiveAI().then(setAiStatus).catch(() => {});

      if (!Number.isInteger(parsedId) || parsedId <= 0) {
        setDocId(null);
        setIssues([]);
        setErrorMessage('未找到有效的文档 ID，请先上传文档');
        setCheckState('failed');
        return;
      }

      setDocId(parsedId);
      void loadDocument(parsedId, queryType, requestId);
    });
  }, [searchParams, loadDocument]);

  /* ---- 筛选 + 分组 ---- */
  const filteredIssues = filter === 'all' ? issues : issues.filter(i => i.severity === filter);
  const p0 = issues.filter(i => i.severity === 'P0').length;
  const p1 = issues.filter(i => i.severity === 'P1').length;
  const p2 = issues.filter(i => i.severity === 'P2').length;
  const totalFixableRuleCount = new Set(
    issues.flatMap(issue => issue.rule_id ? [issue.rule_id] : []),
  ).size;

  // 修复器按 rule_id 执行，因此列表也按规则分组和选择。
  const groupedIssues = groupIssuesByRule(filteredIssues);
  const fixableRuleIds = groupedIssues.flatMap(group => group.rule_id ? [group.rule_id] : []);
  const allFilteredRulesSelected = fixableRuleIds.length > 0
    && fixableRuleIds.every(ruleId => selectedRuleIds.has(ruleId));

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  /* ---- 选择操作 ---- */
  const toggleRuleSelection = (ruleId: string) => {
    setSelectedRuleIds(prev => {
      const n = new Set(prev);
      if (n.has(ruleId)) n.delete(ruleId);
      else n.add(ruleId);
      return n;
    });
  };

  const toggleSelectAll = () => {
    setSelectedRuleIds(prev => {
      const n = new Set(prev);
      fixableRuleIds.forEach(ruleId => {
        if (allFilteredRulesSelected) n.delete(ruleId);
        else n.add(ruleId);
      });
      return n;
    });
  };

  /* ---- 修复操作 ---- */
  const executeCheck = async (id: number, statusAfterCheck: string): Promise<boolean> => {
    setCheckState('loading');
    setErrorMessage('');
    setSelectedRuleIds(new Set());
    try {
      const response = await apiClient.post(`/api/check/${id}`, {
        document_type: documentType,
      });
      if (!Array.isArray(response?.issues)) throw new Error('校审结果响应格式无效');
      const nextIssues = response.issues as CheckIssue[];
      setIssues(nextIssues);
      setCheckState(deriveCheckViewState(statusAfterCheck, nextIssues.length));
      return true;
    } catch (error: unknown) {
      setIssues([]);
      setErrorMessage(getApiErrorDetail(error, '执行校审失败'));
      setCheckState('failed');
      return false;
    }
  };

  const handleRunCheck = async () => {
    if (!docId) return;
    const checked = await executeCheck(docId, isOptimized ? 'optimized' : 'checked');
    if (!checked) showError('校审失败', '未能完成规则校审，请重试');
  };

  const handleApplyAll = async () => {
    if (!docId) return;
    const ruleIds = Array.from(new Set(
      issues.flatMap(issue => issue.rule_id ? [issue.rule_id] : []),
    )).sort();
    if (!ruleIds.length) return;
    if (!await confirm('确认', `确定要应用全部 ${ruleIds.length} 条问题规则吗？`)) return;
    await doApply(ruleIds);
  };

  const handleApplySelected = async () => {
    if (!docId) return;
    const ruleIds = Array.from(selectedRuleIds).sort();
    if (!ruleIds.length) { warning('提示', '请先勾选要应用的规则'); return; }
    if (!await confirm('确认', `应用选中的 ${ruleIds.length} 条规则修复？`)) return;
    await doApply(ruleIds);
  };

  const doApply = async (selectedRuleIds: string[] | null) => {
    setIsApplying(true);
    try {
      const payload: OptimizePayload = { document_type: documentType, apply_fixes: true };
      if (selectedRuleIds) payload.selected_rule_ids = selectedRuleIds;
      const r = await apiClient.post(`/api/optimize/${docId}`, payload);
      success('成功', `已应用 ${r.fixes_applied} 个修复`);
      setIsOptimized(true);
      setSelectedRuleIds(new Set());
      setA4RefreshKey(k => k + 1);
      if (docId) await fetchResults(docId, 'optimized', loadRequestRef.current);
    } catch (error: unknown) {
      showError('错误', '修复失败：' + getApiErrorDetail(error, '请重试'));
    } finally {
      setIsApplying(false);
    }
  };

  const handleDownload = () => {
    if (docId) downloadFile(`/api/optimize/${docId}/download`, `optimized_${docId}.docx`);
  };

  /* ---- AI 分析 ---- */
  const handleAiAnalyze = async () => {
    if (!docId) return;
    if (!aiStatus?.active) {
      setAiError('未找到已启用的 AI 配置，请先到 AI 设置中启用并保存配置');
      return;
    }
    const requestId = ++aiRequestRef.current;
    setAiLoading(true);
    setAiError('');
    setAiResult(null);
    setSelectedAiIds(new Set());
    setAiElapsed(0);

    // 启动计时器
    if (aiTimerRef.current) clearInterval(aiTimerRef.current);
    aiTimerRef.current = setInterval(() => {
      setAiElapsed(prev => prev + 1);
    }, 1000);

    try {
      const query = new URLSearchParams({ provider: aiStatus.provider });
      if (documentType) query.set('document_type', documentType);
      const resp = await apiClient.post(`/api/ai/analyze/${docId}?${query.toString()}`, null, { timeout: 120000 });
      if (requestId !== aiRequestRef.current) return;

      if (resp.success === false) {
        setAiError(resp.message || 'AI 分析返回失败');
        return;
      }

      setAiResult(resp);
      setSelectedAiIds(new Set());
    } catch (error: unknown) {
      if (requestId !== aiRequestRef.current) return;
      const apiError = error as ApiError;
      const status = apiError.response?.status || '';
      const detail = apiError.response?.data?.detail || '';
      const message = apiError.response?.data?.message || '';
      const errText = apiError.message || '';

      let errorMsg = 'AI 分析失败';
      if (status) errorMsg += ` [${status}]`;
      if (detail) errorMsg += `：${detail}`;
      else if (message) errorMsg += `：${message}`;
      else if (errText) errorMsg += `：${errText}`;

      setAiError(errorMsg);
    } finally {
      if (requestId === aiRequestRef.current) setAiLoading(false);
      if (requestId === aiRequestRef.current && aiTimerRef.current) {
        clearInterval(aiTimerRef.current);
        aiTimerRef.current = null;
      }
    }
  };

  /* ---- AI 建议选择 ---- */
  const toggleAiSelect = (idx: number) => {
    setSelectedAiIds(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const toggleAiSelectAll = () => {
    if (!aiResult?.issues?.length) return;
    if (selectedAiIds.size === aiResult.issues.length) {
      setSelectedAiIds(new Set());
    } else {
      setSelectedAiIds(new Set(aiResult.issues.map((_, i) => i)));
    }
  };

  /* ---- 应用 AI 建议 ---- */
  const handleApplyAiSuggestions = async () => {
    if (!docId || !aiResult?.issues) return;
    const selected = Array.from(selectedAiIds)
      .map(idx => aiResult.issues[idx])
      .filter(item =>
        item?.original !== undefined &&
        item?.original !== null &&
        item?.suggestion !== undefined &&
        item?.suggestion !== null &&
        String(item.original).trim() &&
        String(item.suggestion).trim() &&
        String(item.original).trim() !== String(item.suggestion).trim()
      );
    if (!selected.length) {
      showError('提示', '选中的建议中没有可应用的原文/修改对');
      return;
    }
    if (!await confirm('确认', `将应用 ${selected.length} 项 AI 建议到文档？`)) return;
    setIsApplyingAi(true);
    try {
      const r = await apiClient.post(`/api/ai/apply/${docId}`, {
        suggestions: selected.map(item => ({
          original: String(item.original).trim(),
          suggestion: String(item.suggestion).trim(),
          location: item.location,
        })),
      });
      if (r.success) {
        const failed: FailedSuggestion[] = Array.isArray(r.failed_suggestions) ? r.failed_suggestions : [];
        if (failed.length > 0) {
          const preview = failed
            .slice(0, 3)
            .map((item) => `#${item.index || '?'} ${item.reason || '未完成'}：${item.original || ''}`)
            .join('；');
          warning('部分应用成功', `${r.message || `已应用 ${r.applied_count} 项建议`}。${preview}`);
        } else {
          success('成功', r.message || `已应用 ${r.applied_count} 项建议`);
        }
        setIsOptimized(true);
        setA4RefreshKey(k => k + 1);
        setSelectedAiIds(new Set());
        const checked = await executeCheck(docId, 'optimized');
        if (!checked) warning('重新校审失败', '文档已应用 AI 建议，但校审结果未能刷新');
      } else {
        const failed: FailedSuggestion[] = Array.isArray(r.failed_suggestions) ? r.failed_suggestions : [];
        const preview = failed
          .slice(0, 3)
          .map((item) => `#${item.index || '?'} ${item.reason || '未匹配'}：${item.original || ''}`)
          .join('；');
        showError('提示', preview ? `${r.message || '应用失败'}。${preview}` : (r.message || '应用失败'));
      }
    } catch (error: unknown) {
      showError('错误', '应用失败：' + getApiErrorDetail(error, '请重试'));
    } finally {
      setIsApplyingAi(false);
    }
  };

  /* ---- 渲染 ---- */
  if (checkState === 'loading') return <div className="w-full h-full flex items-center justify-center bg-primary-50"><Loader2 className="h-10 w-10 animate-spin text-accent" /></div>;
  if (errorMessage && !docId) return (
    <div className="w-full flex items-center justify-center bg-primary-50" style={{ height: '100%' }}>
      <div className="text-center">
        <FileText className="h-16 w-16 text-primary-300 mx-auto mb-4" />
        <p className="text-base font-medium text-foreground mb-2">暂无文档</p>
        <p className="text-sm text-muted-foreground mb-4">{errorMessage}</p>
        <a href="#/document/process" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors text-sm">
          前往上传文档
        </a>
      </div>
    </div>
  );
  if (checkState === 'failed') return (
    <div className="w-full flex items-center justify-center bg-primary-50" style={{ height: '100%' }}>
      <div className="text-center max-w-md px-6">
        <AlertCircle className="h-14 w-14 text-status-error mx-auto mb-4" />
        <p className="text-base font-medium text-foreground mb-2">校审未完成</p>
        <p className="text-sm text-muted-foreground mb-4">{errorMessage || '校审过程发生错误，请重新校审'}</p>
        <Button onClick={handleRunCheck}>重新校审</Button>
      </div>
    </div>
  );

  const checkDescription = checkState === 'issues'
    ? `共 ${issues.length} 个问题 · P0:${p0} P1:${p1} P2:${p2}`
    : checkState === 'verified-zero'
      ? '校审完成，未发现规则问题'
      : '尚未执行规则校审';

  return (
    <div className="w-full flex flex-col bg-primary-50" style={{ height: '100%' }}>
      {/* ===== 顶部操作栏 ===== */}
      <PageHeader
        title="校审中心"
        description={checkDescription}
        actions={<div className="flex gap-2 flex-wrap">
          {selectedRuleIds.size > 0 && (
            <Button onClick={handleApplySelected} disabled={isApplying}>
              {isApplying ? '应用中...' : `应用选中规则 (${selectedRuleIds.size})`}
            </Button>
          )}
          <Button variant="outline" onClick={handleApplyAll} disabled={isApplying || totalFixableRuleCount === 0}>
            应用全部问题规则
          </Button>
          {isOptimized && (
            <Button variant="outline" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-1" />下载优化文档
            </Button>
          )}
          {docId && (
            <Button variant="outline" onClick={() => setShowA4Preview(true)}>
              <FileText className="h-4 w-4 mr-1" />A4 预览
            </Button>
          )}
          {docId && (
            <Button variant="outline" onClick={() => navigate(`/document/enhanced-preview?docId=${docId}`)}>
              <Settings2 className="h-4 w-4 mr-1" />实时排版
            </Button>
          )}
        </div>}
      />

      {/* ===== 筛选条 ===== */}
      <div className="px-4 md:px-6 lg:px-8 py-2 bg-white border-b border-primary-100 flex items-center gap-2 flex-wrap">
        {[
          { key: 'all', label: '全部', count: issues.length },
          { key: 'P0', label: 'P0 严重', count: p0 },
          { key: 'P1', label: 'P1 瑕疵', count: p1 },
          { key: 'P2', label: 'P2 建议', count: p2 },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${filter === f.key
              ? (f.key === 'P0' ? 'bg-severity-p0-bg text-severity-p0' : f.key === 'P1' ? 'bg-severity-p1-bg text-severity-p1' : f.key === 'P2' ? 'bg-severity-p2-bg text-severity-p2' : 'bg-accent text-white')
              : 'bg-primary-100 text-muted-foreground hover:bg-primary-200'}`}>
            {f.label} ({f.count})
          </button>
        ))}
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="text-xs" disabled={fixableRuleIds.length === 0}>
            {allFilteredRulesSelected ? <><CheckSquare className="h-3.5 w-3.5 mr-1" />取消全选</> : <><Square className="h-3.5 w-3.5 mr-1" />全选规则</>}
          </Button>
        </div>
      </div>

      {/* ===== 双栏主体 ===== */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ---- 左栏：问题列表（点击行即可选中） ---- */}
        <div className="w-[400px] xl:w-[460px] flex-shrink-0 border-r border-primary-200 overflow-y-auto bg-white">
          {checkState === 'never-run' ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div>
                <FileText className="h-12 w-12 text-primary-300 mx-auto mb-3" />
                <p className="text-muted-foreground text-sm mb-4">该文档尚未校审</p>
                <Button size="sm" onClick={handleRunCheck}>开始校审</Button>
              </div>
            </div>
          ) : checkState === 'verified-zero' ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div><CheckSquare className="h-12 w-12 text-status-success mx-auto mb-3" /><p className="text-muted-foreground text-sm">校审完成，未发现规则问题</p></div>
            </div>
          ) : filteredIssues.length === 0 ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div><Info className="h-12 w-12 text-primary-300 mx-auto mb-3" /><p className="text-muted-foreground text-sm">当前筛选无匹配问题</p></div>
            </div>
          ) : (
            <div>
              {groupedIssues.map(group => {
                const cfg = SEV[group.severity] || SEV.P2;
                const count = group.issues.length;
                const isSelected = Boolean(group.rule_id && selectedRuleIds.has(group.rule_id));
                const isExpanded = expandedGroups.has(group.key);

                return (
                  <div key={group.key} className="border-b border-primary-50">
                    {/* 分组标题行 */}
                    <div className={`px-4 py-3 transition-colors select-none ${group.rule_id ? 'cursor-pointer' : ''} ${isSelected ? 'bg-accent-light/40' : 'hover:bg-primary-50'}`}
                      onClick={() => {
                        if (group.rule_id) toggleRuleSelection(group.rule_id);
                      }}>
                      <div className="flex items-start gap-3">
                        <div className="pt-0.5" onClick={e => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            disabled={!group.rule_id}
                            aria-label={group.rule_id ? `选择规则 ${group.rule_id}` : '该问题没有可应用的规则'}
                            onCheckedChange={() => { if (group.rule_id) toggleRuleSelection(group.rule_id); }}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge className={`${cfg.badge} text-[10px] px-1.5 py-0`}>{group.severity}</Badge>
                            <span className="text-sm font-medium">{group.check_type}</span>
                            {count > 1 && <span className="text-xs text-primary-500 bg-primary-100 px-1.5 py-0.5 rounded-full">{count} 处</span>}
                            {group.rule_id && <span className="text-[10px] text-primary-400 ml-auto">{group.rule_id}</span>}
                          </div>
                          {group.suggested_fix && (
                            <p className="text-xs text-status-success mb-1">→ {group.suggested_fix}</p>
                          )}
                          <p className="text-xs text-muted-foreground">{group.reason}</p>
                          {/* 多处时显示第一条原文 + 展开按钮 */}
                          {count > 1 && (
                            <button className="text-[10px] text-accent mt-1 hover:underline" onClick={e => {
                              e.stopPropagation();
                              setExpandedGroups(prev => {
                                const n = new Set(prev);
                                if (n.has(group.key)) n.delete(group.key);
                                else n.add(group.key);
                                return n;
                              });
                            }}>
                              {isExpanded ? '收起详情' : `展开 ${count} 处详情`}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 展开的详情（多处问题时显示每一条） */}
                    {isExpanded && count > 1 && (
                      <div className="bg-primary-50/50">
                        {group.issues.map(issue => (
                          <div key={issue.id}
                            className="px-4 pl-12 py-2 border-t border-primary-100">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">{issue.location}</span>
                              {issue.original_text && (
                                <span className="text-xs text-foreground truncate">"{issue.original_text}"</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 单处问题时显示原文详情（不需要展开） */}
                    {count === 1 && group.issues[0].original_text && (
                      <div className="px-4 pl-12 pb-2">
                        <p className="text-xs text-foreground bg-primary-50 px-2 py-1 rounded line-clamp-2">"{group.issues[0].original_text}"</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ---- 右栏：AI 分析结果面板 ---- */}
        <div className="flex-1 overflow-y-auto bg-primary-100/30">
          <div className="p-4 md:p-6">
            {/* AI 配置状态 */}
            <Card className="mb-4">
              <CardContent className="py-3">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${aiStatus?.active ? 'bg-status-success-bg' : 'bg-primary-100'}`}>
                    <Cpu className={`h-4 w-4 ${aiStatus?.active ? 'text-status-success' : 'text-primary-400'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">AI 配置状态</span>
                      <span className={`inline-block h-2 w-2 rounded-full ${aiStatus?.active ? 'bg-status-success' : 'bg-primary-300'}`} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {aiStatus ? `${aiStatus.provider} · ${aiStatus.model}` : '未检测到配置'}
                    </p>
                  </div>
                  {!aiStatus?.active && (
                    <a href="#/settings/ai" className="text-xs text-accent hover:underline flex-shrink-0">去配置 →</a>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* AI 分析按钮 */}
            <Card className="mb-4">
              <CardContent className="py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                    <Sparkles className="h-5 w-5 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">AI 智能分析</p>
                    <p className="text-xs text-muted-foreground">调用已配置的 AI 模型，对文档进行语义级深度分析</p>
                  </div>
                  <Button onClick={handleAiAnalyze} disabled={aiLoading || !aiStatus?.active}>
                    {aiLoading ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />分析中...</> : <><Send className="h-4 w-4 mr-1.5" />开始分析</>}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* AI 分析结果 */}
            {aiLoading && (
              <Card>
                <CardContent className="py-12 text-center">
                  <Loader2 className="h-8 w-8 animate-spin text-accent mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">AI 正在分析文档，请稍候...</p>
                  <p className="text-xs text-primary-400 mt-1">已等待 {aiElapsed} 秒 · 首次分析可能需要 30-60 秒</p>
                </CardContent>
              </Card>
            )}

            {aiError && (() => {
              const explanation = getErrorExplanation(aiError);
              return (
                <Card className="border-status-error/30">
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="h-5 w-5 text-status-error flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-status-error mb-1">
                          {explanation?.title || '分析失败'}
                        </p>
                        {/* 原始报错信息 */}
                        <p className="text-xs text-foreground bg-status-error-bg p-2 rounded break-all font-mono">{aiError}</p>
                        {/* 中文解释 */}
                        {explanation && (
                          <div className="mt-3 p-3 rounded-lg bg-primary-50 border border-primary-200 space-y-1.5">
                            <p className="text-xs"><span className="font-medium text-foreground">原因：</span><span className="text-muted-foreground">{explanation.cause}</span></p>
                            <p className="text-xs"><span className="font-medium text-status-success">解决：</span><span className="text-muted-foreground">{explanation.fix}</span></p>
                          </div>
                        )}
                        {!explanation && (
                          <p className="text-xs text-muted-foreground mt-2">
                            请检查：①AI设置页已配置并测试连接成功 ②后端服务正在运行 ③本机 AI 服务已启动
                          </p>
                        )}
                        <Button variant="outline" size="sm" className="mt-3" onClick={handleAiAnalyze}>
                          重试
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {aiResult && aiResult.success && (
              <div className="space-y-4">
                {/* AI 发现的问题 — 可选择应用 */}
                {aiResult.issues && aiResult.issues.length > 0 && (
                  <Card>
                    <CardContent className="py-4">
                      {/* 标题栏 + 操作按钮 */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Zap className="h-4 w-4 text-accent" />
                          <span className="text-sm font-medium">AI 发现 {aiResult.issues.length} 个问题</span>
                          <Badge variant="secondary" className="text-[10px]">{aiResult.provider}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={toggleAiSelectAll} className="text-xs h-7 px-2">
                            {selectedAiIds.size > 0
                              ? <><CheckSquare className="h-3 w-3 mr-1" />取消</>
                              : <><Square className="h-3 w-3 mr-1" />全选</>}
                          </Button>
                          {selectedAiIds.size > 0 && (
                            <Button size="sm" onClick={handleApplyAiSuggestions} disabled={isApplyingAi} className="h-7 text-xs">
                              {isApplyingAi
                                ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />应用中...</>
                                : `应用选中 (${selectedAiIds.size})`}
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* 问题列表 */}
                      <div className="space-y-2">
                        {aiResult.issues.map((item, idx) => {
                          const isSelected = selectedAiIds.has(idx);
                          const sevMap: Record<string, { badge: string; border: string }> = {
                            high: { badge: 'bg-severity-p0-bg text-severity-p0', border: 'border-severity-p0' },
                            medium: { badge: 'bg-severity-p1-bg text-severity-p1', border: 'border-severity-p1' },
                            low: { badge: 'bg-severity-p2-bg text-severity-p2', border: 'border-severity-p2' },
                          };
                          const sev = sevMap[item.severity] || sevMap.low;
                          return (
                            <div
                              key={idx}
                              className={`p-3 rounded-lg border-l-3 cursor-pointer select-none transition-colors
                                ${isSelected ? 'bg-accent-light/30 border-accent' : 'bg-primary-50 border-primary-200 hover:bg-primary-100/50'}`}
                              onClick={() => toggleAiSelect(idx)}
                            >
                              <div className="flex items-start gap-2.5">
                                {/* Checkbox */}
                                <div className="pt-0.5" onClick={e => e.stopPropagation()}>
                                  <Checkbox checked={isSelected} onCheckedChange={() => toggleAiSelect(idx)} />
                                </div>
                                {/* 内容 */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1.5">
                                    <span className="text-xs font-medium text-accent">#{idx + 1}</span>
                                    {item.type && <Badge variant="outline" className="text-[10px]">{item.type}</Badge>}
                                    {item.severity && <Badge className={`${sev.badge} text-[10px] px-1.5 py-0`}>{item.severity}</Badge>}
                                    {item.location && <span className="text-[10px] text-primary-400 ml-auto">{item.location}</span>}
                                  </div>
                                  {/* 原文 */}
                                  {item.original && (
                                    <p className="text-xs text-foreground bg-white/60 px-2 py-1 rounded mb-1.5 border border-primary-100">
                                      📄 {String(item.original)}
                                    </p>
                                  )}
                                  {/* 建议 */}
                                  {item.suggestion && (
                                    <p className="text-xs text-status-success bg-status-success-bg/30 px-2 py-1 rounded mb-1.5">
                                      ✏️ {String(item.suggestion)}
                                    </p>
                                  )}
                                  {/* 原因 */}
                                  {item.reason && (
                                    <p className="text-xs text-muted-foreground">💡 {item.reason}</p>
                                  )}
                                  {/* fallback: 无结构化字段时显示原始内容 */}
                                  {!item.original && !item.suggestion && !item.reason && (
                                    <p className="text-xs text-foreground">{item.description || item.message || item.text || JSON.stringify(item)}</p>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* AI 原始回复 */}
                {aiResult.raw_response && (
                  <Card>
                    <CardContent className="py-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Sparkles className="h-4 w-4 text-primary-400" />
                        <span className="text-sm font-medium">AI 分析报告</span>
                      </div>
                      <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed bg-primary-50 p-4 rounded-lg max-h-[500px] overflow-y-auto">
                        {aiResult.raw_response}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* 初始状态：未分析 */}
            {!aiLoading && !aiError && !aiResult && (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <Sparkles className="h-16 w-16 text-primary-200 mx-auto mb-4" />
                  <p className="text-sm text-muted-foreground mb-1">点击「开始分析」调用 AI</p>
                  <p className="text-xs text-primary-400">对文档进行语义级深度分析，发现规则引擎无法识别的问题</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* A4 预览弹窗 */}
      {showA4Preview && docId && (
        <A4PreviewModal
          docId={docId}
          refreshKey={a4RefreshKey}
          onClose={() => setShowA4Preview(false)}
        />
      )}
    </div>
  );
}
