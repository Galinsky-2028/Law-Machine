import type { PackEvent } from '../../../../../packages/simulation/src/pack-engine.ts';

export const CATEGORY_LABEL: Record<PackEvent['category'], string> = {
  external: 'Scenario', rule: 'Law', duty: 'Duty', performance: 'Action', breach: 'Breach', clock: 'Period',
  arrival: 'Arrival', exception: 'Exception', 'not-effective': 'Not in effect', unresolved: 'Unresolved'
};
export const BASIS_LABEL: Record<PackEvent['basis'], string> = { legal: 'From the law', operational: 'From an assumption', scenario: 'Scenario fact' };
export const DUTY_LABEL: Record<string, string> = { pending: 'Pending', satisfied: 'Met', breached: 'Breached', unknown: 'Unresolved', 'not-yet': 'Not yet created', none: '—' };
export const formatDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};
export const humanize = (key: string) => key.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
export type Selection =
  | { readonly kind: 'event'; readonly id: string }
  | { readonly kind: 'actor'; readonly id: string }
  | { readonly kind: 'provision'; readonly versionId: string; readonly id: string }
  | { readonly kind: 'rule'; readonly frameworkId: string; readonly id: string }
  | { readonly kind: 'checkpoint'; readonly id: string };
