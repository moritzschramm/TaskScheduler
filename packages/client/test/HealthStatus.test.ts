import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '@ambitime/shared';
import HealthStatus from '@/components/HealthStatus.vue';
import * as health from '@/lib/health';

const okResponse: HealthResponse = {
  status: 'ok',
  database: {
    reachable: true,
    schemaVersion: 'm0',
    serverTime: '2026-01-02T03:04:05.678Z',
    latencyMs: 3,
  },
};

describe('HealthStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the database details when the server reports ok', async () => {
    vi.spyOn(health, 'fetchHealth').mockResolvedValue({ state: 'ok', data: okResponse });

    const wrapper = mount(HealthStatus);
    await flushPromises();

    expect(wrapper.get('[data-testid="health-badge"]').text()).toContain('Connected');

    const details = wrapper.get('[data-testid="health-details"]').text();
    expect(details).toContain('m0');
    expect(details).toContain('2026-01-02T03:04:05.678Z');
    expect(details).toContain('3 ms');
  });

  it('surfaces the diagnostic when the server cannot reach the database', async () => {
    vi.spyOn(health, 'fetchHealth').mockResolvedValue({
      state: 'error',
      message: 'connection refused',
    });

    const wrapper = mount(HealthStatus);
    await flushPromises();

    expect(wrapper.get('[data-testid="health-badge"]').text()).toContain('Unreachable');
    expect(wrapper.get('[data-testid="health-error"]').text()).toBe('connection refused');
    expect(wrapper.find('[data-testid="health-details"]').exists()).toBe(false);
  });

  it('re-checks on demand', async () => {
    const spy = vi
      .spyOn(health, 'fetchHealth')
      .mockResolvedValue({ state: 'ok', data: okResponse });

    const wrapper = mount(HealthStatus);
    await flushPromises();
    expect(spy).toHaveBeenCalledTimes(1);

    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
