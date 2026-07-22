import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { englishUi } from './english';

const storedLanguage = typeof window === 'undefined'
  ? 'zh'
  : window.localStorage.getItem('app-language') === 'en' ? 'en' : 'zh';

void i18n
  .use(initReactI18next)
  .init({
    lng: storedLanguage,
    fallbackLng: 'zh',
    keySeparator: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: { translation: {} },
      en: { translation: englishUi },
    },
  });

if (typeof document !== 'undefined') {
  document.documentElement.lang = storedLanguage === 'en' ? 'en' : 'zh-CN';
}

i18n.on('languageChanged', language => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('app-language', language);
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  }
});

export default i18n;
