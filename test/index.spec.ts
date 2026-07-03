import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Minte Blog worker', () => {
	it('renders the modern blog shell when no posts are available in the test bucket', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const html = await response.text();
		expect(response.status).toBe(404);
		expect(html).toContain('Minte Build Log');
		expect(html).toContain('Building in Public');
		expect(html).toContain('HandyBeaver.co');
		expect(html).toContain('KiamichiBizConnect.com');
	});

	it('returns JSON errors from the posts API when no index is available', async () => {
		const response = await SELF.fetch('https://example.com/api/posts');
		const body = await response.json() as { error: string };

		expect(response.status).toBe(404);
		expect(body.error).toBe('No posts available');
	});
});
