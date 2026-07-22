/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * AI 配置状态工具
 * 供 Sidebar、RightPanel、CheckCenter 等多处共用
 * Provider 列表由后端按在线/离线模式过滤。
 */
import apiClient from '@/api/client';

export interface AIStatus {
  provider: string;
  model: string;
  active: boolean;
  exists: boolean;
}

/**
 * 检测当前已激活的 AI 配置
 * 返回第一个已激活的配置；没有激活项时返回一个已保存的未激活配置。
 */
export async function detectActiveAI(): Promise<AIStatus | null> {
  const providerResponse = await apiClient.get('/api/ai/providers');
  const providers = Array.from(new Set(
    (Array.isArray(providerResponse?.providers) ? providerResponse.providers : [])
      .map((item: string | { provider?: string }) => typeof item === 'string' ? item : item.provider)
      .filter((item: string | undefined): item is string => Boolean(item)),
  ));

  let lastFound: AIStatus | null = null;

  for (const provider of providers) {
    try {
      const data = await apiClient.get(`/api/ai/config/${provider}`);
      if (data?.exists) {
        const status: AIStatus = {
          provider: data.provider || provider,
          model: data.model || '-',
          active: !!data.is_active,
          exists: true,
        };
        lastFound = status;
        // 找到激活的立即返回
        if (status.active) return status;
      }
    } catch {
      // 该 provider 未配置，继续检查下一个
    }
  }

  return lastFound;
}
