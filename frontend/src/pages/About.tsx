/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Modifications (c) 2026 HaoXiang Huang (https://nextweb4.github.io/)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import {
  Code2,
  ExternalLink,
  FileText,
  Globe2,
  Mail,
  Scale,
  ShieldCheck,
} from 'lucide-react';

const standards = [
  'GB/T 9704-2012《党政机关公文格式》',
  '国家行政机关公文处理办法',
  '各级政府机关公文规范要求',
];

const runtime = [
  ['Desktop', 'Electron + React'],
  ['Engine', 'Python + FastAPI'],
  ['Document', 'python-docx'],
  ['Storage', 'SQLite / 本机目录'],
];

export default function About() {
  return (
    <div className="about-page">
      <section className="about-masthead">
        <div className="about-product-mark" aria-hidden="true">
          <FileText />
          <span>Hx</span>
        </div>
        <div className="about-product-copy">
          <span className="about-kicker">LOCAL DOCUMENT WORKSPACE / VERSION {__APP_VERSION__}</span>
          <h2>HaoXiang Document Assistant</h2>
          <p>面向本机公文校审、格式修复与规范导出的桌面工作台。</p>
        </div>
      </section>

      <section className="about-authorship" aria-labelledby="author-heading">
        <div className="about-author-primary">
          <span className="about-kicker">DESIGNED & MAINTAINED BY</span>
          <h3 id="author-heading">HaoXiang Huang</h3>
          <a href="https://nextweb4.github.io/" target="_blank" rel="noreferrer">
            <Globe2 aria-hidden="true" />
            nextweb4.github.io
            <ExternalLink aria-hidden="true" />
          </a>
          <a href="mailto:Rays688888@Gmail.com">
            <Mail aria-hidden="true" />
            Rays688888@Gmail.com
          </a>
        </div>
        <div className="about-license-copy">
          <Scale aria-hidden="true" />
          <div>
            <strong>MIT License</strong>
            <p>
              本版本由 HaoXiang Huang 维护与重构。项目保留上游 Jose AI
              （linhut/document-ai-assistant）的 MIT 版权与许可声明。
            </p>
          </div>
        </div>
      </section>

      <section className="about-facts">
        <div>
          <div className="about-section-title">
            <ShieldCheck aria-hidden="true" />
            <span><small>STANDARD</small><strong>参考规范</strong></span>
          </div>
          <ol className="about-standard-list">
            {standards.map((standard, index) => (
              <li key={standard}>
                <span>0{index + 1}</span>
                <p>{standard}</p>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <div className="about-section-title">
            <Code2 aria-hidden="true" />
            <span><small>RUNTIME</small><strong>运行构成</strong></span>
          </div>
          <dl className="about-runtime-list">
            {runtime.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="about-disclaimer">
        <strong>使用边界</strong>
        <p>校审结果用于辅助判断，正式发文前仍应按实际发文机关要求完成人工复核。</p>
      </section>
    </div>
  );
}
