/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * DocumentProcess - 文档处理页面
 * 选择文档、选择类型、开始检查
 */
import { useState, useEffect, useId, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, Loader2, CheckCircle2, ChevronDown } from 'lucide-react';
import PageHeader from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { apiClient } from '@/api/client';
import { useToast } from '@/components/ui/toast';

interface DocumentType {
  value: string;
  label: string;
  category: string;
  description: string;
}

interface TemplateListItem {
  id: string;
  name: string;
  category?: string;
  source?: string;
  description?: string;
}

interface TemplateListResponse {
  templates?: TemplateListItem[];
}

type ApiError = {
  response?: {
    data?: {
      detail?: string;
    };
  };
};

export default function DocumentProcess() {
  const navigate = useNavigate();
  const { warning } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [typeSearch, setTypeSearch] = useState('');
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const [activeTypeIndex, setActiveTypeIndex] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typeInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const typeInputId = useId();
  const typeListboxId = useId();

  // 根据搜索词过滤类型（支持中文名和英文标识双向匹配）
  const filteredDocTypes = typeSearch.trim()
    ? documentTypes.filter(t =>
        t.value.toLowerCase().includes(typeSearch.toLowerCase()) ||
        t.label.includes(typeSearch)
      )
    : documentTypes;

  // 按分类分组过滤后的类型
  const filteredGovernment = filteredDocTypes.filter(t => t.category === 'government');
  const filteredRegional = filteredDocTypes.filter(t => t.category === 'regional');
  const filteredCommon = filteredDocTypes.filter(t => t.category === 'common');
  const filteredCustom = filteredDocTypes.filter(t => t.category === 'custom');
  const visibleTypeGroups = [
    { key: 'government', label: '政府机关', items: filteredGovernment },
    { key: 'regional', label: '福建省', items: filteredRegional },
    { key: 'common', label: '其他常用', items: filteredCommon },
    { key: 'custom', label: '自定义', items: filteredCustom },
  ].filter(group => group.items.length > 0);
  const visibleDocumentTypes = visibleTypeGroups.flatMap(group => group.items);

  // 获取当前选中类型的显示名
  const selectedTypeLabel = documentTypes.find(t => t.value === documentType)?.label;

  useEffect(() => {
    if (!showTypeDropdown) return;
    document.getElementById(`${typeListboxId}-option-${activeTypeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeTypeIndex, showTypeDropdown, typeListboxId]);

  // 从后端API动态获取文档类型列表（包含官方+自定义）
  useEffect(() => {
    const loadDocumentTypes = async () => {
      try {
        const response = await apiClient.get('/api/templates/list');
        const templates = (response as TemplateListResponse).templates || [];
        const types: DocumentType[] = templates.map((t) => ({
          value: t.id,
          label: t.name,
          category: t.category || (t.source === 'custom' || t.source === 'user' ? 'custom' : 'government'),
          description: t.description || '',
        }));
        setDocumentTypes(types);
      } catch (error) {
        console.error('Failed to load document types:', error);
        // 回退到基础列表
        setDocumentTypes([
          { value: 'notice', label: '通知', category: 'government', description: '' },
          { value: 'request', label: '请示', category: 'government', description: '' },
          { value: 'report', label: '报告', category: 'government', description: '' },
          { value: 'letter', label: '函', category: 'government', description: '' },
        ]);
      }
    };
    loadDocumentTypes();
  }, []);

  const isSupportedFormat = (name: string) => {
    const ext = name.toLowerCase().split('.').pop();
    return ext === 'docx' || ext === 'doc' || ext === 'wps';
  };

  const selectFile = (selectedFile?: File | null) => {
    if (!selectedFile) return;
    if (isSupportedFormat(selectedFile.name)) {
      setFile(selectedFile);
      setErrorMessage('');
      return;
    }
    warning('提示', '请选择 .docx、.doc 或 .wps 格式的文档');
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    selectFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setDragActive(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);

    if (e.dataTransfer.files.length > 1) {
      warning('提示', '一次只能添加一个文档');
      return;
    }
    selectFile(e.dataTransfer.files[0]);
  };

  const selectDocumentType = (type: DocumentType) => {
    setDocumentType(type.value);
    setTypeSearch('');
    setShowTypeDropdown(false);
    setActiveTypeIndex(0);
  };

  const handleTypeKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const optionCount = visibleDocumentTypes.length;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!showTypeDropdown) {
        setShowTypeDropdown(true);
        setTypeSearch('');
        const selectedIndex = visibleDocumentTypes.findIndex(type => type.value === documentType);
        setActiveTypeIndex(selectedIndex >= 0 ? selectedIndex : 0);
        return;
      }
      if (optionCount === 0) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveTypeIndex(current => (current + direction + optionCount) % optionCount);
      return;
    }

    if (event.key === 'Home' && showTypeDropdown && optionCount > 0) {
      event.preventDefault();
      setActiveTypeIndex(0);
      return;
    }

    if (event.key === 'End' && showTypeDropdown && optionCount > 0) {
      event.preventDefault();
      setActiveTypeIndex(optionCount - 1);
      return;
    }

    if (event.key === 'Enter' && showTypeDropdown) {
      event.preventDefault();
      const selected = visibleDocumentTypes[activeTypeIndex] ?? visibleDocumentTypes[0];
      if (selected) selectDocumentType(selected);
      return;
    }

    if (event.key === 'Escape' && showTypeDropdown) {
      event.preventDefault();
      setShowTypeDropdown(false);
      setTypeSearch('');
    }
  };

  const handleStartCheck = async () => {
    if (!file || !documentType) {
      warning('提示', '请先选择文档并选择类型');
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setErrorMessage('');

    try {
      // Step 1: Upload document
      setCurrentStep('正在上传文档...');
      setProgress(20);

      const formData = new FormData();
      formData.append('file', file);

      const uploadResponse = await apiClient.post('/api/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const uploadedDocId = uploadResponse.id;

      // Step 2: Run format check
      setCurrentStep('正在执行格式检查...');
      setProgress(50);

      await apiClient.post(`/api/check/${uploadedDocId}`, {
        document_type: documentType,
      });

      // Step 3: Complete
      setCurrentStep('检查完成！');
      setProgress(100);

      // Navigate to check center
      setTimeout(() => {
        navigate(`/document/check?docId=${uploadedDocId}&type=${documentType}`);
      }, 500);

    } catch (error: unknown) {
      const apiError = error as ApiError;
      setErrorMessage(apiError.response?.data?.detail || '处理失败，请重试');
      setIsProcessing(false);
      console.error('Processing error:', error);
    }
  };

  return (
    <div
      className="relative w-full bg-primary-50"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-4 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-light/80 text-accent font-medium">
          松开添加文档
        </div>
      )}
      <PageHeader
        title="文档处理"
        description="选择 Word 文档开始智能检查"
      />

      <div className="p-4 md:p-6 lg:p-8 w-full space-y-6">
        {/* Error Message */}
        {errorMessage && (
          <div role="alert" className="p-4 bg-status-error-bg border border-status-error/20 rounded-lg text-status-error">
            {errorMessage}
          </div>
        )}

        {/* 文件选择区域 */}
        {!file ? (
          <>
          <button
            type="button"
            className={`w-full rounded-xl border-2 border-dashed bg-card text-card-foreground shadow-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${dragActive ? 'border-accent bg-accent-light/20' : 'border-primary-200 hover:border-accent hover:bg-accent-light/10'}`}
            onClick={() => fileInputRef.current?.click()}
            aria-describedby="file-upload-formats file-upload-size-guidance"
          >
            <span className="block py-16 px-6">
              <span className="block text-center">
                <Upload aria-hidden="true" className="mx-auto h-12 w-12 text-primary-300 mb-4" />
                <span className="block text-lg text-primary-700 font-medium">
                  拖拽文件到此处
                </span>
                <span className="block text-sm text-primary-500 mt-2">
                  或点击选择 Word 文档
                </span>
                <span id="file-upload-formats" className="block text-xs text-primary-400 mt-4">
                  支持格式：.docx / .doc / .wps | 建议 10MB 以内
                </span>
                <span id="file-upload-size-guidance" className="block text-xs text-status-warning mt-1">
                  大型文档（超过10MB）建议使用 WPS/Word 插件
                </span>
              </span>
            </span>
          </button>
          <input
            ref={fileInputRef}
            id="file-input"
            type="file"
            accept=".docx,.doc,.wps"
            className="hidden"
            tabIndex={-1}
            onChange={handleFileSelect}
          />
          </>
        ) : (
          <>
            {/* 已选择文件 */}
            <Card>
              <CardContent className="py-6">
                <div className="flex items-center gap-4">
                  <FileText className="h-10 w-10 text-accent" />
                  <div className="flex-1">
                    <p className="font-medium text-primary-900">{file.name}</p>
                    <p className="text-sm text-primary-500">
                      {(file.size / 1024).toFixed(2)} KB
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setFile(null);
                      setDocumentType('');
                      setProgress(0);
                    }}
                    disabled={isProcessing}
                  >
                    重新选择
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* 文档类型选择 — 带搜索的动态下拉 */}
            <Card>
              <CardContent className="py-6">
                <label htmlFor={typeInputId} className="block text-sm font-medium text-primary-700 mb-2">
                  文档类型
                </label>
                <div
                  className="relative"
                  onBlur={event => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setShowTypeDropdown(false);
                    }
                  }}
                >
                  <div className="relative">
                    <input
                      id={typeInputId}
                      ref={typeInputRef}
                      type="text"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={showTypeDropdown}
                      aria-controls={typeListboxId}
                      aria-activedescendant={showTypeDropdown && visibleDocumentTypes[activeTypeIndex]
                        ? `${typeListboxId}-option-${activeTypeIndex}`
                        : undefined}
                      aria-required="true"
                      autoComplete="off"
                      value={showTypeDropdown ? typeSearch : (documentType ? `${selectedTypeLabel || ''}（${documentType}）` : '')}
                      onChange={(e) => {
                        setTypeSearch(e.target.value);
                        setShowTypeDropdown(true);
                        setActiveTypeIndex(0);
                        // 如果清空了搜索词，也清空选中
                        if (!e.target.value) setDocumentType('');
                      }}
                      onFocus={() => {
                        setTypeSearch('');
                        setShowTypeDropdown(true);
                        const selectedIndex = visibleDocumentTypes.findIndex(type => type.value === documentType);
                        setActiveTypeIndex(selectedIndex >= 0 ? selectedIndex : 0);
                      }}
                      onKeyDown={handleTypeKeyDown}
                      placeholder="输入搜索或点击选择文档类型"
                      disabled={isProcessing}
                      className="w-full border border-primary-200 rounded-md px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                    />
                    <button
                      type="button"
                      aria-label={showTypeDropdown ? '收起文档类型列表' : '展开文档类型列表'}
                      aria-controls={typeListboxId}
                      aria-expanded={showTypeDropdown}
                      disabled={isProcessing}
                      className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded text-primary-400 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => {
                        if (!isProcessing) {
                          setShowTypeDropdown(!showTypeDropdown);
                          typeInputRef.current?.focus();
                        }
                      }}
                    >
                      <ChevronDown aria-hidden="true" className="h-4 w-4" />
                    </button>
                  </div>
                  {showTypeDropdown && (
                    <div
                      id={typeListboxId}
                      role="listbox"
                      aria-label="文档类型"
                      className="absolute z-50 w-full mt-1 bg-white border border-primary-200 rounded-lg shadow-lg max-h-64 overflow-y-auto"
                    >
                      {visibleTypeGroups.map(group => (
                        <div key={group.key} role="group" aria-label={group.label}>
                          <div role="presentation" className="px-3 py-1.5 text-xs font-medium text-primary-400 bg-primary-50 sticky top-0">
                            {group.label}
                          </div>
                          {group.items.map(type => {
                            const optionIndex = visibleDocumentTypes.findIndex(item => item.value === type.value);
                            const active = optionIndex === activeTypeIndex;
                            return (
                              <button
                                id={`${typeListboxId}-option-${optionIndex}`}
                                key={type.value}
                                type="button"
                                role="option"
                                aria-selected={documentType === type.value}
                                tabIndex={-1}
                                className={`w-full px-3 py-2 text-left text-sm cursor-pointer hover:bg-primary-50 flex items-center justify-between ${documentType === type.value ? 'bg-accent/10 text-accent' : ''} ${active ? 'outline outline-1 outline-accent -outline-offset-1' : ''}`}
                                onMouseEnter={() => setActiveTypeIndex(optionIndex)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => selectDocumentType(type)}
                              >
                                <span className="font-medium">{type.label}</span>
                                <span className="text-xs text-muted-foreground">{type.value}</span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                      {filteredDocTypes.length === 0 && (
                        <div role="status" className="px-3 py-4 text-sm text-muted-foreground text-center">
                          未找到匹配的文档类型
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* 处理进度 */}
            {isProcessing && (
              <Card>
                <CardContent className="py-6">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <Loader2 className="h-5 w-5 animate-spin text-accent" />
                      <span className="text-sm text-primary-700">{currentStep}</span>
                    </div>
                    <Progress value={progress} className="h-2" />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 开始检查按钮 */}
            <Button
              className="w-full h-12 text-base"
              onClick={handleStartCheck}
              disabled={!documentType || isProcessing}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  处理中...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-5 w-5 mr-2" />
                  开始检查
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
