import { describe, expect, it } from 'vitest';
import { normalizePhone } from '@/lib/phone';
import { statusTone, isActiveStatus, formatDateTime } from '@/lib/format';

describe('normalizePhone', () => {
  it('turns local and international Bangladesh numbers into E.164', () => {
    expect(normalizePhone('01712345678')).toBe('+8801712345678');
    expect(normalizePhone('017 1234 5678')).toBe('+8801712345678');
    expect(normalizePhone('8801712345678')).toBe('+8801712345678');
    expect(normalizePhone('+8801712345678')).toBe('+8801712345678');
    expect(normalizePhone('+14155550100')).toBe('+14155550100');
  });
  it('rejects things the API would reject', () => {
    for (const bad of ['', '017', '0171234567', '12345', 'abc', '+0123456789']) expect(normalizePhone(bad)).toBeNull();
  });
});

describe('order status helpers', () => {
  it('colours outcomes and knows which orders are still moving', () => {
    expect(statusTone('DELIVERED')).toBe('success');
    expect(statusTone('CANCELLED')).toBe('danger');
    expect(statusTone('PREPARING')).toBe('accent');
    expect(isActiveStatus('ON_THE_WAY')).toBe(true);
    expect(isActiveStatus('DELIVERED')).toBe(false);
    expect(isActiveStatus('PENDING_PAYMENT')).toBe(true);
  });
  it('shows times in Dhaka time regardless of the browser zone', () => {
    expect(formatDateTime('2026-10-12T10:00:00Z')).toMatch(/4:00\s?pm/i); // UTC+6
  });
});
