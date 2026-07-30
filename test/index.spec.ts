import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function fetchText(url: string, init?: RequestInit) {
	const response = await SELF.fetch(url, init);
	return { response, text: await response.text() };
}

async function fetchWorker(request: Request, testEnv = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function expectValidRss(xml: string) {
	expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
	expect(xml).toContain('<rss version="2.0"');
	expect(xml).toContain('<channel>');
	expect(xml).toContain('<title>Minte Blog - Building in Public</title>');
	expect(xml).toContain('<link>https://blog.minte.dev</link>');
	expect(xml).toContain('<description>Daily updates from Flo\'s development journey</description>');
	expect(xml).toContain('</channel>');
	expect(xml).toContain('</rss>');
	const parserCtor = (globalThis as typeof globalThis & { DOMParser?: new () => { parseFromString: (input: string, type: string) => any } }).DOMParser;
	if (parserCtor) {
		const parsed = new parserCtor().parseFromString(xml, 'application/xml');
		expect(parsed.querySelector('parsererror')?.textContent ?? '').toBe('');
		expect(parsed.querySelectorAll('channel > title').length).toBe(1);
	}
}

describe('Minte Blog worker', () => {
	it('renders the modern blog shell when no posts are available in the test bucket', async () => {
		const request = new IncomingRequest('http://example.com/');
		const response = await fetchWorker(request);

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
		const request = new IncomingRequest('http://example.com/photon-referral', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		});
		const response = await fetchWorker(request);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Referral saved');
		expect(text).toContain('North Star Dental');
	});

	it('lets admins mark photon referrals as submitted and confirms the status is persisted', async () => {
		const testEnv = { ...env, ADMIN_TOKEN: 'test-admin-token' } as typeof env;
		const createBody = new URLSearchParams({
			businessName: 'Sunrise Automotive',
			contactName: 'Taylor Reed',
			email: 'taylor@example.com',
			marketingConsent: 'yes',
		});
		const createRequest = new IncomingRequest('http://example.com/photon-referral', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: createBody,
		});
		const createResponse = await fetchWorker(createRequest, testEnv);
		expect(createResponse.status).toBe(200);

		const listing = await testEnv.BLOG_BUCKET.list({ prefix: 'referrals/photon/' });
		expect(listing.objects.length).toBeGreaterThan(0);
		const referralKey = listing.objects[0].key;
		const initialFile = await testEnv.BLOG_BUCKET.get(referralKey);
		expect(initialFile).not.toBeNull();
		const initialReferral = JSON.parse(await initialFile!.text()) as { status: string; id: string };
		expect(initialReferral.status).toBe('new');

		const updateRequest = new IncomingRequest(`http://example.com/admin/photon-referrals/${encodeURIComponent(initialReferral.id)}/status`, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-admin-token',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ status: 'submitted' }),
		});
		const updateResponse = await fetchWorker(updateRequest, testEnv);
		expect([200, 303]).toContain(updateResponse.status);

		const updatedFile = await testEnv.BLOG_BUCKET.get(referralKey);
		expect(updatedFile).not.toBeNull();
		const updatedReferral = JSON.parse(await updatedFile!.text()) as { status: string; statusUpdatedAt?: string };
		expect(updatedReferral.status).toBe('submitted');
		expect(updatedReferral.statusUpdatedAt).toBeTruthy();

		const adminRequest = new IncomingRequest('http://example.com/admin/photon-referrals', {
			headers: { Authorization: 'Bearer test-admin-token' },
		});
		const adminResponse = await fetchWorker(adminRequest, testEnv);
		expect(adminResponse.status).toBe(200);
		const adminHtml = await adminResponse.text();
		expect(adminHtml).toContain('submitted');
		expect(adminHtml).toContain('Action');
	});

	it('returns JSON errors from the posts API when no index is available', async () => {
		const response = await SELF.fetch('https://example.com/api/posts');
		const body = await response.json() as { error: string };

		expect(response.status).toBe(404);
		expect(body.error).toBe('No posts available');
	});

	it('generates RSS 2.0 with required channel and item fields', async () => {
		await env.BLOG_BUCKET.put('posts-index.json', JSON.stringify({
			posts: [
				{
					slug: 'rss-contract-test',
					title: 'RSS Contract Test',
					description: 'A valid RSS item for contract testing.',
					pubDate: '2026-07-30T12:00:00.000Z',
					author: 'Dev',
					tags: ['testing', 'rss'],
					draft: false,
				},
			],
			tags: { testing: 1, rss: 1 },
		}));

		const { response, text } = await fetchText('https://example.com/rss.xml');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/rss+xml');
		expectValidRss(text);
		expect(text).toContain('<item>');
		expect(text).toContain('<title>RSS Contract Test</title>');
		expect(text).toContain('<link>https://blog.minte.dev/posts/rss-contract-test</link>');
		expect(text).toContain('<description>A valid RSS item for contract testing.</description>');
		expect(text).toContain('<guid>https://blog.minte.dev/posts/rss-contract-test</guid>');
		expect(text).toContain('<category>testing</category>');
	});

	it('escapes RSS item XML and filters draft and memory posts', async () => {
		await env.BLOG_BUCKET.put('posts-index.json', JSON.stringify({
			posts: [
				{
					slug: 'safe-rss-and-fallback',
					title: 'AT&T <Workers> "RSS"',
					description: 'Fallback & observability must stay parseable.',
					pubDate: '2026-07-30T13:00:00.000Z',
					author: 'Dev',
					tags: ['rss & xml'],
					draft: false,
				},
				{
					slug: 'draft-hidden',
					title: 'Draft Hidden',
					description: 'Drafts must not appear in RSS.',
					pubDate: '2026-07-30T14:00:00.000Z',
					author: 'Dev',
					tags: ['draft'],
					draft: true,
				},
				{
					slug: 'memory-hidden',
					title: 'Memory Hidden',
					description: 'Memory posts must not appear in RSS.',
					pubDate: '2026-07-30T15:00:00.000Z',
					author: 'Dev',
					tags: ['memory'],
					draft: false,
					category: 'memory',
				},
			],
			tags: { 'rss & xml': 1, draft: 1, memory: 1 },
		}));

		const { response, text } = await fetchText('https://example.com/rss.xml');

		expect(response.status).toBe(200);
		expectValidRss(text);
		expect(text).toContain('<title>AT&amp;T &lt;Workers&gt; &quot;RSS&quot;</title>');
		expect(text).toContain('<description>Fallback &amp; observability must stay parseable.</description>');
		expect(text).toContain('<category>rss &amp; xml</category>');
		expect(text).not.toContain('Draft Hidden');
		expect(text).not.toContain('Memory Hidden');
	});

	it('returns empty but valid RSS when the index has no public posts', async () => {
		await env.BLOG_BUCKET.put('posts-index.json', JSON.stringify({ posts: [], tags: {} }));

		const { response, text } = await fetchText('https://example.com/rss.xml');

		expect(response.status).toBe(200);
		expectValidRss(text);
		expect(text).not.toContain('<item>');
	});
});
