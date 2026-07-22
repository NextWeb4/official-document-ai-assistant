/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * Templates - 模板中心（优化版 - 改进用户体验）
 */
import { useCallback, useEffect, useState } from 'react';
import { Eye, Loader2, Plus, Settings, ChevronRight, Download, FileDown, Sparkles, Upload, Settings2, Trash2, Search, RotateCcw, Copy } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { apiClient, downloadFile } from '@/api/client';
import { useToast } from '@/components/ui/toast';
import A4PreviewModal from '@/components/A4PreviewModal';
import { ruleFieldLabel, type RuleFieldOption, type RuleFieldsResponse } from '@/lib/rule-fields';

interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  category?: string;
  source?: string;
  rule_file: string;
  enabled: boolean;
  has_rules: boolean;
}

interface CheckRule {
  id: string;
  name: string;
  severity: 'P0' | 'P1' | 'P2';
  field: string;
  expected: string;
  message: string;
}

type ApiError = {
  response?: {
    data?: {
      detail?: string;
    };
  };
};

function getApiErrorDetail(error: unknown, fallback: string) {
  return (error as ApiError).response?.data?.detail || fallback;
}

export default function Templates() {
  const navigate = useNavigate();
  const { success, error: showError, warning, confirm } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<{ id: string; name: string } | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRulesDialog, setShowRulesDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [templateSearch, setTemplateSearch] = useState('');
  const [hiddenTotal, setHiddenTotal] = useState(0);
  const [ruleFields, setRuleFields] = useState<RuleFieldOption[]>([]);

  // 新增模板表单
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    document_type: '',
    description: '',
    icon: '📄',
    custom_rules: false
  });

  const loadTemplates = useCallback(async () => {
    try {
      const [response, fieldsResponse] = await Promise.all([
        apiClient.get('/api/templates/list'),
        apiClient.get('/api/templates/rule-fields') as Promise<RuleFieldsResponse>,
      ]);
      setTemplates(response.templates || []);
      setHiddenTotal(response.hidden_total || 0);
      setRuleFields(fieldsResponse.fields || []);
    } catch (error) {
      console.error('Load templates error:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // 自定义规则
  const [customRules, setCustomRules] = useState<CheckRule[]>([
    {
      id: 'CHK-001',
      name: '标题字体检查',
      severity: 'P0',
      field: 'title.font',
      expected: '方正小标宋简体',
      message: '标题应使用方正小标宋简体'
    }
  ]);

  useEffect(() => {
    void Promise.resolve().then(loadTemplates);
  }, [loadTemplates]);

  const handleViewDetails = (template: Template) => {
    setPreviewTemplate({ id: template.id, name: template.name });
  };

  const handleEditRules = (template: Template) => {
    // 使用 navigate 跳转
    navigate(`/templates/${template.id}/rules`);
  };

  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleDownloadTemplate = async (template: Template) => {
    setDownloadingId(`dotx-${template.id}`);
    try {
      await downloadFile(`/api/templates/official/${template.id}/download/dotx`, `${template.name}_公文模板.dotx`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDownloadStyleDotx = async (template: Template) => {
    setDownloadingId(`inst-${template.id}`);
    try {
      await downloadFile(`/api/templates/styles/${template.id}/download/dotx`, `${template.name}_安装模板.dotx`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDeleteTemplate = async (template: Template) => {
    const confirmed = await confirm(
      '确认删除',
      template.source === 'official'
        ? `确认从模板中心删除内置模板“${template.name}”？之后可通过恢复按钮找回。`
        : `确认删除模板“${template.name}”？删除后对应的自定义规则也会移除。`,
    );
    if (!confirmed) return;

    setDeletingId(template.id);
    try {
      await apiClient.delete(`/api/templates/${template.id}?source_type=${template.source || 'user'}`);
      success('已删除', `模板“${template.name}”已删除`);
      await loadTemplates();
    } catch (error) {
      showError('删除失败', getApiErrorDetail(error, '请重试'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleRestoreBuiltInTemplates = async () => {
    try {
      const response = await apiClient.post('/api/templates/deleted/restore');
      success('已恢复', `已恢复 ${response.restored || 0} 个内置模板`);
      await loadTemplates();
    } catch (error) {
      showError('恢复失败', getApiErrorDetail(error, '请重试'));
    }
  };

  const handleDuplicateTemplate = async (template: Template) => {
    setDuplicatingId(template.id);
    try {
      const response = await apiClient.post(`/api/templates/${template.id}/duplicate`);
      success('已复制为自定义', `已创建“${response.name || template.name}”，可继续编辑规则`);
      await loadTemplates();
      setCategoryFilter('custom');
    } catch (error) {
      showError('复制失败', getApiErrorDetail(error, '请重试'));
    } finally {
      setDuplicatingId(null);
    }
  };

  const addCustomRule = () => {
    const newRule: CheckRule = {
      id: `CHK-${String(customRules.length + 1).padStart(3, '0')}`,
      name: '新规则',
      severity: 'P1',
      field: '',
      expected: '',
      message: ''
    };
    setCustomRules([...customRules, newRule]);
  };

  const updateRule = (index: number, field: keyof CheckRule, value: string) => {
    const updated = [...customRules];
    updated[index] = { ...updated[index], [field]: value };
    setCustomRules(updated);
  };

  const removeRule = (index: number) => {
    if (customRules.length === 1) {
      warning('提示', '至少保留一条规则');
      return;
    }
    setCustomRules(customRules.filter((_, i) => i !== index));
  };

  const handleCreateTemplate = async () => {
    if (!newTemplate.name || !newTemplate.document_type || !newTemplate.description) {
      warning('提示', '请填写所有必填项');
      return;
    }

    if (newTemplate.custom_rules) {
      const hasEmptyFields = customRules.some(r => !r.field || !r.expected || !r.message);
      if (hasEmptyFields) {
        warning('提示', '请完整填写所有规则的字段、期望值和提示信息');
        return;
      }
    }

    setCreating(true);
    try {
      const payload = {
        ...newTemplate,
        custom_rules: newTemplate.custom_rules ? customRules : undefined
      };
      const response = await apiClient.post('/api/templates/create', payload);
      success('成功', response.message || '模板创建成功！');
      setShowCreateDialog(false);
      setShowRulesDialog(false);
      setNewTemplate({ name: '', document_type: '', description: '', icon: '📄', custom_rules: false });
      setCustomRules([{
        id: 'CHK-001',
        name: '标题字体检查',
        severity: 'P0',
        field: 'title.font',
        expected: '方正小标宋简体',
        message: '标题应使用方正小标宋简体'
      }]);
      await loadTemplates();
    } catch (error) {
      showError('错误', '创建失败：' + getApiErrorDetail(error, '请重试'));
    } finally {
      setCreating(false);
    }
  };

  const categoryTemplates = categoryFilter === 'all'
    ? templates
    : categoryFilter === 'custom'
      ? templates.filter(t => t.source === 'custom' || t.source === 'user' || t.category === 'custom')
      : templates.filter(t => t.category === categoryFilter);
  const searchQuery = templateSearch.trim().toLowerCase();
  const filteredTemplates = searchQuery
    ? categoryTemplates.filter(t =>
        t.name.toLowerCase().includes(searchQuery) ||
        t.id.toLowerCase().includes(searchQuery) ||
        t.description.toLowerCase().includes(searchQuery) ||
        (t.source || '').toLowerCase().includes(searchQuery)
      )
    : categoryTemplates;

  const governmentCount = templates.filter(t => t.category === 'government').length;
  const regionalCount = templates.filter(t => t.category === 'regional').length;
  const commonCount = templates.filter(t => t.category === 'common').length;
  const customCount = templates.filter(t => t.source === 'custom' || t.source === 'user' || t.category === 'custom').length;

  if (loading) {
    return (
      <div className="w-full bg-primary-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="w-full bg-primary-50">
      <PageHeader
        title="模板中心"
        description={`支持 ${templates.length} 种公文模板 · 政府机关 ${governmentCount} 个 · 福建省 ${regionalCount} 个 · 其他常用 ${commonCount} 个${customCount > 0 ? ` · 自定义 ${customCount} 个` : ''}`}
        actions={
          <div className="flex gap-2">
            {hiddenTotal > 0 && (
              <Button
                variant="outline"
                onClick={handleRestoreBuiltInTemplates}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                恢复内置模板 ({hiddenTotal})
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => navigate('/templates/import')}
            >
              <Upload className="h-4 w-4 mr-2" />
              导入模板
            </Button>
            <Button
              onClick={() => setShowCreateDialog(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              新增模板
            </Button>
          </div>
        }
      />

      <div className="p-4 md:p-6 lg:p-8 w-full">
        {/* 分类筛选 */}
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2 sm:gap-3">
          <Button
            variant={categoryFilter === 'all' ? 'default' : 'outline'}
            onClick={() => setCategoryFilter('all')}
          >
            {`全部 (${templates.length})`}
          </Button>
          <Button
            variant={categoryFilter === 'government' ? 'default' : 'outline'}
            onClick={() => setCategoryFilter('government')}
          >
            {`政府机关 (${governmentCount})`}
          </Button>
          <Button
            variant={categoryFilter === 'regional' ? 'default' : 'outline'}
            onClick={() => setCategoryFilter('regional')}
          >
            {`福建省 (${regionalCount})`}
          </Button>
          <Button
            variant={categoryFilter === 'common' ? 'default' : 'outline'}
            onClick={() => setCategoryFilter('common')}
          >
            {`其他常用 (${commonCount})`}
          </Button>
          {customCount > 0 && (
            <Button
              variant={categoryFilter === 'custom' ? 'default' : 'outline'}
              onClick={() => setCategoryFilter('custom')}
            >
              {`自定义 (${customCount})`}
            </Button>
          )}
          </div>
          <div className="relative w-full lg:w-80">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary-400" />
            <Input
              value={templateSearch}
              onChange={(e) => setTemplateSearch(e.target.value)}
              placeholder="搜索模板名称、标识或说明"
              className="pl-9"
            />
          </div>
        </div>

        <div className="grid-auto-fill">
          {filteredTemplates.map((template) => (
            <Card
              key={template.id}
              className="border-primary-200 hover:shadow-lg transition-all group"
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="text-4xl">{template.icon}</div>
                  <Badge variant={template.has_rules ? 'default' : 'secondary'}>
                    {template.has_rules ? '已配置' : '待完善'}
                  </Badge>
                </div>
                <CardTitle className="text-lg">{template.name}</CardTitle>
                <CardDescription className="text-sm">
                  {template.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full group-hover:border-accent group-hover:text-accent transition-colors"
                  onClick={() => handleViewDetails(template)}
                >
                  <Eye className="h-4 w-4 mr-2" />
                  查看详情
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => navigate(`/document/enhanced-preview?templateId=${template.id}`)}
                >
                  <Settings2 className="h-4 w-4 mr-2" />
                  实时排版
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => handleDownloadTemplate(template)}
                  disabled={downloadingId === `dotx-${template.id}`}
                >
                  {downloadingId === `dotx-${template.id}`
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <Download className="h-4 w-4 mr-2" />}
                  {downloadingId === `dotx-${template.id}` ? '下载中...' : '下载模板'}
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => navigate(`/document/enhanced-preview?templateId=${template.id}`)}
                    title="打开实时排版编辑器，可实时调整样式并下载"
                  >
                    <Sparkles className="h-3 w-3 mr-1" />
                    样式预览
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => handleDownloadStyleDotx(template)}
                    title="下载可安装到Word/WPS模板库的.dotx文件"
                    disabled={downloadingId === `inst-${template.id}`}
                  >
                    {downloadingId === `inst-${template.id}`
                      ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      : <FileDown className="h-3 w-3 mr-1" />}
                    {downloadingId === `inst-${template.id}` ? '...' : '安装模板'}
                  </Button>
                </div>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => handleEditRules(template)}
                >
                  <Settings className="h-4 w-4 mr-2" />
                  编辑规则
                  <ChevronRight className="h-4 w-4 ml-auto" />
                </Button>
                {template.source === 'official' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => handleDuplicateTemplate(template)}
                    disabled={duplicatingId === template.id}
                    title="复制为用户自定义模板，之后可独立修改规则"
                  >
                    {duplicatingId === template.id
                      ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      : <Copy className="h-4 w-4 mr-2" />}
                    {duplicatingId === template.id ? '复制中...' : '复制为自定义'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-status-error hover:text-status-error hover:bg-status-error-bg"
                  onClick={() => handleDeleteTemplate(template)}
                  disabled={deletingId === template.id}
                  title={template.source === 'official' ? '从模板中心删除内置模板' : '删除自定义模板'}
                >
                  {deletingId === template.id
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <Trash2 className="h-4 w-4 mr-2" />}
                  {deletingId === template.id ? '删除中...' : '删除模板'}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {filteredTemplates.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <p>暂无该分类的模板</p>
          </div>
        )}

        {/* 新增模板对话框 - 基本信息 */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="max-w-md w-full max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>新增模板 - 基本信息</DialogTitle>
              <p className="text-sm text-muted-foreground">第 1 步：填写模板基本信息</p>
            </DialogHeader>
            <div className="space-y-4">
                <div>
                  <Label htmlFor="name">模板名称 *</Label>
                  <Input
                    id="name"
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                    placeholder="例如：工作方案"
                  />
                </div>

                <div>
                  <Label htmlFor="document_type">文档类型（英文标识）*</Label>
                  <Input
                    id="document_type"
                    value={newTemplate.document_type}
                    onChange={(e) => setNewTemplate({ ...newTemplate, document_type: e.target.value })}
                    placeholder="例如：work_plan"
                  />
                  <p className="text-xs text-muted-foreground mt-1">用于系统内部识别，建议使用小写字母和下划线</p>
                </div>

                <div>
                  <Label htmlFor="description">描述 *</Label>
                  <Textarea
                    id="description"
                    value={newTemplate.description}
                    onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                    placeholder="简要描述模板用途和适用场景"
                    rows={3}
                  />
                </div>

                <div>
                  <Label htmlFor="icon">图标 Emoji</Label>
                  <Input
                    id="icon"
                    value={newTemplate.icon}
                    onChange={(e) => setNewTemplate({ ...newTemplate, icon: e.target.value })}
                    placeholder="📋"
                    maxLength={2}
                  />
                  <p className="text-xs text-muted-foreground mt-1">推荐使用单个 Emoji 表情</p>
                </div>

                <div className="flex items-center gap-2 p-3 bg-primary-50 rounded-lg">
                  <input
                    type="checkbox"
                    id="custom_rules"
                    checked={newTemplate.custom_rules}
                    onChange={(e) => setNewTemplate({ ...newTemplate, custom_rules: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="custom_rules" className="cursor-pointer">
                    自定义检查规则（推荐）
                  </Label>
                </div>
                {newTemplate.custom_rules && (
                  <p className="text-xs text-muted-foreground bg-status-info-bg p-3 rounded">
                    💡 下一步将配置检查规则，包括字段选择、期望值和提示信息
                  </p>
                )}

                <div className="flex gap-3 pt-4 border-t">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setShowCreateDialog(false)}
                    disabled={creating}
                  >
                    取消
                  </Button>
                  {newTemplate.custom_rules ? (
                    <Button
                      className="flex-1"
                      onClick={() => {
                        if (!newTemplate.name || !newTemplate.document_type || !newTemplate.description) {
                          warning('提示', '请先填写所有必填项');
                          return;
                        }
                        setShowCreateDialog(false);
                        setShowRulesDialog(true);
                      }}
                    >
                      下一步：配置规则
                      <ChevronRight className="h-4 w-4 ml-2" />
                    </Button>
                  ) : (
                    <Button
                      className="flex-1"
                      onClick={handleCreateTemplate}
                      disabled={creating}
                    >
                      {creating ? '创建中...' : '完成创建'}
                    </Button>
                  )}
                </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* 自定义规则配置对话框 */}
        <Dialog open={showRulesDialog} onOpenChange={() => {}}>
          <DialogContent className="max-w-3xl w-full max-h-[85vh] overflow-y-auto">
            <DialogHeader className="sticky top-0 bg-background z-10 border-b pb-4">
              <DialogTitle>配置检查规则</DialogTitle>
              <p className="text-sm text-muted-foreground">第 2 步：为模板 "{newTemplate.name}" 添加检查规则</p>
            </DialogHeader>
            <div className="space-y-4 pt-2">
                {customRules.map((rule, index) => (
                  <Card key={index} className="p-4 bg-primary-50">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-medium">规则 {index + 1}</h4>
                      {customRules.length > 1 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeRule(index)}
                          className="text-status-error hover:text-status-error hover:bg-status-error-bg"
                        >
                          删除
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>规则名称 *</Label>
                        <Input
                          value={rule.name}
                          onChange={(e) => updateRule(index, 'name', e.target.value)}
                          placeholder="例如：标题字体检查"
                        />
                      </div>
                      <div>
                        <Label>严重程度 *</Label>
                        <Select
                          value={rule.severity}
                          onValueChange={(value) => updateRule(index, 'severity', value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="选择严重程度" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="P0">P0 - 必须修复</SelectItem>
                            <SelectItem value="P1">P1 - 建议修复</SelectItem>
                            <SelectItem value="P2">P2 - 可选修复</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>检查字段 *</Label>
                        <Select
                          value={rule.field}
                          onValueChange={(value) => updateRule(index, 'field', value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="请选择字段" />
                          </SelectTrigger>
                          <SelectContent>
                            {ruleFields.map((field) => (
                              <SelectItem key={field.value} value={field.value}>
                                {ruleFieldLabel(field)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>期望值 *</Label>
                        <Input
                          value={rule.expected}
                          onChange={(e) => updateRule(index, 'expected', e.target.value)}
                          placeholder="例如：方正小标宋简体"
                        />
                      </div>
                      <div className="col-span-2">
                        <Label>提示信息 *</Label>
                        <Input
                          value={rule.message}
                          onChange={(e) => updateRule(index, 'message', e.target.value)}
                          placeholder="例如：标题应使用方正小标宋简体"
                        />
                      </div>
                    </div>
                  </Card>
                ))}

                <Button
                  variant="outline"
                  onClick={addCustomRule}
                  className="w-full border-dashed border-2"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  添加规则
                </Button>

                <div className="flex gap-3 pt-4 border-t sticky bottom-0 bg-background">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowRulesDialog(false);
                      setShowCreateDialog(true);
                    }}
                  >
                    上一步
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleCreateTemplate}
                    disabled={creating}
                  >
                    {creating ? '创建中...' : '完成创建'}
                  </Button>
                </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* 模板 A4 预览弹窗 */}
        {previewTemplate && (
          <A4PreviewModal
            templateId={previewTemplate.id}
            templateName={previewTemplate.name}
            onClose={() => setPreviewTemplate(null)}
          />
        )}
      </div>
    </div>
  );
}
