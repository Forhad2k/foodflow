import { describe, expect, it } from 'vitest';
import { TRANSLATIONS } from '../src/lib/i18n';

describe('Bengali & English Translations', () => {
  it('has both en and bn dictionary keys matching', () => {
    const enKeys = Object.keys(TRANSLATIONS.en);
    const bnKeys = Object.keys(TRANSLATIONS.bn);

    expect(enKeys.length).toBeGreaterThan(10);
    expect(bnKeys.length).toBeGreaterThan(10);

    // Ensure all critical customer keys exist in Bengali
    expect(TRANSLATIONS.bn.cart).toBe('কার্ট');
    expect(TRANSLATIONS.bn.open_now).toBe('এখন খোলা');
    expect(TRANSLATIONS.bn.closed_now).toBe('বর্তমানে বন্ধ');
    expect(TRANSLATIONS.bn.free_delivery).toBe('ফ্রি ডেলিভারি');
    expect(TRANSLATIONS.bn.live_tracking).toBe('লাইভ রাইডার ট্র্যাকিং');
  });
});

