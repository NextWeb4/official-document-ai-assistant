/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Modifications (c) 2026 HaoXiang Huang (https://nextweb4.github.io/)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * PageHeader - 页面标题栏
 * 响应式：小屏堆叠，大屏横排
 */
import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="page-heading">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1>{title}</h1>
          {description && (
            <p>{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
