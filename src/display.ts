import type { CSSProperties } from 'react';
import { isSubscriptionBillable } from './billing.js';
import type { Database, Member, Subscription } from './types/billing.js';

// Each member keeps one hue on every screen. Stepping by the golden angle keeps neighbours in a
// list at least 60 degrees apart, so two people never read as the same colour family.
export function memberHue(members: ReadonlyArray<Pick<Member, 'id' | 'name'>>, member: { id?: string; name?: string }): number {
  const index = members.findIndex((item) => (member.id && item.id === member.id) || item.name === member.name);
  return Math.round((20 + Math.max(index, 0) * 137.508) % 360);
}

export function memberToneStyle(members: ReadonlyArray<Pick<Member, 'id' | 'name'>>, member: { id?: string; name?: string }): CSSProperties {
  return { '--hue': memberHue(members, member) } as CSSProperties;
}

export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}

export type SeatState = 'billing' | 'upcoming' | 'ended' | 'stopped';

export const SEAT_STATE_LABEL: Record<SeatState, string> = {
  billing: '計費中',
  upcoming: '尚未開始',
  ended: '已退出',
  stopped: '已停用',
};

// Months are stored as zero-padded YYYY/MM, so string order is calendar order.
export function seatState(subscription: Subscription, data: Database): SeatState {
  if (isSubscriptionBillable(subscription, data, data.currentMonth)) return 'billing';
  if (subscription.startMonth > data.currentMonth) return 'upcoming';
  if (subscription.exitMonth && subscription.exitMonth < data.currentMonth) return 'ended';
  return 'stopped';
}
