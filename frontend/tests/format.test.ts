import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDistance,
  formatEta,
  formatMoney,
  isActiveStatus,
  STATUS_LABEL,
  statusTone,
} from '../src/lib/format';

describe('formatMoney', () => {
  it('formats integer taka values with BDT symbol', () => {
    expect(formatMoney(32000)).toBe('৳320');
    expect(formatMoney(5000)).toBe('৳50');
    expect(formatMoney(0)).toBe('৳0');
  });

  it('formats paisa fractions correctly', () => {
    expect(formatMoney(32050)).toBe('৳320.50');
    expect(formatMoney(99)).toBe('৳0.99');
  });
});

describe('formatDistance', () => {
  it('formats meters when under 1000m', () => {
    expect(formatDistance(450)).toBe('450 m');
    expect(formatDistance(85)).toBe('90 m');
  });

  it('formats kilometers when >= 1000m', () => {
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(4200)).toBe('4.2 km');
  });
});

describe('formatEta', () => {
  it('formats min-max range', () => {
    expect(formatEta({ min: 25, max: 35 })).toBe('25–35');
  });
});

describe('STATUS_LABEL and isActiveStatus', () => {
  it('identifies active moving orders', () => {
    expect(isActiveStatus('PLACED')).toBe(true);
    expect(isActiveStatus('PREPARING')).toBe(true);
    expect(isActiveStatus('ON_THE_WAY')).toBe(true);
    expect(isActiveStatus('DELIVERED')).toBe(false);
    expect(isActiveStatus('CANCELLED')).toBe(false);
  });

  it('provides customer-friendly labels', () => {
    expect(STATUS_LABEL.PLACED).toBe('Sent to the restaurant');
    expect(STATUS_LABEL.PREPARING).toBe('Being prepared');
    expect(STATUS_LABEL.DELIVERED).toBe('Delivered');
  });

  it('maps correct status tones', () => {
    expect(statusTone('DELIVERED')).toBe('success');
    expect(statusTone('CANCELLED')).toBe('danger');
    expect(statusTone('PREPARING')).toBe('accent');
  });
});

