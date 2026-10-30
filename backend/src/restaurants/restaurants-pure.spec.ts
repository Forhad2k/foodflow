import { ApprovalStatus } from '@prisma/client';
import { commissionMinor } from '../checkout/pricing';
import { applyApprovalAction, missingForApproval } from './approval';
import { validateHours } from './hours.validation';
import { assertImageUrls } from './image-urls';
import { validateRing } from './zones.sql';

const w = (dayOfWeek: number, opensAtMin: number, closesAtMin: number) => ({ dayOfWeek, opensAtMin, closesAtMin });
const code = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e: any) { return e.code; } };

describe('validateHours', () => {
  it('accepts normal, split-shift and after-midnight schedules', () => {
    expect(validateHours([w(1, 600, 1380)])).toBeNull();
    expect(validateHours([w(1, 660, 900), w(1, 1080, 1320)])).toBeNull();
    expect(validateHours([w(5, 1080, 1560), w(6, 1080, 1560), w(0, 1080, 1320)])).toBeNull(); // Fri/Sat close 02:00
    expect(validateHours([])).toBeNull(); // "closed all week" is a valid (if useless) schedule
  });
  it('rejects bad ranges', () => {
    expect(validateHours([w(7, 600, 700)])).toMatch(/dayOfWeek/);
    expect(validateHours([w(1, -1, 700)])).toMatch(/opening/);
    expect(validateHours([w(1, 1440, 1500)])).toMatch(/opening/);
    expect(validateHours([w(1, 700, 700)])).toMatch(/after opening/);
    expect(validateHours([w(1, 700, 600)])).toMatch(/after opening/);
    expect(validateHours([w(1, 600, 1801)])).toMatch(/06:00/);
    expect(validateHours([w(1, 600.5, 700)])).not.toBeNull();
  });
  it('rejects overlaps, too many periods, and spill-over collisions', () => {
    expect(validateHours([w(1, 600, 900), w(1, 800, 1000)])).toMatch(/overlapping/);
    expect(validateHours([w(1, 0, 100), w(1, 200, 300), w(1, 400, 500), w(1, 600, 700), w(1, 800, 900)])).toMatch(/at most 4/);
    expect(validateHours([w(1, 1080, 1560), w(2, 60, 300)])).toMatch(/past midnight/); // Mon runs to 02:00 but Tue opens 01:00
    expect(validateHours([w(6, 1080, 1560), w(0, 60, 300)])).toMatch(/past midnight/); // wraps Sat → Sun
  });
});

describe('approval workflow', () => {
  const S = ApprovalStatus;
  it('follows the allowed paths', () => {
    expect(applyApprovalAction(S.PENDING, 'approve')).toBe(S.APPROVED);
    expect(applyApprovalAction(S.PENDING, 'reject', 'Photos missing')).toBe(S.REJECTED);
    expect(applyApprovalAction(S.APPROVED, 'suspend', 'Hygiene complaint')).toBe(S.SUSPENDED);
    expect(applyApprovalAction(S.SUSPENDED, 'reinstate')).toBe(S.APPROVED);
    expect(applyApprovalAction(S.REJECTED, 'resubmit')).toBe(S.PENDING);
  });
  it('refuses everything else', () => {
    expect(code(() => applyApprovalAction(S.APPROVED, 'approve'))).toBe('INVALID_APPROVAL_TRANSITION');
    expect(code(() => applyApprovalAction(S.REJECTED, 'approve'))).toBe('INVALID_APPROVAL_TRANSITION');
    expect(code(() => applyApprovalAction(S.PENDING, 'suspend', 'x'))).toBe('INVALID_APPROVAL_TRANSITION');
    expect(code(() => applyApprovalAction(S.SUSPENDED, 'resubmit'))).toBe('INVALID_APPROVAL_TRANSITION');
  });
  it('requires a reason to reject or suspend', () => {
    expect(code(() => applyApprovalAction(S.PENDING, 'reject'))).toBe('REASON_REQUIRED');
    expect(code(() => applyApprovalAction(S.APPROVED, 'suspend', '   '))).toBe('REASON_REQUIRED');
  });
  it('lists what is missing before go-live', () => {
    expect(missingForApproval({ activeZones: 1, hourWindows: 7, availableItems: 3, cuisines: 1 })).toEqual([]);
    expect(missingForApproval({ activeZones: 0, hourWindows: 0, availableItems: 0, cuisines: 0 })).toHaveLength(4);
  });
});

describe('image urls', () => {
  it('accepts https on allowed hosts and subdomains', () => {
    expect(() => assertImageUrls(['https://res.cloudinary.com/x/a.jpg'], ['cloudinary.com'])).not.toThrow();
    expect(() => assertImageUrls(['https://anything.example/a.jpg'], [])).not.toThrow();
  });
  it('rejects http, junk, credentials, other hosts and look-alike hosts', () => {
    expect(code(() => assertImageUrls(['http://res.cloudinary.com/a.jpg'], []))).toBe('INVALID_IMAGE_URL');
    expect(code(() => assertImageUrls(['not a url'], []))).toBe('INVALID_IMAGE_URL');
    expect(code(() => assertImageUrls(['https://user:pw@res.cloudinary.com/a.jpg'], []))).toBe('INVALID_IMAGE_URL');
    expect(code(() => assertImageUrls(['https://evil.example/a.jpg'], ['cloudinary.com']))).toBe('IMAGE_HOST_NOT_ALLOWED');
    expect(code(() => assertImageUrls(['https://evilcloudinary.com/a.jpg'], ['cloudinary.com']))).toBe('IMAGE_HOST_NOT_ALLOWED');
    expect(code(() => assertImageUrls(Array(9).fill('https://a.example/x.jpg'), []))).toBe('TOO_MANY_IMAGES');
  });
});

describe('polygon ring validation', () => {
  const square = [[90.40, 23.78], [90.42, 23.78], [90.42, 23.80], [90.40, 23.80], [90.40, 23.78]];
  it('accepts a closed ring', () => expect(validateRing(square)).toBeNull());
  it('rejects open, short, out-of-range and malformed rings', () => {
    expect(validateRing(square.slice(0, 4))).toMatch(/closed/);
    expect(validateRing(square.slice(0, 3))).toMatch(/4 to 200/);
    expect(validateRing([[200, 0], [1, 1], [2, 2], [200, 0]])).toMatch(/range/);
    expect(validateRing([[1, 1], [2, 2], ['a', 3], [1, 1]])).toMatch(/\[lng, lat\]/);
    expect(validateRing('nope')).not.toBeNull();
    expect(validateRing(Array(201).fill([1, 1]))).toMatch(/4 to 200/);
  });
});

describe('commissionMinor', () => {
  it('rounds to the nearest minor unit', () => {
    expect(commissionMinor(100000, 1500)).toBe(15000);
    expect(commissionMinor(33333, 1500)).toBe(5000); // 4999.95
    expect(commissionMinor(10, 1500)).toBe(2); // 1.5 → 2
    expect(commissionMinor(0, 1500)).toBe(0);
  });
});
