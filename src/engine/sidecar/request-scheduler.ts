/**
 * The scheduler now lives in `core`, because it paces HTTP providers as well as
 * the sidecar. This re-export keeps the engine's own imports and the smoke tests
 * working unchanged.
 */
export { RequestScheduler } from '@core/scheduling/request-scheduler'
export type { RequestSchedulerOptions, ScheduleOptions } from '@core/scheduling/request-scheduler'
