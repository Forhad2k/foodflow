'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Language = 'en' | 'bn';

export const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en: {
    brand_flow: 'Flow',
    cart: 'Cart',
    sign_in: 'Sign in',
    sign_up: 'Join',
    sign_out: 'Sign out',
    my_orders: 'My orders',
    profile_addresses: 'Profile & Addresses',
    set_location: 'Set delivery location',
    search_placeholder: 'Search restaurants, burgers, biryani, or dishes',
    filters: 'Filters',
    favorites: 'Favorites',
    open_near_you: "What's open near you?",
    open_now: 'Open now',
    closed_now: 'Closed right now',
    free_delivery: 'Free delivery',
    delivery: 'delivery',
    away: 'away',
    min_order: 'min',
    subtotal: 'Subtotal',
    service_fee: 'Service fee',
    tax: 'Tax',
    discount: 'Discount',
    total: 'Total',
    cancel_order: 'Cancel order',
    progress: 'Progress',
    live_tracking: 'Live Rider Tracking',
    report_problem: 'Report a problem',
    review_order: 'Review order',
    request_refund: 'Request refund',
    chat_with_rider: 'Chat with Rider',
  },
  bn: {
    brand_flow: 'ফ্লো',
    cart: 'কার্ট',
    sign_in: 'লগ ইন',
    sign_up: 'যোগ দিন',
    sign_out: 'সাইন আউট',
    my_orders: 'আমার অর্ডার',
    profile_addresses: 'প্রোফাইল ও ঠিকানা',
    set_location: 'ডেলিভারি ঠিকানা নির্বাচন করুন',
    search_placeholder: 'রেস্তোরাঁ, বিরিয়ানি বা খাবারের নাম খুঁজুন',
    filters: 'ফিল্টার',
    favorites: 'পছন্দের রেস্তোরাঁ',
    open_near_you: 'আপনার আশেপাশে কী খোলা আছে?',
    open_now: 'এখন খোলা',
    closed_now: 'বর্তমানে বন্ধ',
    free_delivery: 'ফ্রি ডেলিভারি',
    delivery: 'ডেলিভারি',
    away: 'দূরে',
    min_order: 'সর্বনিম্ন',
    subtotal: 'সাবটোটাল',
    service_fee: 'সার্ভিস ফি',
    tax: 'ভ্যাট / ট্যাক্স',
    discount: 'ছাড়',
    total: 'মোট',
    cancel_order: 'অর্ডার বাতিল করুন',
    progress: 'অগ্রগতি',
    live_tracking: 'লাইভ রাইডার ট্র্যাকিং',
    report_problem: 'অভিযোগ জানান',
    review_order: 'রিভিউ দিন',
    request_refund: 'রিফান্ড আবেদন',
    chat_with_rider: 'রাইডারের সাথে চ্যাট',
  },
};

interface I18nContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: 'en',
  setLang: () => undefined,
  t: (key: string) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>('en');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('ff.lang') as Language;
      if (saved === 'en' || saved === 'bn') setLangState(saved);
    } catch {
      // ignore
    } finally {
      setInitialized(true);
    }
  }, []);

  const setLang = (newLang: Language) => {
    setLangState(newLang);
    try {
      localStorage.setItem('ff.lang', newLang);
    } catch {
      // ignore
    }
  };

  const t = (key: string) => {
    return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
  };

  if (!initialized) {
    // Render a minimal placeholder to avoid hydration mismatch
    return <>{children}</>;
  }

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

