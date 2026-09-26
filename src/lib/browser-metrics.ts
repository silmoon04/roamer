import { z } from 'zod';

export const browserMetricSchema = z.object({
  type: z.enum(['interaction', 'realtime-render', 'poll-render', 'command-response']),
  tripId: z.uuid(),
  ms: z.number().finite().min(0).max(86_400_000),
  at: z.iso.datetime({ offset: true }).optional(),
  commandId: z.uuid().optional(),
  committedAt: z.iso.datetime({ offset: true }).optional(),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  renderedAt: z.iso.datetime({ offset: true }).optional(),
  visibilityState: z.enum(['visible', 'hidden']).optional(),
  renderVisibilityState: z.enum(['visible', 'hidden']).optional(),
  version: z.number().int().nonnegative().optional()
});

export function browserMetricsForTrip(value: unknown, tripId: string) {
  if (!Array.isArray(value)) return [];
  return value.slice(-500).flatMap(item => {
    const parsed = browserMetricSchema.safeParse(item);
    return parsed.success && parsed.data.tripId === tripId ? [parsed.data] : [];
  }).slice(-30);
}
