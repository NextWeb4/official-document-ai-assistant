/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Routes, Route } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import ErrorBoundary from './components/ui/error-boundary';

const Workspace = lazy(() => import('./pages/Workspace'));
const DocumentProcess = lazy(() => import('./pages/DocumentProcess'));
const CheckCenter = lazy(() => import('./pages/CheckCenter'));
const Templates = lazy(() => import('./pages/Templates'));
const TemplateRules = lazy(() => import('./pages/TemplateRules'));
const Rules = lazy(() => import('./pages/Rules'));
const AISettings = lazy(() => import('./pages/AISettings'));
const About = lazy(() => import('./pages/About'));
const A4Preview = lazy(() => import('./pages/A4Preview'));
const ImportTemplate = lazy(() => import('./pages/ImportTemplate'));
const EnhancedA4Preview = lazy(() => import('./pages/EnhancedA4Preview'));

function RouteLoadingState() {
  return (
    <div
      className="flex min-h-screen items-center justify-center px-6 text-sm text-primary-600"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      正在加载页面...
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppLayout>
        <ErrorBoundary>
          <Suspense fallback={<RouteLoadingState />}>
            <Routes>
              <Route path="/" element={<Workspace />} />
              <Route path="/workspace" element={<Workspace />} />
              <Route path="/document/process" element={<DocumentProcess />} />
              <Route path="/document/check" element={<CheckCenter />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/templates/import" element={<ImportTemplate />} />
              <Route path="/templates/:templateId/rules" element={<TemplateRules />} />
              <Route path="/rules" element={<Rules />} />
              <Route path="/settings/ai" element={<AISettings />} />
              <Route path="/document/preview" element={<A4Preview />} />
              <Route path="/document/enhanced-preview" element={<EnhancedA4Preview />} />
              <Route path="/about" element={<About />} />
              <Route path="*" element={<Navigate to="/workspace" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </AppLayout>
    </HashRouter>
  );
}
