import { describe, expect, it } from 'vitest';
import { cleanOpeningHours, displayTime, setupChecklist, setupComplete, storeStatus } from '../../src/modules/pharmacy/marketplace.js';

// Wednesday 7 Oct 2026; Lagos is UTC+1.
const lagos = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 7, h - 1, m));
const base = { status: 'active', acceptingOrders: true, timeZone: 'Africa/Lagos' };
const weekdays = { open: '08:00', close: '20:00' };
const hours = { mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays, sat: { open: '10:00', close: '16:00' }, sun: null };

describe('storeStatus', () => {
  it('is open inside hours and says until when', () => {
    expect(storeStatus({ ...base, openingHours: hours }, lagos(9))).toMatchObject({ open: true, label: 'Open · until 8:00 PM' });
  });

  it('is closed before opening and after closing, with the next opening', () => {
    expect(storeStatus({ ...base, openingHours: hours }, lagos(7, 30))).toMatchObject({ open: false, label: 'Closed · opens 8:00 AM' });
    expect(storeStatus({ ...base, openingHours: hours }, lagos(21))).toMatchObject({ open: false, label: 'Closed · opens tomorrow 8:00 AM' });
  });

  it('skips closed days when finding the next opening', () => {
    // Saturday 10 Oct, 17:00 → Sunday closed → Monday.
    const sat = new Date(Date.UTC(2026, 9, 10, 16));
    expect(storeStatus({ ...base, openingHours: hours }, sat).label).toBe('Closed · opens Mon 8:00 AM');
  });

  it('handles hours that run past midnight', () => {
    const late = { wed: { open: '20:00', close: '02:00' } };
    expect(storeStatus({ ...base, openingHours: late }, lagos(23)).open).toBe(true);
    // 01:00 Thursday is still inside Wednesday's hours.
    const thu1am = new Date(Date.UTC(2026, 9, 8, 0));
    expect(storeStatus({ ...base, openingHours: late }, thu1am)).toMatchObject({ open: true, label: 'Open · until 2:00 AM' });
  });

  it('paused, offline and no-hours stores', () => {
    expect(storeStatus({ ...base, acceptingOrders: false, openingHours: hours }, lagos(9)).state).toBe('paused');
    expect(storeStatus({ ...base, status: 'onboarding', openingHours: hours }, lagos(9)).state).toBe('offline');
    expect(storeStatus({ ...base, openingHours: null }, lagos(3)).open).toBe(true);
  });
});

describe('opening hours input', () => {
  it('formats times and rejects bad ones', () => {
    expect(displayTime('00:30')).toBe('12:30 AM');
    expect(displayTime('13:05')).toBe('1:05 PM');
    expect(() => cleanOpeningHours({ mon: { open: '09:00', close: '09:00' } })).toThrow();
    expect(() => cleanOpeningHours({ mon: { open: '25:00', close: '09:00' } })).toThrow();
    expect(cleanOpeningHours({ mon: weekdays })).toMatchObject({ mon: weekdays, sun: null });
  });
});

describe('setup checklist', () => {
  it('needs images, phone, location, hours and stock', () => {
    const empty = { image: null, coverImage: null, phoneNumber: null, address: null, latitude: null, longitude: null, openingHours: null } as never;
    expect(setupComplete(setupChecklist(empty, 0))).toBe(false);
    const ready = { image: 'a', coverImage: 'b', phoneNumber: '080', address: 'Calabar', latitude: 4.9, longitude: 8.3, openingHours: hours } as never;
    expect(setupComplete(setupChecklist(ready, 1))).toBe(true);
    expect(setupChecklist(ready, 0).find((i) => i.key === 'products')?.done).toBe(false);
  });
});
