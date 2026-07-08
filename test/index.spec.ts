import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function fetchText(url: string, init?: RequestInit) {
	const response = await SELF.fetch(url, init);
	return { response, text: await response.text() };
}

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

	it('shows the photon referral intake page', async () => {
		const { response, text } = await fetchText('https://example.com/photon-referral');
		expect(response.status).toBe(200);
		expect(text).toContain('Refer a business for Photon');
		expect(text).toContain('15% off first month');
		expect(text).toContain('Submit referral');
	});

	it('accepts a photon referral submission and confirms it was saved', async () => {
		const body = new URLSearchParams({
			businessName: 'North Star Dental',
			contactName: 'Jordan Smith',
			email: 'jordan@example.com',
			phone: '555-0142',
			companySize: '11-50 employees',
			notes: 'Owner is interested in a phone-first workflow.',
			marketingConsent: 'yes',
		});
		const { response, text } = await fetchText('https://example.com/photon-referral', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		});
		expect(response.status).toBe(200);
		expect(text).toContain('Referral saved');
		expect(text).toContain('North Star Dental');
	});

	it('returns JSON errors from the posts API when no index is available', async () => {
		const response = await SELF.fetch('https://example.com/api/posts');
		const body = await response.json() as { error: string };

		expect(response.status).toBe(404);
		expect(body.error).toBe('No posts available');
	});
});
