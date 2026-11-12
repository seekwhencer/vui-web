import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  getPendingActions,
  getAction,
  approveAction,
  rejectAction,
  cancelAction,
} from './actions.js';

function mockFetch(status = 200, body = { success: true, data: {} }) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('actions API-Client', () => {
  it('getPendingActions → GET /api/actions/pending', async () => {
    const fetchMock = mockFetch(200, { success: true, data: [{ id: 'a1' }] });
    vi.stubGlobal('fetch', fetchMock);

    const data = await getPendingActions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/actions/pending');
    expect(options.method).toBeUndefined();
    expect(data).toEqual([{ id: 'a1' }]);
  });

  it('getAction → GET /api/actions/:id', async () => {
    const fetchMock = mockFetch(200, { success: true, data: { id: 'a1', status: 'PENDING_APPROVAL' } });
    vi.stubGlobal('fetch', fetchMock);

    const data = await getAction('a1');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/actions/a1');
    expect(data).toMatchObject({ id: 'a1', status: 'PENDING_APPROVAL' });
  });

  it('approveAction → POST /api/actions/:id/approve', async () => {
    const fetchMock = mockFetch(200, { success: true, data: { id: 'a1', status: 'APPROVED' } });
    vi.stubGlobal('fetch', fetchMock);

    const data = await approveAction('a1');

    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/actions/a1/approve');
    expect(options.method).toBe('POST');
    expect(data.status).toBe('APPROVED');
  });

  it('rejectAction mit reason → Body { reason }', async () => {
    const fetchMock = mockFetch(200, { success: true, data: { id: 'a1', status: 'REJECTED' } });
    vi.stubGlobal('fetch', fetchMock);

    await rejectAction('a1', 'zu riskant');

    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/actions/a1/reject');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ reason: 'zu riskant' });
  });

  it('rejectAction ohne reason → leerer Body', async () => {
    const fetchMock = mockFetch(200, { success: true, data: { id: 'a1', status: 'REJECTED' } });
    vi.stubGlobal('fetch', fetchMock);

    await rejectAction('a1');

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({});
  });

  it('cancelAction → POST /api/actions/:id/cancel', async () => {
    const fetchMock = mockFetch(200, { success: true, data: { id: 'a1', status: 'CANCELLED' } });
    vi.stubGlobal('fetch', fetchMock);

    await cancelAction('a1');

    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/actions/a1/cancel');
    expect(options.method).toBe('POST');
  });

  it('Fehlerantwort → Error mit Server-Meldung + Status', async () => {
    const fetchMock = mockFetch(410, { success: false, error: 'APPROVAL_EXPIRED' });
    vi.stubGlobal('fetch', fetchMock);

    const promise = approveAction('a1');
    await expect(promise).rejects.toThrow('APPROVAL_EXPIRED');
    await expect(approveAction('a1')).rejects.toMatchObject({ status: 410 });
  });

  it('Netzwerkfehler → NetworkError (status 0)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPendingActions()).rejects.toMatchObject({ name: 'NetworkError', status: 0 });
  });
});
