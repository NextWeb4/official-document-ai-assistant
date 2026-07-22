import { useEffect } from 'react';
import i18n from './index';
import { englishPatterns } from './english';

type TranslationRecord = { original: string; translated: string };

const textRecords = new WeakMap<Text, TranslationRecord>();
const attributeRecords = new WeakMap<Element, Map<string, TranslationRecord>>();
const translatableAttributes = ['title', 'aria-label', 'placeholder', 'alt'];

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function translate(value: string) {
  const source = normalize(value);
  if (!source) return value;

  let translated = i18n.t(source, { defaultValue: source });
  if (translated === source) {
    for (const rule of englishPatterns) {
      const match = source.match(rule.pattern);
      if (match) {
        translated = rule.replace(...match.slice(1));
        break;
      }
    }
  }
  if (translated === source) return value;

  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  return `${leading}${translated}${trailing}`;
}

function isIgnored(node: Node) {
  const element = node.parentElement;
  return !element
    || Boolean(element.closest('[data-no-i18n], code, pre, script, style, textarea'));
}

function syncText(node: Text, language: string) {
  if (isIgnored(node)) return;
  const current = node.data;
  const record = textRecords.get(node);

  if (language !== 'en') {
    if (record && current === record.translated && current !== record.original) {
      node.data = record.original;
    }
    return;
  }

  if (!record || current !== record.translated) {
    const next = translate(current);
    if (next !== current) {
      textRecords.set(node, { original: current, translated: next });
      node.data = next;
    } else {
      textRecords.delete(node);
    }
  }
}

function syncAttribute(element: Element, attribute: string, language: string) {
  if (element.closest('[data-no-i18n], code, pre, script, style, textarea')) return;
  const current = element.getAttribute(attribute);
  if (current === null) return;

  const records = attributeRecords.get(element) ?? new Map<string, TranslationRecord>();
  attributeRecords.set(element, records);
  const record = records.get(attribute);

  if (language !== 'en') {
    if (record && current === record.translated && current !== record.original) {
      element.setAttribute(attribute, record.original);
    }
    return;
  }

  if (!record || current !== record.translated) {
    const next = translate(current);
    if (next !== current) {
      records.set(attribute, { original: current, translated: next });
      element.setAttribute(attribute, next);
    } else {
      records.delete(attribute);
    }
  }
}

function syncNode(node: Node, language: string) {
  if (node.nodeType === Node.TEXT_NODE) syncText(node as Text, language);
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;
  const elementWalker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
  let currentElement: Element | null = element;
  while (currentElement) {
    for (const attribute of translatableAttributes) syncAttribute(currentElement, attribute, language);
    currentElement = elementWalker.nextNode() as Element | null;
  }

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  while (text) {
    syncText(text as Text, language);
    text = walker.nextNode();
  }
}

export function useDomTranslation() {
  useEffect(() => {
    const syncAll = () => {
      const language = i18n.resolvedLanguage;
      syncNode(document.body, language);
    };

    syncAll();
    const observer = new MutationObserver(mutations => {
      const language = i18n.resolvedLanguage;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') syncText(mutation.target as Text, language);
        if (mutation.type === 'attributes') {
          syncAttribute(mutation.target as Element, mutation.attributeName ?? '', language);
        }
        for (const node of mutation.addedNodes) syncNode(node, language);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: translatableAttributes,
    });

    const handleLanguageChange = () => syncAll();
    i18n.on('languageChanged', handleLanguageChange);
    return () => {
      observer.disconnect();
      i18n.off('languageChanged', handleLanguageChange);
    };
  }, []);
}
