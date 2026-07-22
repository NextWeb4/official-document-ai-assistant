/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * AISettings - AI 配置页面
 * 按 appMode 切换：离线版仅支持本机 Ollama，在线版显示在线 Provider。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Lock, CheckCircle2, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import PageHeader from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { apiClient } from '@/api/client';
import { createRequestScope } from '@/lib/request-scope.mjs';

interface ProviderInfo {
  value: string;
  label: string;
  defaultUrl: string;
  defaultModel: string;
}

interface ModelStatus {
  provider: string;
  model: string;
  online: boolean;
  latency_ms?: number;
  error?: string;
}

type ApiError = {
  response?: {
    data?: {
      detail?: string;
      message?: string;
    };
  };
};

function getApiErrorMessage(error: unknown, fallback: string) {
  const apiError = error as ApiError;
  return apiError.response?.data?.message || apiError.response?.data?.detail || fallback;
}

const OFFLINE_PROVIDERS: ProviderInfo[] = [
  { value: 'ollama', label: 'Ollama (本地)', defaultUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5:7b' },
];

const ONLINE_PROVIDERS: ProviderInfo[] = [
  { value: 'openai', label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { value: 'deepseek', label: 'DeepSeek', defaultUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { value: 'claude', label: 'Claude', defaultUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { value: 'ollama', label: 'Ollama (本地)', defaultUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5:7b' },
  { value: 'custom', label: '自定义 OpenAI 兼容接口', defaultUrl: '', defaultModel: '' },
];

export default function AISettings() {
  const [provider, setProvider] = useState('ollama');
  const [selectedLabel, setSelectedLabel] = useState('Ollama (本地)');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434/v1');
  const [model, setModel] = useState('qwen2.5:7b');
  const [isActive, setIsActive] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[]>([]);
  const [appMode, setAppMode] = useState<'online' | 'offline'>('offline');
  const [isInitialized, setIsInitialized] = useState(false);
  const configRequestId = useRef(0);
  const providerRequestScope = useRef(createRequestScope<string>('ollama'));

  const providerOptions = useMemo(
    () => (appMode === 'offline' ? OFFLINE_PROVIDERS : ONLINE_PROVIDERS),
    [appMode],
  );
  const currentProvider = providerOptions.find(p => p.value === provider);
  const requiresApiKey = provider !== 'ollama';
  const savedKeyLabel = apiKeyMasked ? `已保存：${apiKeyMasked}` : '已配置';

  const loadAppMode = useCallback(async () => {
    let mode: 'online' | 'offline' = 'offline';
    try {
      const resp = await apiClient.get('/api/settings/app-mode');
      mode = resp.app_mode === 'online' ? 'online' : 'offline';
    } catch {
      // Keep the local-only defaults when the app-mode probe fails.
    }
    const options = mode === 'offline' ? OFFLINE_PROVIDERS : ONLINE_PROVIDERS;
    let initial = options[0];
    let initialBaseUrl = initial.defaultUrl;
    let initialModel = initial.defaultModel;
    try {
      const resp = await apiClient.get('/api/ai/default');
      const matched = options.find(p => p.value === resp.provider);
      if (matched) {
        initial = matched;
        initialBaseUrl = resp.base_url || matched.defaultUrl;
        initialModel = resp.model || matched.defaultModel;
      }
    } catch {
      console.warn('加载默认 AI 配置失败');
    }

    providerRequestScope.current.advance(initial.value);
    configRequestId.current += 1;
    setAppMode(mode);
    setSelectedLabel(initial.label);
    setProvider(initial.value);
    setBaseUrl(initialBaseUrl);
    setModel(initialModel);
    setApiKey('');
    setApiKeyMasked('');
    setHasSavedKey(false);
    setAvailableModels([]);
    setIsActive(false);
    setIsInitialized(true);
  }, []);

  const loadModelStatus = useCallback(async () => {
    try {
      const resp = await apiClient.get('/api/ai/status');
      if (resp.statuses) setModelStatuses(resp.statuses);
    } catch {
      // 静默失败
    }
  }, []);

  const loadConfig = useCallback(async () => {
    const requestId = ++configRequestId.current;
    const requestScope = providerRequestScope.current.capture();
    const fallback = providerOptions.find(item => item.value === provider);
    try {
      const response = await apiClient.get(`/api/ai/config/${provider}`);
      if (
        requestId !== configRequestId.current
        || !providerRequestScope.current.isCurrent(requestScope)
      ) return;
      setApiKey('');
      setAvailableModels([]);
      if (response.exists) {
        setBaseUrl(response.base_url || fallback?.defaultUrl || '');
        setModel(response.model || fallback?.defaultModel || '');
        setIsActive(Boolean(response.is_active));
        setApiKeyMasked(response.api_key_masked || '');
        setHasSavedKey(Boolean(response.api_key_masked));
      } else {
        setBaseUrl(response.default?.base_url || fallback?.defaultUrl || '');
        setModel(response.default?.model || fallback?.defaultModel || '');
        setIsActive(false);
        setApiKeyMasked('');
        setHasSavedKey(false);
      }
    } catch (error) {
      console.error('Load config error:', error);
    }
  }, [provider, providerOptions]);

  useEffect(() => {
    void Promise.resolve().then(loadAppMode);
  }, [loadAppMode]);

  useEffect(() => {
    if (isInitialized) void Promise.resolve().then(loadConfig);
  }, [isInitialized, loadConfig]);

  // 模型可用性状态轮询（每 60 秒）
  useEffect(() => {
    void Promise.resolve().then(loadModelStatus);
    const timer = setInterval(loadModelStatus, 60000);
    return () => clearInterval(timer);
  }, [loadModelStatus]);

  const handleFetchModels = async () => {
    if (!baseUrl) {
      setErrorMessage('请先填写 Base URL');
      return;
    }
    if (requiresApiKey && !apiKey && !hasSavedKey) {
      setErrorMessage('请先输入 API Key 或确认已保存的密钥');
      return;
    }
    setIsFetchingModels(true);
    setErrorMessage('');
    const requestScope = providerRequestScope.current.capture();
    const requestApiKey = apiKey;
    const requestBaseUrl = baseUrl;
    try {
      const resp = await apiClient.post('/api/ai/models', {
        base_url: requestBaseUrl,
        api_key: requestApiKey || (requestScope.key === 'ollama' ? 'ollama' : '__saved__'),
        provider: requestScope.key,
      });
      if (!providerRequestScope.current.isCurrent(requestScope)) return;
      if (resp.success && resp.models.length > 0) {
        setAvailableModels(resp.models);
        setSuccessMessage(`获取到 ${resp.count} 个模型`);
      } else {
        setErrorMessage(resp.message || '未获取到模型列表');
      }
    } catch (error: unknown) {
      if (!providerRequestScope.current.isCurrent(requestScope)) return;
      setErrorMessage('获取模型失败：' + getApiErrorMessage(error, '请检查配置'));
    } finally {
      if (providerRequestScope.current.isCurrent(requestScope)) {
        setIsFetchingModels(false);
      }
    }
  };

  const handleTestConnection = async () => {
    if (requiresApiKey && !apiKey && !hasSavedKey) {
      setErrorMessage('请先输入 API Key');
      return;
    }
    setIsTesting(true);
    setErrorMessage('');
    setSuccessMessage('');
    const requestScope = providerRequestScope.current.capture();
    const requestApiKey = apiKey;
    const requestBaseUrl = baseUrl;
    const requestModel = model;
    try {
      const response = await apiClient.post('/api/ai/test', {
        provider: requestScope.key,
        api_key: requestApiKey || (requestScope.key === 'ollama' ? 'ollama' : '__saved__'),
        base_url: requestBaseUrl,
        model: requestModel,
      });
      if (!providerRequestScope.current.isCurrent(requestScope)) return;
      if (response.success) {
        setSuccessMessage(`连接成功！模型：${response.model || requestModel}`);
      } else {
        setErrorMessage(response.message || '连接失败');
      }
    } catch (error: unknown) {
      if (!providerRequestScope.current.isCurrent(requestScope)) return;
      setErrorMessage(getApiErrorMessage(error, '连接测试失败'));
    } finally {
      if (providerRequestScope.current.isCurrent(requestScope)) {
        setIsTesting(false);
      }
    }
  };

  const handleSave = async () => {
    if (requiresApiKey && !apiKey && !hasSavedKey) {
      setErrorMessage('请先输入 API Key');
      return;
    }
    setIsSaving(true);
    setErrorMessage('');
    setSuccessMessage('');
    const requestScope = providerRequestScope.current.capture();
    const requestApiKey = apiKey;
    const requestBaseUrl = baseUrl;
    const requestModel = model;
    const requestIsActive = isActive;
    try {
      const response = await apiClient.post('/api/ai/config', {
        provider: requestScope.key,
        api_key: requestApiKey || '',  // 空则保留已保存的密钥
        base_url: requestBaseUrl,
        model: requestModel,
        is_active: requestIsActive,
      });
      if (!providerRequestScope.current.isCurrent(requestScope)) return;
      if (response.success) {
        setSuccessMessage('配置已保存！');
        if (requestApiKey) setApiKey('');
        await loadConfig();
      }
    } catch (error: unknown) {
      if (!providerRequestScope.current.isCurrent(requestScope)) return;
      setErrorMessage(getApiErrorMessage(error, '保存失败'));
    } finally {
      if (providerRequestScope.current.isCurrent(requestScope)) {
        setIsSaving(false);
      }
    }
  };

  const handleProviderChange = (label: string) => {
    const info = providerOptions.find(p => p.label === label);
    if (!info) return;
    providerRequestScope.current.advance(info.value);
    configRequestId.current += 1;
    setIsTesting(false);
    setIsSaving(false);
    setIsFetchingModels(false);
    setSelectedLabel(label);
    setProvider(info.value);
    setBaseUrl(info.defaultUrl);
    setModel(info.defaultModel);
    setApiKey('');
    setAvailableModels([]);
    setIsActive(false);
    setHasSavedKey(false);
    setApiKeyMasked('');
    setErrorMessage('');
    setSuccessMessage('');
  };

  return (
    <div className="w-full bg-primary-50">
      <PageHeader
        title="AI 配置"
        description={appMode === 'offline' ? '配置本机 AI 模型' : '配置在线或本机 AI 模型'}
      />

      <div className="p-4 md:p-6 lg:p-8 w-full space-y-6">
        {/* 状态卡片 */}
        <Card className="border-primary-200">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Sparkles className="h-5 w-5 text-accent" />
                <span className="font-medium text-primary-900">AI 服务状态</span>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={isActive ? 'default' : 'secondary'}>
                  {isActive ? '已启用' : '未启用'}
                </Badge>
                <span title={isActive ? '禁用 AI 服务' : '启用 AI 服务'}>
                  <Switch
                    checked={isActive}
                    onCheckedChange={setIsActive}
                  />
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 模型可用性状态 */}
        {modelStatuses.length > 0 && (
          <Card className="border-primary-200">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">模型可用性监控</CardTitle>
                <Button variant="ghost" size="sm" onClick={loadModelStatus} className="h-6 px-2">
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
              <CardDescription>每 60 秒自动检测，实时反映模型连接状态</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-2">
                {modelStatuses.map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 px-2 bg-primary-50 rounded text-xs">
                    <div className="flex items-center gap-2">
                      {s.online
                        ? <Wifi className="h-3.5 w-3.5 text-status-success" />
                        : <WifiOff className="h-3.5 w-3.5 text-red-400" />
                      }
                      <span className="font-medium text-primary-700">{s.provider}</span>
                      <span className="text-primary-400">{s.model}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {s.online && <span className="text-primary-400">{s.latency_ms}ms</span>}
                      <Badge variant={s.online ? 'default' : 'destructive'} className="text-[10px] px-1.5 py-0">
                        {s.online ? '可用' : s.error || '离线'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 配置卡片 */}
        <Card className="border-primary-200">
          <CardHeader>
            <CardTitle>基础配置</CardTitle>
            <CardDescription>{appMode === 'offline' ? '选择本机 AI 服务并配置参数' : '选择 AI 服务商并配置参数'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Provider 选择 */}
            <div className="space-y-2">
              <Label>{appMode === 'offline' ? '本机 AI 服务' : 'AI 服务商'}</Label>
              <Select value={selectedLabel} onValueChange={handleProviderChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((p) => (
                    <SelectItem key={p.label} value={p.label}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* API Key */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                API Key
              </Label>
              <div className="relative">
                <Input
                  type="password"
                  placeholder={provider === 'ollama' ? 'Ollama 本地模式无需填写' : hasSavedKey ? '已配置，输入新密钥可替换' : '请输入 API Key'}
                  value={hasSavedKey && !apiKey ? '••••••••••••••••' : apiKey}
                  disabled={provider === 'ollama'}
                  onChange={(e) => {
                    // 如果是从星号状态开始输入，清除星号，开始接收真实输入
                    if (hasSavedKey && apiKey === '' && e.target.value !== '••••••••••••••••') {
                      // 用户开始输入新密钥
                    }
                    setApiKey(e.target.value === '••••••••••••••••' ? '' : e.target.value);
                  }}
                  onFocus={() => {
                    // 聚焦时如果显示的是星号，清空以便输入
                    if (hasSavedKey && !apiKey) {
                      setApiKey('');
                    }
                  }}
                />
                {provider !== 'ollama' && hasSavedKey && !apiKey && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5 text-status-success" />
                    <span className="text-[10px] text-status-success">{savedKeyLabel}</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-primary-500">
                {provider === 'ollama'
                  ? 'Ollama 使用本机服务地址'
                  : hasSavedKey ? '输入新密钥将替换已保存的，留空则继续使用已保存的密钥' : 'API Key 将加密存储在本地数据库'}
              </p>
            </div>

            {/* Base URL */}
            <div className="space-y-2">
              <Label>Base URL</Label>
                <Input
                  type="url"
                  placeholder="http://localhost:11434/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>

            {/* 模型 + 获取模型 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>模型</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={isFetchingModels || !baseUrl || (requiresApiKey && !apiKey && !hasSavedKey)}
                >
                  {isFetchingModels ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  获取模型
                </Button>
              </div>
              {availableModels.length > 0 ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  placeholder={`例如：${currentProvider?.defaultModel || 'model-name'}`}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              )}
            </div>

            {/* 消息 */}
            {errorMessage && (
              <div className="p-3 bg-status-error-bg border border-status-error rounded text-sm text-status-error">
                {errorMessage}
              </div>
            )}
            {successMessage && (
              <div className="p-3 bg-status-success-bg border border-status-success rounded text-sm text-status-success">
                {successMessage}
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex gap-3">
              <Button
                onClick={handleTestConnection}
                disabled={isTesting || (requiresApiKey && !apiKey && !hasSavedKey)}
                variant="outline"
                className="flex-1"
              >
                {isTesting ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />测试中...</>
                ) : (
                  <><CheckCircle2 className="h-4 w-4 mr-2" />测试连接</>
                )}
              </Button>
              <Button
                onClick={handleSave}
                disabled={isSaving || (requiresApiKey && !apiKey && !hasSavedKey)}
                className="flex-1"
              >
                {isSaving ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />保存中...</>
                ) : '保存配置'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 说明 */}
        <Card className="border-primary-200 bg-primary-50">
          <CardHeader>
            <CardTitle className="text-base">使用说明</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-primary-700 space-y-2">
            {appMode === 'offline' ? (
              <>
                <p>• 离线版仅显示本机模型配置</p>
                <p>• Ollama 为本地模型，需先在本机安装并启动 Ollama 服务</p>
                <p>• Base URL 只能使用 localhost 或 127.0.0.1</p>
              </>
            ) : (
              <>
                <p>• 在线版可配置 OpenAI、DeepSeek、Claude 或自定义兼容接口</p>
                <p>• API Key 使用 Fernet 加密后存储在本地数据目录</p>
                <p>• 也可选择 Ollama 使用本机模型</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
