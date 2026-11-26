import { isSubscriptionBillable } from './billing.js';
import type { Database, Subscription } from './types/billing.js';

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
