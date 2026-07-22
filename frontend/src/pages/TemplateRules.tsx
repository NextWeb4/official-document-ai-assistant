/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * TemplateRules - 模板规则编辑页面
 * 编辑指定模板的检查和修复规则
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Save, Plus, RefreshCw, Trash2, Loader2 } from 'lucide-react';
import PageHeader from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/api/client';
import { useToast } from '@/components/ui/toast';
import type { RuleFieldOption, RuleFieldsResponse } from '@/lib/rule-fields';

interface CheckRule {
  id: string;
  name: string;
  severity: 'P0' | 'P1' | 'P2';
  field: string;
  expected: string;
  message: string;
}

interface TemplateRuleDetail {
  template_name?: string;
  document_type?: string;
  check_rules?: CheckRule[];
}

interface TemplateRulesResponse {
  rules?: TemplateRuleDetail;
}

type ApiError = {
  response?: {
    data?: {
      detail?: string;
    };
  };
};

export default function TemplateRules() {
  const { templateId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const { success, error: showError, warning, confirm } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<TemplateRulesResponse | null>(null);
  const [rules, setRules] = useState<CheckRule[]>([]);
  const [ruleFields, setRuleFields] = useState<RuleFieldOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTemplateRules = useCallback(async () => {
    setLoading(true);
    setLoaded(false);
    setLoadError(null);
    try {
      const [response, fieldsResponse] = await Promise.all([
        apiClient.get(`/api/templates/${templateId}`),
        apiClient.get('/api/templates/rule-fields') as Promise<RuleFieldsResponse>,
      ]);
      if (!response.exists || !response.rules) {
        throw new Error(response.error || '模板规则不存在');
      }
      setTemplate(response);
      setRules(response.rules.check_rules || []);
      setRuleFields(fieldsResponse.fields || []);
      setLoaded(true);
    } catch (error: unknown) {
      console.error('Load template rules error:', error);
      const apiError = error as ApiError;
      setLoadError(
        apiError.response?.data?.detail
          || (error instanceof Error ? error.message : '模板规则加载失败'),
      );
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    void Promise.resolve().then(loadTemplateRules);
  }, [loadTemplateRules]);

  const addRule = () => {
    const newRule: CheckRule = {
      id: `CHK-${String(rules.length + 1).padStart(3, '0')}`,
      name: '新规则',
      severity: 'P1',
      field: '',
      expected: '',
      message: ''
    };
    setRules([...rules, newRule]);
  };

  const updateRule = (index: number, field: keyof CheckRule, value: string) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], [field]: value };
    setRules(updated);
  };

  const removeRule = async (index: number) => {
    if (await confirm('确认', '确定要删除此规则吗？')) {
      setRules(rules.filter((_, i) => i !== index));
    }
  };

  const handleSave = async () => {
    if (!loaded) {
      warning('提示', '规则尚未成功加载，不能保存');
      return;
    }
    const supportedFields = new Set(ruleFields.map((field) => field.value));
    const unsupportedRule = rules.find((rule) => !supportedFields.has(rule.field));
    if (unsupportedRule) {
      warning('提示', `当前不支持检查字段：${unsupportedRule.field}`);
      return;
    }
    const invalidRule = rules.find(rule => (
      !rule.id.trim() ||
      !rule.name.trim() ||
      !rule.severity ||
      !rule.field.trim() ||
      !rule.expected.trim() ||
      !rule.message.trim()
    ));
    if (invalidRule) {
      warning('提示', '请完整填写规则ID、名称、字段、期望值和提示信息');
      return;
    }

    setSaving(true);
    try {
      const response = await apiClient.put(`/api/templates/${templateId}/rules`, { check_rules: rules });
      success('成功', response.message || '规则保存成功');
      await loadTemplateRules();
    } catch (error: unknown) {
      const apiError = error as ApiError;
      showError('错误', '保存失败：' + (apiError.response?.data?.detail || '请重试'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="w-full bg-primary-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="w-full bg-primary-50">
        <PageHeader
          title={`编辑规则：${templateId || ''}`}
          description="配置文档格式检查规则"
          actions={
            <Button variant="outline" onClick={() => navigate('/templates')}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              返回
            </Button>
          }
        />
        <div className="p-4 md:p-6 lg:p-8">
          <div className="border border-status-error/30 bg-status-error-bg p-6 text-center">
            <AlertTriangle className="h-7 w-7 text-status-error mx-auto mb-3" />
            <p className="font-medium text-status-error">规则加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
            <Button className="mt-4" variant="outline" onClick={() => void loadTemplateRules()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              重试
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full bg-primary-50">
      <PageHeader
        title={`编辑规则：${template?.rules?.template_name || templateId}`}
        description="配置文档格式检查规则"
        actions={
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => navigate('/templates')}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              返回
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !loaded}
            >
              <Save className="h-4 w-4 mr-2" />
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        }
      />

      <div className="p-4 md:p-6 lg:p-8 w-full space-y-6">
        {/* 模板信息 */}
        <Card>
          <CardHeader>
            <CardTitle>模板信息</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">模板名称：</span>
              <span className="font-medium">{template?.rules?.template_name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">文档类型：</span>
              <span className="font-medium">{template?.rules?.document_type}</span>
            </div>
            <div>
              <span className="text-muted-foreground">当前规则数：</span>
              <span className="font-medium">{rules.length} 条</span>
            </div>
          </CardContent>
        </Card>

        {/* 规则列表 */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">检查规则</h2>
            <Button onClick={addRule} variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              添加规则
            </Button>
          </div>

          {rules.map((rule, index) => (
            <Card key={index}>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label>规则ID</Label>
                    <Input
                      value={rule.id}
                      onChange={(e) => updateRule(index, 'id', e.target.value)}
                      placeholder="CHK-001"
                    />
                  </div>
                  <div>
                    <Label>规则名称</Label>
                    <Input
                      value={rule.name}
                      onChange={(e) => updateRule(index, 'name', e.target.value)}
                      placeholder="例如：标题字体检查"
                    />
                  </div>
                  <div>
                    <Label>严重程度</Label>
                    <select
                      className="w-full border border-primary-200 rounded-md px-3 py-2 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                      value={rule.severity}
                      onChange={(e) => updateRule(index, 'severity', e.target.value as CheckRule['severity'])}
                    >
                      <option value="P0">P0 - 必须修复</option>
                      <option value="P1">P1 - 建议修复</option>
                      <option value="P2">P2 - 可选修复</option>
                    </select>
                  </div>
                  <div>
                    <Label>检查字段</Label>
                    <select
                      className="w-full border border-primary-200 rounded-md px-3 py-2 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                      value={rule.field}
                      onChange={(e) => updateRule(index, 'field', e.target.value)}
                    >
                      <option value="">请选择字段</option>
                      {!ruleFields.some((field) => field.value === rule.field) && rule.field && (
                        <option value={rule.field}>不支持 · {rule.field}</option>
                      )}
                      {[...new Set(ruleFields.map((field) => field.group))].map((group) => (
                        <optgroup key={group} label={group}>
                          {ruleFields
                            .filter((field) => field.group === group)
                            .map((field) => (
                              <option key={field.value} value={field.value}>{field.label}</option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>期望值</Label>
                    <Input
                      value={rule.expected}
                      onChange={(e) => updateRule(index, 'expected', e.target.value)}
                      placeholder="例如：方正小标宋简体"
                    />
                  </div>
                  <div className="col-span-2">
                    <Label>提示信息</Label>
                    <Input
                      value={rule.message}
                      onChange={(e) => updateRule(index, 'message', e.target.value)}
                      placeholder="例如：标题应使用方正小标宋简体"
                    />
                  </div>
                  <div className="col-span-2 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => removeRule(index)}
                      className="text-status-error hover:text-status-error hover:bg-status-error-bg"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      删除规则
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {rules.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <p>暂无规则，点击"添加规则"开始配置</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
