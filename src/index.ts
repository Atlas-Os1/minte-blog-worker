import * as Sentry from "@sentry/cloudflare";
import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { marked } from 'marked';
import { cors } from 'hono/cors';
import { generateBlogPost, generateDetailedBlogDraft, generateMemoryDigestPost, publishPost, saveBlogDraft } from './manual-blog-gen';

type Bindings = {
	BLOG_BUCKET: R2Bucket;
	BLOG_WORKFLOW: Workflow;
	AI: Ai;
	CF_ZONE_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	GITHUB_TOKEN: string;
	ADMIN_TOKEN?: string; // Bearer token for admin endpoints
	DISCORD_WEBHOOK_URL?: string; // Optional Discord webhook for referral notifications
	MEMORY_PASSWORD?: string; // Optional gate for legacy/private memory archive
};


function getCookie(cookieHeader: string | undefined, name: string): string | undefined {
	if (!cookieHeader) return undefined;
	const prefix = `${name}=`;
	return cookieHeader
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith(prefix))
		?.slice(prefix.length);
}

function hasMemoryAccess(c: { req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined } }, memoryPassword: string | undefined): boolean {
	if (!memoryPassword) return false;
	const submittedPassword = c.req.query('password') || c.req.header('X-Memory-Password');
	const cookiePassword = getCookie(c.req.header('Cookie'), 'memory_access');
	return submittedPassword === memoryPassword || cookiePassword === encodeURIComponent(memoryPassword);
}

// Rate limiting helper using Cache API
async function checkRateLimit(
	ip: string,
	endpoint: string,
	maxRequests: number = 5,
	windowSeconds: number = 60
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
	const cache = caches.default;
	const key = new Request(`https://ratelimit/${endpoint}/${ip}`);
	
	const now = Math.floor(Date.now() / 1000);
	const windowStart = now - (now % windowSeconds);
	const resetAt = windowStart + windowSeconds;
	
	const cached = await cache.match(key);
	let count = 0;
	
	if (cached) {
		const data = await cached.json() as { count: number; window: number };
		if (data.window === windowStart) {
			count = data.count;
		}
	}
	
	count++;
	const allowed = count <= maxRequests;
	
	// Store updated count
	await cache.put(key, new Response(JSON.stringify({ count, window: windowStart }), {
		headers: { 'Cache-Control': `max-age=${windowSeconds}` }
	}));
	
	return { allowed, remaining: Math.max(0, maxRequests - count), resetAt };
}

// Scheduled handler type
type ExportedHandlerScheduledHandler<Env = unknown> = (
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext
) => void | Promise<void>;

type BlogPost = {
	slug: string;
	title: string;
	description: string;
	pubDate: string;
	author: string;
	tags: string[];
	content: string;
	draft: boolean;
	category?: string;
	type?: 'daily-update' | 'blog-draft' | 'memory';
	heroImage?: string;
	assets?: string[];
};

type PostIndex = {
	posts: Array<Omit<BlogPost, 'content'>>;
	tags: Record<string, number>;
};


type ProjectLink = {
	slug: string;
	name: string;
	description: string;
	site?: string;
	repo: string;
	accent: string;
	tags: string[];
};

type ToolLink = {
	slug: string;
	name: string;
	description: string;
	url: string;
	logo: string;
	logoUrl?: string;
	accent: string;
	status?: string;
	secondaryLabel?: string;
	secondaryUrl?: string;
};

type PhotonReferral = {
	id: string;
	createdAt: string;
	status: 'new' | 'reviewed' | 'submitted' | 'confirmed' | 'rejected';
	statusUpdatedAt?: string;
	businessName: string;
	contactName: string;
	email: string;
	phone?: string;
	companySize?: string;
	notes?: string;
	marketingConsent: boolean;
	source: 'photon-referral-form';
};

const PHOTON_REFERRAL_STATUSES: PhotonReferral['status'][] = ['new', 'reviewed', 'submitted', 'confirmed', 'rejected'];
const PHOTON_REFERRAL_PREFIX = 'referrals/photon/';
const PHOTON_ADMIN_COOKIE = 'photon_admin';

function isPhotonReferralStatus(value: string): value is PhotonReferral['status'] {
	return PHOTON_REFERRAL_STATUSES.includes(value as PhotonReferral['status']);
}

function getPhotonAdminToken(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | undefined {
	const authHeader = c.req.header('Authorization') || '';
	const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
	const cookieToken = getCookie(c.req.header('Cookie'), PHOTON_ADMIN_COOKIE);
	return bearerToken || c.req.query('token') || (cookieToken ? decodeURIComponent(cookieToken) : undefined);
}

function isPhotonAdminAuthorized(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }, env: { ADMIN_TOKEN?: string }): boolean {
	return Boolean(env.ADMIN_TOKEN && getPhotonAdminToken(c) === env.ADMIN_TOKEN);
}

function buildPhotonAdminCookie(token: string, secure: boolean): string {
	return `${PHOTON_ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`;
}

const MINTE_FAVICON_URL = 'https://pub-0be86ba29d2f4e66b59fe97deb2ea9d3.r2.dev/assets/favicon.png';

const PROJECTS: ProjectLink[] = [
	{
		slug: 'handy-beaver',
		name: 'Handy Beaver',
		description: 'Field-service platform for handyman operations, invoices, leads, and AI-assisted workflows.',
		site: 'https://handybeaver.co/',
		repo: 'https://github.com/Atlas-Os1/handy-beaver',
		accent: '#ff8a3d',
		tags: ['handy-beaver', 'handybeaver', 'lil-beaver', 'invoice', 'payments'],
	},
	{
		slug: 'kiamichi-biz-connect',
		name: 'Kiamichi Biz Connect',
		description: 'Local business directory, enrichment, content automation, and Cloudflare-native publishing.',
		site: 'https://kiamichibizconnect.com/',
		repo: 'https://github.com/mintedmaterial/kiamichi-Biz-Connect',
		accent: '#33d6a6',
		tags: ['kiamichi-biz-connect', 'kiamichi', 'kbc', 'local-business'],
	},
	{
		slug: 'minte-blog-worker',
		name: 'Minte Blog Worker',
		description: 'The edge-published build log powered by Cloudflare Workers, R2, Workflows, and automation.',
		site: 'https://blog.minte.dev/',
		repo: 'https://github.com/Atlas-Os1/minte-blog-worker',
		accent: '#8b5cf6',
		tags: ['blog', 'minte-blog-worker', 'publishing', 'building-in-public'],
	},
	{
		slug: 'openclaw-memory',
		name: 'OpenClaw Memory',
		description: 'Shared agent memory layer using Cloudflare Vectorize, R2, Workers AI, and retrieval APIs.',
		repo: 'https://github.com/Atlas-Os1/openclaw-memory-vectorize',
		accent: '#38bdf8',
		tags: ['openclaw', 'memory', 'vectorize', 'r2'],
	},
	{
		slug: 'openmontage',
		name: 'OpenMontage',
		description: 'Creative/media project lane for visual systems and public build experiments.',
		repo: 'https://github.com/Atlas-Os1/OpenMontage',
		accent: '#f472b6',
		tags: ['openmontage', 'creative', 'media'],
	},
	{
		slug: 'flo-social-worker',
		name: 'Flo Social Worker',
		description: 'Social publishing automation and queueing for project updates and business content.',
		repo: 'https://github.com/Atlas-Os1/flo-social-worker',
		accent: '#facc15',
		tags: ['flo-social-worker', 'social', 'facebook', 'automation'],
	},
];

const TOOL_LINKS: ToolLink[] = [
	{
		slug: 'photon-codes',
		name: 'Photon Codes',
		description: 'Code workflow slot reserved while the referral intake is handled on our side.',
		url: 'https://photon.codes/',
		logo: 'PC',
		logoUrl: 'https://app.photon.codes/icon0.svg?icon0.38661a6d.svg',
		accent: '#f97316',
		status: 'Referral intake live',
		secondaryLabel: 'Referral form',
		secondaryUrl: '/photon-referral',
	},
	{
		slug: 'cloudflare',
		name: 'Cloudflare',
		description: 'Workers, R2, Workflows, DNS, caching, and the edge runtime behind this blog.',
		url: 'https://www.cloudflare.com/',
		logo: 'CF',
		logoUrl: 'https://www.cloudflare.com/favicon.ico',
		accent: '#f6821f',
	},
	{
		slug: 'cloudflare-developers',
		name: 'Cloudflare Developers',
		description: 'The developer platform docs and products used for Workers-native builds.',
		url: 'https://developers.cloudflare.com/',
		logo: 'DEV',
		logoUrl: 'https://developers.cloudflare.com/favicon.ico',
		accent: '#facc15',
	},
	{
		slug: 'hermes',
		name: 'Hermes Agent',
		description: 'The agent runtime coordinating coding, memory, publishing, and operations workflows.',
		url: 'https://hermes-agent.nousresearch.com/',
		logo: 'H',
		logoUrl: 'https://hermes-agent.nousresearch.com/favicon.ico',
		accent: '#8b5cf6',
	},
	{
		slug: 'github',
		name: 'GitHub',
		description: 'Source control, issues, Actions, and the public repos that make the work inspectable.',
		url: 'https://github.com/Atlas-Os1',
		logo: 'GH',
		logoUrl: 'https://github.githubassets.com/favicons/favicon.svg',
		accent: '#24292f',
	},
	{
		slug: 'openmontage',
		name: 'OpenMontage',
		description: 'Open creative/media tooling and experiments from the Atlas-OS workspace.',
		url: 'https://github.com/Atlas-Os1/OpenMontage',
		logo: 'OM',
		logoUrl: 'https://github.githubassets.com/favicons/favicon.svg',
		accent: '#f472b6',
	},
	{
		slug: 'opencode',
		name: 'OpenCode',
		description: 'Terminal-native coding agent workflow used for implementation and review loops.',
		url: 'https://github.com/anomalyco/opencode',
		logo: 'OC',
		logoUrl: 'https://github.githubassets.com/favicons/favicon.svg',
		accent: '#22c55e',
	},
	{
		slug: 'anthropic',
		name: 'Anthropic',
		description: 'Claude models for long-context reasoning, coding assistance, and review support.',
		url: 'https://www.anthropic.com/',
		logo: 'A',
		logoUrl: 'https://www.anthropic.com/favicon.ico',
		accent: '#d97757',
	},
	{
		slug: 'openai',
		name: 'OpenAI',
		description: 'Models and APIs used across agent, coding, and automation experiments.',
		url: 'https://openai.com/',
		logo: 'AI',
		logoUrl: 'https://openai.com/favicon.ico',
		accent: '#10a37f',
	},
];

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function slugify(value: string): string {
	return normalize(value || 'referral').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'referral';
}

function readFormValue(formData: FormData, name: string): string {
	const value = formData.get(name);
	return typeof value === 'string' ? value.trim() : '';
}

function buildPhotonReferralId(businessName: string): string {
	return `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(businessName)}`;
}

function buildPhotonReferralSummary(referral: PhotonReferral, extraLines: string[] = []): string {
	const notes = referral.notes ? referral.notes.slice(0, 800) : 'No notes provided.';
	return [
		`Business: ${referral.businessName}`,
		`Contact: ${referral.contactName} <${referral.email}>`,
		referral.phone ? `Phone: ${referral.phone}` : null,
		referral.companySize ? `Company size: ${referral.companySize}` : null,
		`Status: ${referral.status}`,
		referral.statusUpdatedAt ? `Status updated: ${new Date(referral.statusUpdatedAt).toLocaleString()}` : null,
		`Consent: ${referral.marketingConsent ? 'yes' : 'no'}`,
		`Notes: ${notes}`,
		...extraLines,
	].filter(Boolean).join('\n');
}

async function sendPhotonReferralDiscordNotification(env: Bindings, payload: Record<string, unknown>): Promise<void> {
	if (!env.DISCORD_WEBHOOK_URL) return;
	try {
		const response = await fetch(env.DISCORD_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			console.warn('[Photon Referral] Discord notification failed:', response.status);
		}
	} catch (error) {
		console.warn('[Photon Referral] Discord notification error:', error instanceof Error ? error.message : String(error));
	}
}

async function notifyPhotonReferral(referral: PhotonReferral, env: Bindings): Promise<void> {
	const summary = buildPhotonReferralSummary(referral, ['Admin queue: https://blog.minte.dev/admin/photon-referrals']);
	await sendPhotonReferralDiscordNotification(env, {
		content: `📣 **Photon referral received:** ${referral.businessName}`,
		allowed_mentions: { parse: [] },
		embeds: [{
			title: 'Photon referral submitted',
			description: summary,
			color: 0xf97316,
			fields: [
				{ name: 'Business', value: referral.businessName.slice(0, 1024), inline: true },
				{ name: 'Contact', value: referral.contactName.slice(0, 1024), inline: true },
				{ name: 'Email', value: referral.email.slice(0, 1024), inline: true },
			],
			timestamp: referral.createdAt,
			footer: { text: 'Minte Blog · Photon intake' },
		}],
	});
}

async function notifyPhotonReferralStatusChange(referral: PhotonReferral, env: Bindings, previousStatus: PhotonReferral['status']): Promise<void> {
	const headline = `Photon referral marked ${referral.status}`;
	const summary = buildPhotonReferralSummary(referral, [
		`Previous status: ${previousStatus}`,
		`Admin queue: https://blog.minte.dev/admin/photon-referrals`,
	]);
	await sendPhotonReferralDiscordNotification(env, {
		content: `🔁 **Photon referral status updated:** ${referral.businessName} → ${referral.status}`,
		allowed_mentions: { parse: [] },
		embeds: [{
			title: headline,
			description: summary,
			color: referral.status === 'confirmed' ? 0x22c55e : referral.status === 'rejected' ? 0xef4444 : referral.status === 'submitted' ? 0x3b82f6 : referral.status === 'reviewed' ? 0xa855f7 : 0xf97316,
			fields: [
				{ name: 'Business', value: referral.businessName.slice(0, 1024), inline: true },
				{ name: 'Contact', value: referral.contactName.slice(0, 1024), inline: true },
				{ name: 'Email', value: referral.email.slice(0, 1024), inline: true },
				{ name: 'Status', value: referral.status, inline: true },
			],
			timestamp: referral.statusUpdatedAt || referral.createdAt,
			footer: { text: 'Minte Blog · Photon admin' },
		}],
	});
}

function renderPhotonReferralForm(values: Partial<PhotonReferral> = {}, error?: string): string {
	return `
		<section class="hero">
			<div class="hero-grid">
				<div>
					<p class="eyebrow">Photon referral intake</p>
					<h1>Refer a business for Photon’s 15% offer.</h1>
					<p class="lede">Photon’s referral flow is submitted, then confirmed by their team. We collect the lead here, review it, and then submit it to Photon for you.</p>
					<div class="hero-actions">
						<a class="btn primary" href="#photon-referral-form">Submit referral</a>
						<a class="btn" href="https://refer.photon.codes/" target="_blank" rel="noopener">Photon referral terms</a>
					</div>
				</div>
				<div class="hero-panel">
					<div class="metric"><span>Business gets</span><strong>15% off first month</strong></div>
					<div class="metric"><span>You earn</span><strong>15% for 12 months</strong></div>
					<div class="metric"><span>Photon asks for</span><strong>company name + who to talk to</strong></div>
					<div class="metric"><span>Status</span><strong>Reviewed before submission</strong></div>
				</div>
			</div>
		</section>
		<section class="section" id="photon-referral-form">
			<div class="section-heading">
				<div>
					<p class="eyebrow">Intake form</p>
					<h2>Send us the business details</h2>
				</div>
				<p>We’ll review the lead and submit it to Photon manually, so the intro stays accurate and consented.</p>
			</div>
			${error ? `<div class="form-alert error">${escapeHtml(error)}</div>` : ''}
			<form class="referral-form" method="post" action="/photon-referral">
				<label>
					<span>Business name *</span>
					<input name="businessName" required value="${escapeHtml(values.businessName || '')}" placeholder="Company or shop name">
				</label>
				<label>
					<span>Contact person *</span>
					<input name="contactName" required value="${escapeHtml(values.contactName || '')}" placeholder="Who we should talk to">
				</label>
				<label>
					<span>Email *</span>
					<input name="email" type="email" required value="${escapeHtml(values.email || '')}" placeholder="name@company.com">
				</label>
				<label>
					<span>Phone</span>
					<input name="phone" type="tel" value="${escapeHtml(values.phone || '')}" placeholder="Optional">
				</label>
				<label>
					<span>Business size</span>
					<select name="companySize">
						${['1-10 employees', '11-50 employees', '51-200 employees', '200+ employees', 'Not sure'].map((option) => `<option value="${escapeHtml(option)}" ${values.companySize === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
					</select>
				</label>
				<label class="field-full">
					<span>Notes / context</span>
					<textarea name="notes" rows="6" placeholder="Why this business is a fit, the right contact, timing, etc.">${escapeHtml(values.notes || '')}</textarea>
				</label>
				<label class="field-full consent-row">
					<input type="checkbox" name="marketingConsent" value="yes" ${values.marketingConsent ? 'checked' : ''} required>
					<span>I confirm the business wants us to submit this referral to Photon and follow up about the offer.</span>
				</label>
				<div class="form-actions field-full">
					<button class="btn primary" type="submit">Save referral</button>
					<a class="btn" href="/">Back to blog</a>
				</div>
			</form>
		</section>
	`;
}

function renderPhotonReferralSuccess(referral: PhotonReferral): string {
	return `
		<section class="hero">
			<div class="hero-grid">
				<div>
					<p class="eyebrow">Referral saved</p>
					<h1>We’ve got it.</h1>
					<p class="lede">We’ll review ${escapeHtml(referral.businessName)} and submit the referral to Photon using the contact details you provided.</p>
					<div class="hero-actions">
						<a class="btn primary" href="/photon-referral">Submit another</a>
						<a class="btn" href="/">Back to blog</a>
					</div>
				</div>
				<div class="hero-panel">
					<div class="metric"><span>Business</span><strong>${escapeHtml(referral.businessName)}</strong></div>
					<div class="metric"><span>Contact</span><strong>${escapeHtml(referral.contactName)}</strong></div>
					<div class="metric"><span>Email</span><strong>${escapeHtml(referral.email)}</strong></div>
					<div class="metric"><span>Status</span><strong>Queued for review</strong></div>
				</div>
			</div>
		</section>
	`;
}

function renderPhotonReferralAdmin(referrals: PhotonReferral[]): string {
	const rows = referrals.map((referral) => `
		<tr>
			<td>${escapeHtml(new Date(referral.createdAt).toLocaleString())}</td>
			<td>
				<strong>${escapeHtml(referral.businessName)}</strong>
				<div style="color: var(--text-secondary); font-size: .88rem;">${escapeHtml(referral.companySize || 'Not provided')}</div>
			</td>
			<td>
				${escapeHtml(referral.contactName)}
				<div style="color: var(--text-secondary); font-size: .88rem;">${escapeHtml(referral.email)}</div>
			</td>
			<td>${escapeHtml(referral.phone || '—')}</td>
			<td>${escapeHtml(referral.notes || '—')}</td>
			<td>
				<div class="admin-status-stack">
					<span class="tag">${escapeHtml(referral.status)}</span>
					${referral.statusUpdatedAt ? `<small>Updated ${escapeHtml(new Date(referral.statusUpdatedAt).toLocaleString())}</small>` : ''}
				</div>
			</td>
			<td>
				<form class="admin-status-form" method="post" action="/admin/photon-referrals/${encodeURIComponent(referral.id)}/status">
					<select name="status" aria-label="Update status for ${escapeHtml(referral.businessName)}">
						${PHOTON_REFERRAL_STATUSES.map((status) => `<option value="${status}" ${referral.status === status ? 'selected' : ''}>${status}</option>`).join('')}
					</select>
					<button class="btn" type="submit">Save</button>
				</form>
			</td>
		</tr>
	`).join('');
	return `
		<section class="section">
			<div class="section-heading">
				<div>
					<p class="eyebrow">Admin review</p>
					<h1>Photon referrals</h1>
				</div>
				<p>${referrals.length} referral(s) in queue.</p>
			</div>
			<div style="overflow-x:auto;">
				<table class="referral-table">
					<thead>
						<tr>
							<th>Created</th><th>Business</th><th>Contact</th><th>Phone</th><th>Notes</th><th>Status</th><th>Action</th>
						</tr>
					</thead>
					<tbody>${rows || '<tr><td colspan="7">No referrals yet.</td></tr>'}</tbody>
				</table>
			</div>
		</section>
	`;
}

async function loadPhotonReferrals(bucket: R2Bucket, limit = 25): Promise<PhotonReferral[]> {
	const listed = await bucket.list({ prefix: PHOTON_REFERRAL_PREFIX, limit });
	const referrals = await Promise.all(listed.objects.map(async (object) => {
		try {
			const file = await bucket.get(object.key);
			if (!file) return null;
			return JSON.parse(await file.text()) as PhotonReferral;
		} catch {
			return null;
		}
	}));
	return referrals.filter((referral): referral is PhotonReferral => Boolean(referral))
		.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function photonReferralKey(id: string): string {
	return `${PHOTON_REFERRAL_PREFIX}${id}.json`;
}

async function loadPhotonReferral(bucket: R2Bucket, id: string): Promise<PhotonReferral | null> {
	const file = await bucket.get(photonReferralKey(id));
	if (!file) return null;
	try {
		return JSON.parse(await file.text()) as PhotonReferral;
	} catch {
		return null;
	}
}

async function savePhotonReferral(bucket: R2Bucket, referral: PhotonReferral): Promise<void> {
	await bucket.put(photonReferralKey(referral.id), JSON.stringify(referral, null, 2), {
		httpMetadata: { contentType: 'application/json' },
	});
}

async function updatePhotonReferralStatus(bucket: R2Bucket, id: string, status: PhotonReferral['status']): Promise<{ referral: PhotonReferral | null; previousStatus?: PhotonReferral['status'] }> {
	const referral = await loadPhotonReferral(bucket, id);
	if (!referral) return { referral: null };
	const previousStatus = referral.status;
	referral.status = status;
	referral.statusUpdatedAt = new Date().toISOString();
	await savePhotonReferral(bucket, referral);
	return { referral, previousStatus };
}

function inferProject(post: Omit<BlogPost, 'content'> | BlogPost): ProjectLink {
	const explicitProject = typeof (post as any).project === 'string' ? normalize((post as any).project) : '';
	if (explicitProject) {
		const explicitMatch = PROJECTS.find((project) => project.slug === explicitProject || project.tags.includes(explicitProject));
		if (explicitMatch) return explicitMatch;
	}

	const haystack = [post.title, post.description, ...post.tags, post.author].join(' ').toLowerCase();
	return PROJECTS.find((project) => project.tags.some((tag) => haystack.includes(tag))) || PROJECTS[2];
}

function estimateReadingTime(content?: string, fallback?: unknown): string {
	if (typeof fallback === 'string' && fallback.trim()) return fallback;
	if (!content) return '3 min read';
	const words = content.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
	return `${Math.max(1, Math.ceil(words / 220))} min read`;
}

function stripLeadingH1(content: string, title: string): string {
	return content.replace(/^#\s+.+?(?:\r?\n){1,2}/, '').replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\r?\\n){1,2}`, 'i'), '');
}

function buildTableOfContents(markdown: string): string {
	const headings = Array.from(markdown.matchAll(/^(##|###)\s+(.+)$/gm)).slice(0, 12);
	if (headings.length < 3) return '';
	return `
		<aside class="toc-card" aria-label="Table of contents">
			<p class="eyebrow">On this page</p>
			${headings.map((match) => {
				const depth = match[1].length;
				const label = match[2].replace(/[#*_`]/g, '').trim();
				const id = normalize(label);
				return `<a class="toc-link depth-${depth}" href="#${id}">${escapeHtml(label)}</a>`;
			}).join('')}
		</aside>`;
}

function addHeadingIds(html: string): string {
	return html.replace(/<h([23])>(.*?)<\/h\1>/g, (_match, level: string, text: string) => {
		const label = text.replace(/<[^>]+>/g, '').trim();
		return `<h${level} id="${normalize(label)}">${text}</h${level}>`;
	});
}

function enhanceRenderedMedia(html: string): string {
	return html.replace(/<p>\s*(<img\s+[^>]*src="([^"]+)"[^>]*>)\s*<\/p>/g, (_match, imageTag: string, src: string) => {
		const labelMatch = imageTag.match(/alt="([^"]*)"/);
		const label = labelMatch?.[1] ? escapeHtml(labelMatch[1]) : 'Post attachment';
		const isWideDiagram = /\.svg(?:$|[?#])/i.test(src) || src.includes('/assets/posts/');
		if (!isWideDiagram) {
			return `<figure class="media-frame">${imageTag}<figcaption>${label}</figcaption></figure>`;
		}
		return `<figure class="media-frame wide-media-frame"><div class="media-scroll" tabindex="0" aria-label="Scrollable media: ${label}">${imageTag}</div><figcaption>${label} · swipe sideways or <a href="${src}" target="_blank" rel="noopener">open full size</a></figcaption></figure>`;
	});
}

function renderTags(tags: string[]): string {
	return tags.map((tag) => `<a href="/tags/${encodeURIComponent(tag)}" class="tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`).join('');
}


function assetContentType(path: string): string {
	const cleanPath = path.split('?')[0].toLowerCase();
	const ext = cleanPath.slice(cleanPath.lastIndexOf('.'));
	const map: Record<string, string> = {
		'.avif': 'image/avif',
		'.css': 'text/css; charset=utf-8',
		'.gif': 'image/gif',
		'.htm': 'text/html; charset=utf-8',
		'.html': 'text/html; charset=utf-8',
		'.jpeg': 'image/jpeg',
		'.jpg': 'image/jpeg',
		'.js': 'text/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.mp4': 'video/mp4',
		'.png': 'image/png',
		'.svg': 'image/svg+xml; charset=utf-8',
		'.txt': 'text/plain; charset=utf-8',
		'.webm': 'video/webm',
		'.webp': 'image/webp',
	};
	return map[ext] || 'application/octet-stream';
}

function assetKind(path: string): 'image' | 'video' | 'embed' | 'file' {
	const type = assetContentType(path);
	if (type.startsWith('image/')) return 'image';
	if (type.startsWith('video/')) return 'video';
	if (type.startsWith('text/html')) return 'embed';
	return 'file';
}

function normalizeAssetRef(ref: string, slug: string): string | null {
	const cleaned = ref.trim().replace(/[),.;]+$/, '');
	if (cleaned.startsWith('/assets/posts/')) return cleaned;
	try {
		const url = new URL(cleaned);
		if (url.hostname === 'blog.minte.dev' && url.pathname.startsWith('/assets/posts/')) return url.pathname;
	} catch {
		// Not an absolute URL.
	}
	if (/^[\w./ -]+\.(svg|png|jpe?g|gif|webp|avif|mp4|webm|html?)$/i.test(cleaned) && !cleaned.includes('..')) {
		return `/assets/posts/${slug}/${cleaned.replace(/^\.\//, '')}`;
	}
	return null;
}

function collectAssetRefs(post: BlogPost): string[] {
	const refs = new Set<string>();
	if (post.heroImage) {
		const ref = normalizeAssetRef(post.heroImage, post.slug);
		if (ref) refs.add(ref);
	}
	for (const asset of post.assets || []) {
		const ref = normalizeAssetRef(asset, post.slug);
		if (ref) refs.add(ref);
	}
	const content = post.content || '';
	const patterns = [
		/(?:src|href)=["']([^"']+)["']/g,
		/\((\/assets\/posts\/[^\s\)"']+)\)/g,
		/(https:\/\/blog\.minte\.dev\/assets\/posts\/[^\s`"'<>]+)/g,
	];
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) {
			const ref = normalizeAssetRef(match[1], post.slug);
			if (ref) refs.add(ref);
		}
	}
	return Array.from(refs).filter((ref) => ref.startsWith(`/assets/posts/${post.slug}/`));
}

function renderAssetGallery(post: BlogPost): string {
	const refs = collectAssetRefs(post);
	if (refs.length === 0) return '';
	return `
		<section class="asset-gallery" aria-label="Post asset bundle">
			<div class="section-heading compact">
				<div>
					<p class="eyebrow">Attachment bundle</p>
					<h2>Files attached to this build note</h2>
				</div>
				<p>Compact links to the R2 bundle. Inline diagrams stay scrollable above instead of being duplicated as oversized cards.</p>
			</div>
			<div class="asset-link-grid">
				${refs.map((ref) => {
					const kind = assetKind(ref);
					const label = decodeURIComponent(ref.split('/').pop() || ref);
					const icon = kind === 'video' ? '▶' : kind === 'image' ? '▧' : kind === 'embed' ? '⌁' : '↗';
					return `<a class="asset-link-card" href="${ref}" target="_blank" rel="noopener"><span class="asset-icon">${icon}</span><span><strong>${escapeHtml(label)}</strong><small>${kind} attachment</small></span></a>`;
				}).join('')}
			</div>
		</section>`;
}

function renderProjectCard(project: ProjectLink, compact = false): string {
	return `
		<article class="project-card reveal-card${compact ? ' compact' : ''}" data-reveal-card style="--project-accent: ${project.accent}">
			<div class="card-ambient" aria-hidden="true"></div>
			<div>
				<p class="eyebrow">Project</p>
				<h3>${project.name}</h3>
				<p>${project.description}</p>
			</div>
			<div class="card-preview" aria-hidden="true">
				<span></span><span></span><span></span>
			</div>
			<div class="project-actions">
				${project.site ? `<a href="${project.site}" target="_blank" rel="noopener">Site</a>` : ''}
				<a href="${project.repo}" target="_blank" rel="noopener">GitHub</a>
			</div>
		</article>`;
}


function renderToolCard(tool: ToolLink): string {
	return `
		<article class="tool-card reveal-card" data-reveal-card style="--tool-accent: ${tool.accent}; --project-accent: ${tool.accent}">
			<div class="card-ambient" aria-hidden="true"></div>
			<div class="tool-logo" aria-hidden="true">${tool.logoUrl ? `<img src="${tool.logoUrl}" alt="" loading="lazy" onerror="this.remove(); this.parentElement.textContent='${escapeHtml(tool.logo)}';">` : escapeHtml(tool.logo)}</div>
			<div>
				<div class="tool-title-row">
					<h3>${escapeHtml(tool.name)}</h3>
					<span>↗</span>
				</div>
				<p>${escapeHtml(tool.description)}</p>
				<div class="tool-actions-row">
					${tool.status ? `<span class="tool-status">${escapeHtml(tool.status)}</span>` : ''}
					<div class="tool-action-links">
						<a href="${tool.url}" target="_blank" rel="noopener">Open</a>
						${tool.secondaryUrl ? `<a href="${tool.secondaryUrl}" ${tool.secondaryUrl.startsWith('/') ? '' : 'target="_blank" rel="noopener"'}>${escapeHtml(tool.secondaryLabel || 'Open referral form')}</a>` : ''}
					</div>
				</div>
			</div>
		</article>`;
}

function renderPostCard(post: Omit<BlogPost, 'content'>): string {
	const project = inferProject(post);
	const readingTime = estimateReadingTime(undefined, (post as any).readingTime);
	const searchable = escapeHtml([post.title, post.description, post.author, ...post.tags, project.name].join(' ').toLowerCase());
	const titleWords = post.title.split(/\s+/).slice(0, 4);
	return `
		<article class="post-card reveal-card" data-reveal-card data-search="${searchable}" data-project="${project.slug}" style="--project-accent: ${project.accent}" onclick="if (!event.target.closest('a')) location.href='/posts/${post.slug}'">
			<div class="card-ambient" aria-hidden="true"></div>
			<div class="post-card-topline">
				<a class="project-pill" href="${project.site || project.repo}" target="_blank" rel="noopener">${project.name}</a>
				<span>${new Date(post.pubDate).toLocaleDateString()} · ${escapeHtml(readingTime)}</span>
			</div>
			<h2 class="post-title"><a href="/posts/${post.slug}">${escapeHtml(post.title)}</a></h2>
			<p>${escapeHtml(post.description)}</p>
			<div class="card-preview" aria-hidden="true">
				${titleWords.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}
			</div>
			<div class="post-card-popout">
				<strong>Open the build note</strong>
				<span>Project: ${project.name} · ${escapeHtml(post.tags.slice(0, 3).join(' / ') || 'building in public')}</span>
			</div>
			<div class="post-card-footer">
				<div class="tag-row">${renderTags(post.tags.slice(0, 6))}</div>
				<a class="read-more" href="/posts/${post.slug}" aria-label="Read ${escapeHtml(post.title)}">Read build note →</a>
			</div>
		</article>`;
}

const app = new Hono<{ Bindings: Bindings }>();

// CORS for API endpoints
app.use('/api/*', cors());

// Helper: Fetch from R2 with cache (v2 - cache busted)
async function fetchFromR2(
	bucket: R2Bucket,
	key: string,
	cache: Cache,
	ttl = 300 // 5 minutes (was 60, increased for reasonable freshness)
): Promise<string | null> {
	const cacheKey = new Request(`https://cache/v2/${key}`);

	// Check cache first
	const cachedResponse = await cache.match(cacheKey);
	if (cachedResponse) {
		return await cachedResponse.text();
	}

	// Fetch from R2
	const object = await bucket.get(key);
	if (!object) {
		return null;
	}

	const content = await object.text();

	// Store in cache
	const response = new Response(content, {
		headers: {
			'Cache-Control': `public, max-age=${ttl}`,
			'Content-Type': 'application/json',
		},
	});
	await cache.put(cacheKey, response);

	return content;
}

// Helper: Render HTML page
function renderPage(title: string, content: string, metaTags = ''): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title} - Minte Blog</title>
	<link rel="icon" href="${MINTE_FAVICON_URL}">
	<link rel="shortcut icon" href="${MINTE_FAVICON_URL}">
	<link rel="apple-touch-icon" href="${MINTE_FAVICON_URL}">
	${metaTags}
	<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
	<style>
		:root {
			--bg-primary: oklch(0.985 0.012 83);
			--bg-secondary: rgba(255, 255, 255, 0.86);
			--surface: rgba(255, 255, 255, 0.72);
			--surface-strong: #ffffff;
			--text-primary: oklch(0.18 0.024 260);
			--text-secondary: oklch(0.44 0.035 260);
			--muted: oklch(0.93 0.018 250);
			--accent: #FF6B35;
			--accent-2: #16c7a8;
			--border: rgba(20, 28, 45, 0.12);
			--code-bg: #101827;
			--tag-bg: rgba(22, 199, 168, 0.12);
			--tag-text: #076b5c;
			--shadow: 0 22px 70px rgba(15, 23, 42, 0.12);
			--radius: 24px;
		}
		[data-theme="dark"] {
			--bg-primary: #080d16;
			--bg-secondary: rgba(14, 22, 36, 0.88);
			--surface: rgba(19, 29, 47, 0.72);
			--surface-strong: #111827;
			--text-primary: #eef4ff;
			--text-secondary: #a8b3c7;
			--muted: rgba(255,255,255,0.08);
			--border: rgba(255,255,255,0.12);
			--tag-bg: rgba(74, 222, 190, 0.14);
			--tag-text: #70f0d5;
			--code-bg: #020617;
			--shadow: 0 22px 80px rgba(0, 0, 0, 0.38);
		}
		* { margin: 0; padding: 0; box-sizing: border-box; }
		html { scroll-behavior: smooth; }
		body {
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			line-height: 1.7;
			color: var(--text-primary);
			background:
				radial-gradient(circle at top left, rgba(255,107,53,.22), transparent 34rem),
				radial-gradient(circle at top right, rgba(22,199,168,.2), transparent 28rem),
				var(--bg-primary);
			min-height: 100vh;
			transition: background 0.3s, color 0.3s;
		}
		a { color: inherit; text-decoration: none; }
		a:hover { color: var(--accent); }
		img { max-width: 100%; height: auto; border-radius: 18px; }
		.container { width: min(1180px, calc(100% - 32px)); max-width: 100%; margin: 0 auto; padding: 24px 0 56px; overflow-x: clip; }
		.nav {
			position: sticky; top: 12px; z-index: 50; margin-bottom: 36px;
			display: flex; align-items: center; justify-content: space-between; gap: 16px;
			padding: 12px 14px; border: 1px solid var(--border); border-radius: 999px;
			background: var(--bg-secondary); backdrop-filter: blur(18px); box-shadow: 0 10px 30px rgba(15,23,42,.08);
		}
		.brand { display: inline-flex; align-items: center; gap: 10px; min-width: 0; font-weight: 800; letter-spacing: -0.03em; }
		.brand-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: white; box-shadow: 0 10px 24px rgba(255, 107, 53, .16); overflow: hidden; flex: 0 0 auto; }
		.brand-mark img { width: 100%; height: 100%; display: block; object-fit: cover; border-radius: 50%; }
		.brand-copy { display: grid; gap: 1px; line-height: .95; }
		.brand-name { font-size: clamp(1.05rem, 2.3vw, 1.35rem); color: var(--accent); letter-spacing: -0.04em; }
		.brand-subtitle { font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; color: var(--text-muted); }
		.nav-links { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
		.nav a:not(.brand) { padding: 8px 12px; color: var(--text-secondary); border-radius: 999px; font-size: .92rem; }
		.nav a:hover { background: var(--muted); color: var(--text-primary); }
		.theme-toggle {
			position: fixed; right: 22px; bottom: 22px; z-index: 1000; width: 48px; height: 48px;
			border: 1px solid var(--border); border-radius: 50%; cursor: pointer; font-size: 1.2rem;
			background: var(--surface-strong); color: var(--text-primary); box-shadow: var(--shadow); transition: transform .2s ease;
		}
		.theme-toggle:hover { transform: translateY(-3px) rotate(8deg); }
		.hero { position: relative; overflow: hidden; padding: clamp(34px, 6vw, 72px); border-radius: 36px; background: linear-gradient(135deg, rgba(255,255,255,.9), rgba(255,255,255,.62)); border: 1px solid var(--border); box-shadow: var(--shadow); }
		[data-theme="dark"] .hero { background: linear-gradient(135deg, rgba(17,24,39,.94), rgba(17,24,39,.62)); }
		.hero-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); gap: 30px; align-items: center; }
		.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .13em; font-size: .78rem; font-weight: 800; }
		h1 { font-size: clamp(2.45rem, 7vw, 5.6rem); line-height: .92; letter-spacing: -0.075em; margin: 14px 0 18px; }
		h2 { font-size: clamp(1.55rem, 3vw, 2.35rem); line-height: 1.05; letter-spacing: -0.045em; margin: 0 0 16px; }
		h3 { font-size: 1.15rem; line-height: 1.2; margin: 0 0 8px; }
		.lede { font-size: clamp(1.05rem, 2vw, 1.26rem); color: var(--text-secondary); max-width: 68ch; }
		.hero-actions, .project-actions, .post-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
		.btn, .project-actions a, .share-link { display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 10px 15px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-strong); font-weight: 700; }
		.btn.primary { background: linear-gradient(135deg, var(--accent), #fb923c); color: white; border-color: transparent; }
		.btn:hover, .project-actions a:hover, .share-link:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(15,23,42,.12); }
		.hero-panel { display: grid; gap: 12px; min-width: 0; padding: 20px; border: 1px solid var(--border); border-radius: 24px; background: var(--surface); }
		.metric { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto); align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
		.metric span { min-width: 0; }
		.metric strong { min-width: 0; max-width: 100%; text-align: right; overflow-wrap: anywhere; }
		.metric:last-child { border-bottom: 0; }
		.section { margin-top: 44px; }
		.section-heading { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 18px; }
		.section-heading p { color: var(--text-secondary); max-width: 65ch; }
		.project-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
		.tool-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
		.project-card { position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; min-height: 220px; padding: 22px; border: 1px solid var(--border); border-radius: 24px; background: var(--surface); transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }
		.project-card::before { content: ''; position: absolute; inset: 0 0 auto; height: 4px; background: var(--project-accent); }
		.project-card:hover { transform: translateY(-5px); border-color: var(--project-accent); box-shadow: 0 18px 50px rgba(15,23,42,.12); }
		.project-card p { color: var(--text-secondary); }
		.project-card.compact { min-height: auto; }
		.tool-card { position: relative; overflow: hidden; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px; align-items: start; min-height: 168px; padding: 18px; border: 1px solid var(--border); border-radius: 22px; background: var(--surface); transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }
		.tool-card::before { content: ''; position: absolute; inset: 0 0 auto; height: 3px; background: var(--tool-accent); }
		.tool-card:hover { transform: translateY(-5px); border-color: var(--tool-accent); box-shadow: 0 18px 50px color-mix(in srgb, var(--tool-accent), transparent 82%); }
		.tool-card .card-ambient { background: radial-gradient(420px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--tool-accent), transparent 52%), transparent 44%); }
		.tool-logo { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 16px; color: white; background: linear-gradient(135deg, var(--tool-accent), color-mix(in srgb, var(--tool-accent), #020617 22%)); font-weight: 900; letter-spacing: -.04em; box-shadow: 0 14px 32px color-mix(in srgb, var(--tool-accent), transparent 72%); }
		.tool-logo img { width: 28px; height: 28px; border-radius: 7px; object-fit: contain; background: rgba(255,255,255,.92); padding: 3px; }
		.tool-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
		.tool-card p { color: var(--text-secondary); margin-top: 7px; }
		.tool-actions-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
		.tool-action-links { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.tool-action-links a { display: inline-flex; align-items: center; justify-content: center; padding: 8px 11px; border-radius: 999px; border: 1px solid var(--border); background: color-mix(in srgb, var(--surface-strong), white 10%); color: var(--text-primary); font-size: .84rem; font-weight: 800; }
		.tool-action-links a:hover { border-color: var(--tool-accent); color: var(--tool-accent); }
		.tool-status { display: inline-flex; width: fit-content; padding: 5px 9px; border-radius: 999px; color: var(--tool-accent); background: color-mix(in srgb, var(--tool-accent), transparent 86%); font-size: .78rem; font-weight: 800; }
		.controls { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-bottom: 18px; }
		.search-box { width: 100%; min-height: 48px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-strong); color: var(--text-primary); padding: 0 16px; font: inherit; }
		.filter-row { display: flex; flex-wrap: wrap; gap: 8px; }
		.filter-chip { border: 1px solid var(--border); background: var(--surface-strong); color: var(--text-secondary); border-radius: 999px; padding: 9px 12px; cursor: pointer; font-weight: 700; }
		.filter-chip.active, .filter-chip:hover { color: white; background: var(--accent); border-color: var(--accent); }
		.post-list { list-style: none; display: grid; gap: 18px; }
		.post-card { cursor: pointer; position: relative; padding: clamp(20px, 4vw, 30px); border: 1px solid var(--border); border-radius: 28px; background: var(--surface); box-shadow: 0 10px 30px rgba(15,23,42,.06); transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
		.post-card:hover { transform: translateY(-4px); border-color: var(--project-accent); box-shadow: 0 22px 60px rgba(15,23,42,.12); }
		.post-card-topline, .post-card-footer, .article-meta, .pager { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
		.post-card-topline, .article-meta { color: var(--text-secondary); font-size: .93rem; margin-bottom: 12px; }
		.project-pill { display: inline-flex; padding: 5px 10px; border-radius: 999px; background: color-mix(in srgb, var(--project-accent), transparent 82%); color: var(--project-accent); font-weight: 800; }
		.post-title { margin-bottom: 10px; }
		.post-title a:hover { color: var(--project-accent); }
		.post-card p { color: var(--text-secondary); max-width: 78ch; }
		.tag-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
		.tag { display: inline-flex; align-items: center; padding: 5px 10px; border-radius: 999px; background: var(--tag-bg); color: var(--tag-text); font-size: .84rem; font-weight: 750; }
		.tag:hover { color: white; background: var(--accent); }
		.read-more { color: var(--project-accent); font-weight: 800; white-space: nowrap; }

		.reveal-card { isolation: isolate; transform-style: preserve-3d; will-change: transform; }
		.card-ambient { position: absolute; inset: -1px; border-radius: inherit; pointer-events: none; opacity: 0; z-index: -1; background: radial-gradient(520px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--project-accent), transparent 48%), transparent 42%); transition: opacity .35s ease; }
		.reveal-card::after { content: ''; position: absolute; inset: 1px; border-radius: inherit; pointer-events: none; opacity: 0; background: linear-gradient(135deg, color-mix(in srgb, var(--project-accent), transparent 84%), transparent 38%, rgba(255,255,255,.10)); transition: opacity .35s ease; }
		.reveal-card.is-inview { animation: card-breathe 2.4s ease-in-out infinite; }
		.reveal-card.is-active, .reveal-card:hover, .reveal-card:focus-within { transform: perspective(1000px) translateY(-9px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)) scale(1.018); border-color: color-mix(in srgb, var(--project-accent), white 10%); box-shadow: 0 28px 90px color-mix(in srgb, var(--project-accent), transparent 76%), 0 18px 60px rgba(15,23,42,.18); }
		.reveal-card.is-active .card-ambient, .reveal-card:hover .card-ambient, .reveal-card.is-active::after, .reveal-card:hover::after { opacity: 1; }
		.card-preview { display: grid; grid-template-columns: repeat(4, minmax(44px, 1fr)); gap: 8px; max-height: 0; opacity: 0; transform: translateY(10px); overflow: hidden; transition: max-height .45s cubic-bezier(.2,.8,.2,1), opacity .3s ease, transform .35s ease; }
		.card-preview span { min-height: 42px; display: grid; place-items: center; border-radius: 14px; color: color-mix(in srgb, var(--project-accent), white 18%); background: linear-gradient(135deg, color-mix(in srgb, var(--project-accent), transparent 72%), rgba(255,255,255,.08)); border: 1px solid color-mix(in srgb, var(--project-accent), transparent 70%); font-size: .72rem; font-weight: 850; text-transform: uppercase; letter-spacing: .08em; }
		.reveal-card.is-active .card-preview, .reveal-card:hover .card-preview { max-height: 84px; opacity: 1; transform: translateY(0); margin: 18px 0 0; }
		.post-card-popout { display: grid; gap: 4px; max-height: 0; opacity: 0; overflow: hidden; transform: translateY(8px); transition: max-height .45s cubic-bezier(.2,.8,.2,1), opacity .3s ease, transform .35s ease; color: var(--text-secondary); }
		.post-card-popout strong { color: var(--text-primary); }
		.reveal-card.is-active .post-card-popout, .reveal-card:hover .post-card-popout { max-height: 80px; opacity: 1; transform: translateY(0); margin-top: 14px; }
		.reveal-card.is-active .read-more, .reveal-card:hover .read-more { transform: translateX(4px); color: color-mix(in srgb, var(--project-accent), white 18%); }
		.hero::before { content: ''; position: absolute; width: 26rem; height: 26rem; right: -10rem; top: -12rem; border-radius: 50%; background: radial-gradient(circle, rgba(255,107,53,.26), transparent 62%); filter: blur(12px); animation: float-orb 8s ease-in-out infinite alternate; }
		.hero::after { content: ''; position: absolute; width: 18rem; height: 18rem; left: 48%; bottom: -11rem; border-radius: 50%; background: radial-gradient(circle, rgba(22,199,168,.2), transparent 65%); filter: blur(10px); animation: float-orb 10s ease-in-out infinite alternate-reverse; }
		.hero > * { position: relative; z-index: 1; }
		@keyframes card-breathe { 0%,100% { box-shadow: 0 10px 30px rgba(15,23,42,.06); } 50% { box-shadow: 0 18px 58px color-mix(in srgb, var(--project-accent), transparent 88%); } }
		@keyframes float-orb { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(-24px,18px,0) scale(1.08); } }
		@media (prefers-reduced-motion: reduce) { .reveal-card, .card-preview, .post-card-popout, .hero::before, .hero::after { animation: none !important; transition: none !important; } .reveal-card.is-active, .reveal-card:hover { transform: none; } }

		.no-results { display: none; padding: 24px; border: 1px dashed var(--border); border-radius: 20px; color: var(--text-secondary); text-align: center; }
		.progress { position: fixed; inset: 0 0 auto; height: 4px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transform-origin: left; transform: scaleX(0); z-index: 2000; }
		.article-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 30px; align-items: start; }
		.article-shell { padding: clamp(24px, 5vw, 52px); border: 1px solid var(--border); border-radius: 32px; background: var(--surface); box-shadow: var(--shadow); }
		.article-shell h1 { font-size: clamp(2.15rem, 5vw, 4.2rem); }
		.article-description { color: var(--text-secondary); font-size: 1.12rem; margin: 16px 0; }
		.post-content { font-size: 1.06rem; }
		.post-content h2, .post-content h3 { scroll-margin-top: 96px; margin-top: 2.1em; }
		.post-content p { margin: 1.05em 0; }
		.post-content a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
		.post-content ul, .post-content ol { margin: 1em 0 1em 1.4em; }
		.post-content blockquote { border-left: 4px solid var(--accent); padding: 14px 0 14px 18px; margin: 24px 0; color: var(--text-secondary); background: var(--muted); border-radius: 0 16px 16px 0; }
		.post-content figure { margin: 28px 0; padding: 12px; border: 1px solid var(--border); border-radius: 24px; background: var(--surface-strong); box-shadow: 0 16px 50px rgba(15,23,42,.08); }
		.post-content figcaption { color: var(--text-secondary); font-size: .9rem; margin: 10px 4px 2px; }
		.post-content iframe { width: 100%; min-height: min(76vh, 720px); border: 1px solid var(--border); border-radius: 22px; background: var(--bg-secondary); box-shadow: 0 16px 50px rgba(15,23,42,.12); }
		.post-content .interactive-embed { margin: 32px 0; }
		.post-content .interactive-embed iframe { display: block; aspect-ratio: 16 / 10; min-height: 460px; }
		.post-content img, .post-content video { display: block; width: 100%; max-width: 100%; height: auto; }
		.post-content video { border-radius: 18px; margin: 24px 0; background: #000; box-shadow: 0 16px 50px rgba(15,23,42,.12); }
		.media-frame { overflow: hidden; }
		.media-frame > img { border-radius: 16px; }
		.media-scroll { max-width: 100%; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; overscroll-behavior-inline: contain; border-radius: 16px; }
		.media-scroll:focus { outline: 2px solid var(--accent); outline-offset: 3px; }
		.media-scroll img { width: 100%; max-width: 100%; min-width: 0; border-radius: 16px; }
		.asset-gallery { margin-top: 34px; padding-top: 24px; border-top: 1px solid var(--border); }
		.section-heading.compact { align-items: start; }
		.asset-link-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 14px; }
		.asset-link-card { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-strong); text-decoration: none; }
		.asset-link-card strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.asset-link-card small { display: block; color: var(--text-secondary); font-size: .78rem; }
		.asset-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 10px; color: white; background: var(--accent); font-weight: 900; }
		.referral-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 24px; border: 1px solid var(--border); border-radius: 28px; background: var(--surface); box-shadow: 0 16px 50px rgba(15,23,42,.08); }
		.referral-form label { display: grid; gap: 8px; }
		.referral-form span { font-weight: 700; color: var(--text-primary); }
		.referral-form input, .referral-form textarea, .referral-form select { width: 100%; min-height: 48px; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--border); background: var(--surface-strong); color: var(--text-primary); font: inherit; }
		.referral-form textarea { min-height: 140px; resize: vertical; }
		.field-full { grid-column: 1 / -1; }
		.consent-row { display: flex !important; align-items: flex-start; gap: 12px; }
		.consent-row input { width: 20px; height: 20px; min-height: 20px; margin-top: 4px; }
		.consent-row span { font-weight: 600; color: var(--text-secondary); }
		.form-actions { display: flex; flex-wrap: wrap; gap: 10px; }
		.form-alert { padding: 14px 16px; border-radius: 18px; margin-bottom: 14px; }
		.form-alert.error { background: color-mix(in srgb, #ef4444, transparent 90%); border: 1px solid color-mix(in srgb, #ef4444, transparent 65%); color: #b91c1c; }
		.form-alert.success { background: color-mix(in srgb, #16a34a, transparent 90%); border: 1px solid color-mix(in srgb, #16a34a, transparent 65%); color: #166534; }
		.referral-table { width: 100%; border-collapse: collapse; min-width: 900px; }
		.referral-table th, .referral-table td { text-align: left; vertical-align: top; padding: 14px 12px; border-bottom: 1px solid var(--border); }
		.referral-table th { font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text-secondary); }
		.admin-status-stack { display: grid; gap: 6px; }
		.admin-status-stack small { color: var(--text-secondary); font-size: .78rem; }
		.admin-status-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.admin-status-form select { min-height: 40px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-strong); color: var(--text-primary); font: inherit; }
		.admin-status-form .btn { min-height: 40px; padding: 8px 12px; }
		pre { background: var(--code-bg); padding: 18px; border-radius: 18px; overflow-x: auto; margin: 22px 0; }
		code { font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, monospace; font-size: .92rem; }
		.toc-stack { position: sticky; top: 96px; display: grid; gap: 16px; }
		.toc-card { padding: 18px; border: 1px solid var(--border); border-radius: 22px; background: var(--surface); }
		.toc-link { display: block; color: var(--text-secondary); padding: 7px 0; font-size: .92rem; }
		.toc-link.depth-3 { padding-left: 12px; font-size: .86rem; }
		.toc-link:hover { color: var(--accent); }
		.related-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 16px; }
		.related-card { display: block; padding: 16px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface-strong); }
		.related-card p { color: var(--text-secondary); font-size: .92rem; }
		.pager { margin-top: 34px; padding-top: 24px; border-top: 1px solid var(--border); }
		.footer { margin-top: 56px; padding: 32px; border: 1px solid var(--border); border-radius: 28px; background: var(--surface); }
		.footer-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 22px; }
		.footer a { display: block; color: var(--text-secondary); margin: 7px 0; }
		.footer a:hover { color: var(--accent); }
		@media (max-width: 980px) { .hero-grid, .article-layout, .footer-grid { grid-template-columns: 1fr; } .toc-stack { position: static; } .controls { grid-template-columns: 1fr; } }
		@media (max-width: 640px) { .container { width: min(100% - 20px, 1180px); padding-top: 10px; } .nav { position: static; align-items: flex-start; border-radius: 22px; flex-direction: column; } .brand-name { font-size: 1.1rem; } .nav-links { width: 100%; justify-content: flex-start; gap: 4px; } .nav a:not(.brand) { padding: 7px 9px; font-size: .84rem; } .theme-toggle { right: 14px; bottom: 14px; width: 42px; height: 42px; } .hero, .article-shell { border-radius: 24px; padding: 16px; } .hero-actions, .post-actions, .pager { align-items: stretch; flex-direction: column; } .btn, .share-link { width: 100%; justify-content: center; text-align: center; } .section-heading { align-items: start; flex-direction: column; } .post-card-topline, .post-card-footer, .article-meta { align-items: flex-start; flex-direction: column; gap: 8px; } .card-preview { grid-template-columns: repeat(2, 1fr); } .post-content { font-size: 1rem; } .wide-media-frame { margin-inline: -6px; padding: 8px; } .wide-media-frame .media-scroll img { width: 760px; max-width: none; } .wide-media-frame figcaption { font-size: .8rem; } .post-content .interactive-embed iframe { min-height: 320px; } .asset-link-grid { grid-template-columns: 1fr; } .referral-form { grid-template-columns: 1fr; padding: 18px; } .referral-table { min-width: 780px; } pre { max-width: 100%; margin-inline: -8px; border-radius: 14px; } code { overflow-wrap: anywhere; } }
	</style>
</head>
<body>
	<div class="progress" id="reading-progress" aria-hidden="true"></div>
	<button class="theme-toggle" onclick="toggleTheme()" id="theme-toggle" aria-label="Toggle theme">🌙</button>
	<div class="container">
		<nav class="nav" aria-label="Primary navigation">
			<a class="brand" href="/" aria-label="Minte Blog home"><span class="brand-mark"><img src="${MINTE_FAVICON_URL}" alt="" width="42" height="42"></span><span class="brand-copy"><span class="brand-name">Minte.dev</span><span class="brand-subtitle">Build Log</span></span></a>
			<div class="nav-links">
				<a href="/#projects">Projects</a>
				<a href="/#products">Products</a>
				<a href="/#posts">Posts</a>
				<a href="https://handybeaver.co/" target="_blank" rel="noopener">Handy Beaver</a>
				<a href="https://kiamichibizconnect.com/" target="_blank" rel="noopener">KBC</a>
				<a href="https://github.com/Atlas-Os1" target="_blank" rel="noopener">GitHub</a>
				<a href="/rss.xml">RSS</a>
			</div>
		</nav>
		<main>
			${content}
		</main>
		<footer class="footer">
			<div class="footer-grid">
				<div>
					<p class="eyebrow">Atlas / Minte</p>
					<h3>Building public, useful systems.</h3>
					<p style="color: var(--text-secondary); margin-top: 10px;">Cloudflare Workers, AI agents, local business platforms, and automation infrastructure.</p>
				</div>
				<div>
					<h3>Sites</h3>
					<a href="https://handybeaver.co/" target="_blank" rel="noopener">HandyBeaver.co</a>
					<a href="https://kiamichibizconnect.com/" target="_blank" rel="noopener">KiamichiBizConnect.com</a>
					<a href="https://blog.minte.dev/">Minte Blog</a>
				</div>
				<div>
					<h3>Repos & Socials</h3>
					<a href="https://github.com/Atlas-Os1" target="_blank" rel="noopener">GitHub: Atlas-Os1</a>
					<a href="https://github.com/mintedmaterial" target="_blank" rel="noopener">GitHub: mintedmaterial</a>
					<a href="https://x.com/Colt45reborn_s" target="_blank" rel="noopener">𝕏 @Colt45reborn_s</a>
					<a href="https://twitter.com/AtlasOS_AI" target="_blank" rel="noopener">𝕏 @AtlasOS_AI</a>
				</div>
			</div>
			<p style="color: var(--text-secondary); font-size: .9rem; margin-top: 24px;">© ${new Date().getFullYear()} Atlas-OS · Built with Cloudflare Workers, R2, and AI.</p>
		</footer>
	</div>
	<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
	<script>if (window.hljs) hljs.highlightAll();</script>
	<script>
		function toggleTheme() {
			const html = document.documentElement;
			const currentTheme = html.getAttribute('data-theme');
			const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
			const btn = document.getElementById('theme-toggle');
			html.setAttribute('data-theme', newTheme);
			localStorage.setItem('theme', newTheme);
			btn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
		}
		(function() {
			const savedTheme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
			const btn = document.getElementById('theme-toggle');
			document.documentElement.setAttribute('data-theme', savedTheme);
			btn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
		})();
		(function() {
			const progress = document.getElementById('reading-progress');
			function updateProgress() {
				const max = document.documentElement.scrollHeight - innerHeight;
				const ratio = max > 0 ? Math.min(1, scrollY / max) : 0;
				progress.style.transform = 'scaleX(' + ratio + ')';
			}
			addEventListener('scroll', updateProgress, { passive: true });
			updateProgress();
		})();
		(function() {
			const search = document.querySelector('[data-post-search]');
			const cards = Array.from(document.querySelectorAll('[data-search]'));
			const chips = Array.from(document.querySelectorAll('[data-project-filter]'));
			const empty = document.querySelector('[data-no-results]');
			let activeProject = 'all';
			function applyFilters() {
				const query = search ? search.value.trim().toLowerCase() : '';
				let shown = 0;
				cards.forEach(function(card) {
					const matchesQuery = !query || card.dataset.search.includes(query);
					const matchesProject = activeProject === 'all' || card.dataset.project === activeProject;
					const visible = matchesQuery && matchesProject;
					card.style.display = visible ? '' : 'none';
					if (!visible) card.classList.remove('is-active', 'is-inview');
					if (visible) shown += 1;
				});
				if (empty) empty.style.display = shown ? 'none' : 'block';
			}
			if (search) search.addEventListener('input', applyFilters);
			chips.forEach(function(chip) {
				chip.addEventListener('click', function() {
					activeProject = chip.dataset.projectFilter || 'all';
					chips.forEach(function(c) { c.classList.toggle('active', c === chip); });
					applyFilters();
				});
			});
		})();
		(function() {
			const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
			const revealCards = Array.from(document.querySelectorAll('[data-reveal-card]'));
			let activeCard = null;
			const timers = new WeakMap();
			function activate(card) {
				if (card.style.display === 'none') return;
				if (activeCard && activeCard !== card) activeCard.classList.remove('is-active');
				activeCard = card;
				card.classList.add('is-active');
			}
			function deactivate(card) {
				const timer = timers.get(card);
				if (timer) clearTimeout(timer);
				card.classList.remove('is-inview');
			}
			if ('IntersectionObserver' in window) {
				const observer = new IntersectionObserver(function(entries) {
					entries.forEach(function(entry) {
						const card = entry.target;
						if (entry.isIntersecting && entry.intersectionRatio > 0.55) {
							card.classList.add('is-inview');
							const timer = setTimeout(function() { activate(card); }, reduceMotion ? 0 : 520);
							timers.set(card, timer);
						} else {
							deactivate(card);
						}
					});
				}, { threshold: [0, .35, .55, .75], rootMargin: '-12% 0px -18% 0px' });
				revealCards.forEach(function(card) { observer.observe(card); });
			}
			revealCards.forEach(function(card) {
				card.addEventListener('pointerenter', function() { activate(card); });
				card.addEventListener('pointermove', function(event) {
					const rect = card.getBoundingClientRect();
					const x = event.clientX - rect.left;
					const y = event.clientY - rect.top;
					const px = x / rect.width;
					const py = y / rect.height;
					card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
					card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
					if (!reduceMotion) {
						card.style.setProperty('--rx', ((0.5 - py) * 4).toFixed(2) + 'deg');
						card.style.setProperty('--ry', ((px - 0.5) * 5).toFixed(2) + 'deg');
					}
				});
				card.addEventListener('pointerleave', function() {
					card.style.setProperty('--rx', '0deg');
					card.style.setProperty('--ry', '0deg');
				});
			});
		})();
	</script>
</body>
</html>`;
}

// Helper: Generate meta tags for social sharing
function generateMetaTags(post: Omit<BlogPost, 'content'>): string {
	const heroImage = (post as any).heroImage || 'https://blog.minte.dev/assets/default-og-image.png';
	const url = `https://blog.minte.dev/posts/${post.slug}`;
	return `
	<meta property="og:title" content="${post.title}">
	<meta property="og:description" content="${post.description}">
	<meta property="og:type" content="article">
	<meta property="og:url" content="${url}">
	<meta property="og:image" content="${heroImage}">
	<meta property="og:site_name" content="Minte Blog">
	<meta property="article:published_time" content="${post.pubDate}">
	<meta property="article:author" content="${post.author}">
	${post.tags.map(tag => `<meta property="article:tag" content="${tag}">`).join('\n\t')}
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${post.title}">
	<meta name="twitter:description" content="${post.description}">
	<meta name="twitter:image" content="${heroImage}">
	<meta name="twitter:creator" content="@AtlasOS_AI">
	<meta name="twitter:site" content="@AtlasOS_AI">
	<meta name="description" content="${post.description}">
	<link rel="canonical" href="${url}">
	<script type="application/ld+json">
	{
		"@context": "https://schema.org",
		"@type": "BlogPosting",
		"headline": "${post.title}",
		"description": "${post.description}",
		"author": {
			"@type": "Person",
			"name": "${post.author}"
		},
		"datePublished": "${post.pubDate}",
		"image": "${heroImage}",
		"url": "${url}",
		"keywords": "${post.tags.join(', ')}"
	}
	</script>
	`;
}

// Homepage: List all posts
app.get('/', async (c) => {
	const blogCache = caches.default;
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		const emptyContent = `
			<section class="hero">
				<p class="eyebrow">Atlas / Minte Build Log</p>
				<h1>Building in Public</h1>
				<p class="lede">No posts are available yet, but the publishing worker is online.</p>
			</section>`;
		return c.html(renderPage('Blog', emptyContent), 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const publishedPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory');
	const featuredProjects = PROJECTS.slice(0, 6).map((project) => renderProjectCard(project)).join('');
	const productStack = TOOL_LINKS.map((tool) => renderToolCard(tool)).join('');
	const postsHtml = publishedPosts.map(renderPostCard).join('');
	const topTags = Object.entries(index.tags)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([tag]) => `<a class="tag" href="/tags/${encodeURIComponent(tag)}">#${escapeHtml(tag)}</a>`)
		.join('');

	const content = `
		<section class="hero">
			<div class="hero-grid">
				<div>
					<p class="eyebrow">Cloudflare · AI agents · local business systems</p>
					<h1>Building the Atlas / Minte stack in public.</h1>
					<p class="lede">A living build log for the repos, Workers, agents, and local-business platforms behind Handy Beaver, Kiamichi Biz Connect, OpenClaw memory, and the Minte publishing system.</p>
					<div class="hero-actions">
						<a class="btn primary" href="#posts">Read latest posts →</a>
						<a class="btn" href="#projects">Explore projects</a>
						<a class="btn" href="https://github.com/Atlas-Os1" target="_blank" rel="noopener">GitHub</a>
					</div>
				</div>
				<div class="hero-panel" aria-label="Blog stats">
					<div class="metric"><span>Published posts</span><strong>${publishedPosts.length}</strong></div>
					<div class="metric"><span>Top tag</span><strong>${escapeHtml(Object.entries(index.tags).sort((a, b) => b[1] - a[1])[0]?.[0] || 'building-in-public')}</strong></div>
					<div class="metric"><span>Runtime</span><strong>Cloudflare Workers</strong></div>
					<div class="metric"><span>Storage</span><strong>R2 + Workflows</strong></div>
					<div class="tag-row">${topTags}</div>
				</div>
			</div>
		</section>

		<section class="section" id="projects">
			<div class="section-heading">
				<div>
					<p class="eyebrow">Project ecosystem</p>
					<h2>Every post should point back to what we are shipping.</h2>
				</div>
				<p>These cards make the blog work as a portfolio and navigation hub, not just a dated archive.</p>
			</div>
			<div class="project-grid">${featuredProjects}</div>
		</section>

		<section class="section" id="products">
			<div class="section-heading">
				<div>
					<p class="eyebrow">Products we use</p>
					<h2>The tools and platforms behind the build log.</h2>
				</div>
				<p>A quick stack shelf for the products, developer platforms, and open repos powering Atlas / Minte projects. Photon is linked now and has a reserved referral spot for the final URL.</p>
			</div>
			<div class="tool-grid">${productStack}</div>
		</section>

		<section class="section" id="photon-referral-cta">
			<div class="section-heading">
				<div>
					<p class="eyebrow">Photon referral</p>
					<h2>Want 15% off Photon Spectrum?</h2>
				</div>
				<p>Send us the business details first. We’ll review the lead and submit it to Photon’s referral flow for you.</p>
			</div>
			<div class="project-grid">
				<article class="project-card reveal-card compact" data-reveal-card style="--project-accent: #f97316">
					<div class="card-ambient" aria-hidden="true"></div>
					<div>
						<p class="eyebrow">Photon referral</p>
						<h3>Submit a business</h3>
						<p>Photon’s current referral flow is a submission, not a public coupon code. We collect the intro, review it, then fill the Photon form ourselves.</p>
					</div>
					<div class="project-actions">
						<a href="/photon-referral">Open intake form</a>
						<a href="https://refer.photon.codes/" target="_blank" rel="noopener">Photon referral page</a>
					</div>
				</article>
			</div>
		</section>

		<section class="section" id="posts">
			<div class="section-heading">
				<div>
					<p class="eyebrow">Latest build notes</p>
					<h2>Browse the work by repo, project, or tag.</h2>
				</div>
				<p>Search titles, tags, project names, authors, and descriptions. Hover a card and click anywhere to open the post.</p>
			</div>
			<div class="controls">
				<input class="search-box" data-post-search type="search" placeholder="Search posts, projects, tags..." aria-label="Search posts">
				<div class="filter-row" aria-label="Project filters">
					<button class="filter-chip active" type="button" data-project-filter="all">All</button>
					${PROJECTS.slice(0, 5).map((project) => `<button class="filter-chip" type="button" data-project-filter="${project.slug}">${project.name}</button>`).join('')}
				</div>
			</div>
			<ul class="post-list">
				${postsHtml}
			</ul>
			<div class="no-results" data-no-results>No posts match that search yet.</div>
		</section>
	`;

	return c.html(renderPage('Home', content));
});

// Memory page with password protection
app.get('/memory', async (c) => {
	const memoryPassword = c.env.MEMORY_PASSWORD;
	
	if (!hasMemoryAccess(c, memoryPassword)) {
		// Show password form
		const passwordForm = `
			<div style="max-width: 600px; margin: 100px auto; padding: 2rem; background: #1a1a1a; border-radius: 12px; text-align: center;">
				<h1>🔒 Memory Access Required</h1>
				<p style="color: #888; margin: 1rem 0;">This section contains internal workspace memory files.</p>
				<form method="GET" action="/memory" style="margin-top: 2rem;">
					<input type="password" 
						name="password" 
						placeholder="Enter password" 
						style="padding: 0.75rem; width: 300px; font-size: 1rem; border: 1px solid #333; background: #0a0a0a; color: #fff; border-radius: 6px;"
						autofocus
					/>
					<button type="submit" 
						style="padding: 0.75rem 1.5rem; margin-left: 0.5rem; font-size: 1rem; background: #0066cc; color: white; border: none; border-radius: 6px; cursor: pointer;">
						Access
					</button>
				</form>
			</div>
		`;
		return c.html(renderPage('Memory - Access Required', passwordForm), 401);
	}

	// Password correct - show memory posts
	const blogCache = caches.default;
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		return c.html(renderPage('Memory', '<p>No memory posts available yet.</p>'), 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	// Filter to only memory category posts
	const memoryPosts = index.posts.filter((p: any) => !p.draft && p.category === 'memory');

	if (memoryPosts.length === 0) {
		return c.html(renderPage('Memory', '<h1>📝 Daily Memory Logs</h1><p>No memory posts yet.</p>'), 404);
	}

	const postsHtml = memoryPosts
		.map(
			(post: any) => `
		<div class="post-item">
			<h2 class="post-title"><a href="/posts/${post.slug}">${post.title}</a></h2>
			<div class="post-meta">
				${new Date(post.pubDate).toLocaleDateString()} by ${post.author}
			</div>
			<p>${post.description}</p>
			<div>
				${post.tags.map((tag: string) => `<span class="tag">${tag}</span>`).join('')}
			</div>
		</div>
	`
		)
		.join('');

	const content = `
		<header>
			<h1>📝 Daily Memory Logs</h1>
			<p style="color: #666; font-size: 1.1rem;">
				Automated daily logs from workspace activity, GitHub commits, and development notes.
			</p>
			<p style="color: #888; font-size: 0.95rem;">
				<em>⚠️ These are raw memory files containing internal workspace notes and context.</em>
			</p>
			<p style="margin-top: 1rem;">
				<a href="/" style="color: #0066cc;">← Back to Blog</a>
			</p>
		</header>
		<ul class="post-list">
			${postsHtml}
		</ul>
	`;

	const response = c.html(renderPage('Memory', content));
	response.headers.append('Set-Cookie', `memory_access=${encodeURIComponent(memoryPassword || '')}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`);
	return response;
});

// Post view: /posts/[slug]
app.get('/posts/:slug', async (c) => {
	const slug = c.req.param('slug');
	const blogCache = caches.default;

	const postData = await fetchFromR2(c.env.BLOG_BUCKET, `posts/${slug}.json`, blogCache);

	if (!postData) {
		return c.html(renderPage('Not Found', '<section class="article-shell"><h1>Post not found</h1><p>The post you are looking for does not exist.</p></section>'), 404);
	}

	const post: BlogPost = JSON.parse(postData);

	if (post.draft) {
		return c.html(renderPage('Not Found', '<section class="article-shell"><h1>Post not found</h1><p>The post you are looking for does not exist.</p></section>'), 404);
	}

	// Check if memory post and require password
	if ((post as any).category === 'memory' && !hasMemoryAccess(c, c.env.MEMORY_PASSWORD)) {
		return c.redirect('/memory');
	}

	const contentWithoutH1 = stripLeadingH1(post.content, post.title);
	const htmlContent = enhanceRenderedMedia(addHeadingIds(await marked(contentWithoutH1)));
	const assetGallery = renderAssetGallery(post);
	const toc = buildTableOfContents(contentWithoutH1);
	const project = inferProject(post);
	const readingTime = estimateReadingTime(post.content, (post as any).readingTime);
	
	// Fetch related posts, neighboring posts, and same-project context
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);
	let relatedPosts: Array<Omit<BlogPost, 'content'>> = [];
	let previousPost: Omit<BlogPost, 'content'> | undefined;
	let nextPost: Omit<BlogPost, 'content'> | undefined;
	if (indexData) {
		const index: PostIndex = JSON.parse(indexData);
		const publishedPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory');
		const postIndex = publishedPosts.findIndex((p) => p.slug === slug);
		nextPost = postIndex > 0 ? publishedPosts[postIndex - 1] : undefined;
		previousPost = postIndex >= 0 && postIndex < publishedPosts.length - 1 ? publishedPosts[postIndex + 1] : undefined;
		relatedPosts = publishedPosts
			.filter((p) => p.slug !== slug && (p.tags.some(tag => post.tags.includes(tag)) || inferProject(p).slug === project.slug))
			.slice(0, 3);
	}

	const shareUrl = `https://blog.minte.dev/posts/${post.slug}`;
	const relatedHtml = relatedPosts.length > 0 ? `
		<section class="section">
			<p class="eyebrow">Keep reading</p>
			<h2>Related build notes</h2>
			<div class="related-grid">
				${relatedPosts.map((p) => `
					<a class="related-card" href="/posts/${p.slug}">
						<strong>${escapeHtml(p.title)}</strong>
						<p>${escapeHtml(p.description)}</p>
					</a>`).join('')}
			</div>
		</section>` : '';

	const content = `
		<div class="article-layout">
			<article class="article-shell" style="--project-accent: ${project.accent}">
				${(post as any).heroImage ? `
				<div style="margin-bottom: 28px;">
					<img src="${(post as any).heroImage}" alt="${escapeHtml(post.title)}" style="width: 100%; box-shadow: 0 16px 50px rgba(0,0,0,0.14);">
				</div>` : ''}
				<header>
					<p class="eyebrow">${project.name} · ${readingTime}</p>
					<h1>${escapeHtml(post.title)}</h1>
					<p class="article-description">${escapeHtml(post.description)}</p>
					<div class="article-meta">
						<span>${new Date(post.pubDate).toLocaleDateString()} by ${escapeHtml(post.author)}</span>
						<a class="project-pill" href="${project.site || project.repo}" target="_blank" rel="noopener">${project.name}</a>
					</div>
					<div class="tag-row">${renderTags(post.tags)}</div>
					<div class="post-actions">
						<a class="share-link" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(post.title)}" target="_blank" rel="noopener">Share on X</a>
						<a class="share-link" href="mailto:?subject=${encodeURIComponent(post.title)}&body=${encodeURIComponent(shareUrl)}">Email</a>
						<a class="share-link" href="${project.repo}" target="_blank" rel="noopener">Project repo</a>
					</div>
				</header>
				<div class="post-content">
					${htmlContent}
				</div>
				${assetGallery}
				${relatedHtml}
				<nav class="pager" aria-label="Post navigation">
					${previousPost ? `<a class="btn" href="/posts/${previousPost.slug}">← ${escapeHtml(previousPost.title)}</a>` : '<span></span>'}
					${nextPost ? `<a class="btn" href="/posts/${nextPost.slug}">${escapeHtml(nextPost.title)} →</a>` : '<span></span>'}
				</nav>
			</article>
			<aside class="toc-stack">
				${toc}
				${renderProjectCard(project, true)}
			</aside>
		</div>
	`;

	return c.html(renderPage(post.title, content, generateMetaTags(post)));
});

// Tag filtering: /tags/[tag]
app.get('/tags/:tag', async (c) => {
	const tag = c.req.param('tag');
	const blogCache = caches.default;

	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		return c.html(renderPage('Tag Not Found', '<section class="article-shell"><p>No posts available.</p></section>'), 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const filteredPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory' && p.tags.includes(tag));

	if (filteredPosts.length === 0) {
		return c.html(renderPage(`Tag: ${tag}`, `<section class="article-shell"><h1>Tag: ${escapeHtml(tag)}</h1><p>No posts found with this tag.</p></section>`), 404);
	}

	const postsHtml = filteredPosts.map(renderPostCard).join('');

	const content = `
		<section class="hero">
			<p class="eyebrow">Tag archive</p>
			<h1>#${escapeHtml(tag)}</h1>
			<p class="lede">Showing ${filteredPosts.length} build note(s) connected to this topic.</p>
		</section>
		<section class="section" id="posts">
			<div class="controls">
				<input class="search-box" data-post-search type="search" placeholder="Search this tag archive..." aria-label="Search posts tagged ${escapeHtml(tag)}">
				<div class="filter-row">
					<button class="filter-chip active" type="button" data-project-filter="all">All projects</button>
					${PROJECTS.slice(0, 5).map((project) => `<button class="filter-chip" type="button" data-project-filter="${project.slug}">${project.name}</button>`).join('')}
				</div>
			</div>
			<ul class="post-list">${postsHtml}</ul>
			<div class="no-results" data-no-results>No posts match that search yet.</div>
		</section>
	`;

	return c.html(renderPage(`Tag: ${tag}`, content));
});

// RSS feed: /rss.xml
app.get('/rss.xml', async (c) => {
	const blogCache = caches.default;
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		return c.text('No posts available', 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const publishedPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory');

	const rssItems = publishedPosts
		.map(
			(post) => `
		<item>
			<title>${post.title}</title>
			<link>https://blog.minte.dev/posts/${post.slug}</link>
			<description>${post.description}</description>
			<pubDate>${new Date(post.pubDate).toUTCString()}</pubDate>
			<guid>https://blog.minte.dev/posts/${post.slug}</guid>
			${post.tags.map((tag) => `<category>${tag}</category>`).join('')}
		</item>
	`
		)
		.join('');

	const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
	<channel>
		<title>Minte Blog - Building in Public</title>
		<link>https://blog.minte.dev</link>
		<description>Daily updates from Flo's development journey</description>
		<language>en-us</language>
		<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
		<atom:link href="https://blog.minte.dev/rss.xml" rel="self" type="application/rss+xml"/>
		${rssItems}
	</channel>
</rss>`;

	return c.text(rss, 200, {
		'Content-Type': 'application/rss+xml; charset=utf-8',
		'Cache-Control': 'public, max-age=3600',
	});
});

// Sitemap: /sitemap.xml
app.get('/sitemap.xml', async (c) => {
	const blogCache = caches.default;
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		return c.text('No posts available', 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const publishedPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory');

	const urls = [
		`<url>
			<loc>https://blog.minte.dev/</loc>
			<changefreq>daily</changefreq>
			<priority>1.0</priority>
		</url>`,
		...publishedPosts.map(post => `
		<url>
			<loc>https://blog.minte.dev/posts/${post.slug}</loc>
			<lastmod>${new Date(post.pubDate).toISOString().split('T')[0]}</lastmod>
			<changefreq>weekly</changefreq>
			<priority>0.8</priority>
		</url>`),
		...Object.keys(index.tags).map(tag => `
		<url>
			<loc>https://blog.minte.dev/tags/${tag}</loc>
			<changefreq>weekly</changefreq>
			<priority>0.6</priority>
		</url>`)
	].join('\n');

	const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

	return c.text(sitemap, 200, {
		'Content-Type': 'application/xml; charset=utf-8',
		'Cache-Control': 'public, max-age=3600',
	});
});

// API endpoint: /api/posts (JSON)
app.get('/api/posts', async (c) => {
	const blogCache = caches.default;
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		return c.json({ error: 'No posts available' }, 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const publishedPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory');

	return c.json(
		{
			posts: publishedPosts,
			tags: index.tags,
			total: publishedPosts.length,
		},
		200,
		{
			'Cache-Control': 'public, max-age=3600',
		}
	);
});

// API endpoint: Get single post
app.get('/api/posts/:slug', async (c) => {
	const slug = c.req.param('slug');
	const blogCache = caches.default;

	const postData = await fetchFromR2(c.env.BLOG_BUCKET, `posts/${slug}.json`, blogCache);

	if (!postData) {
		return c.json({ error: 'Post not found' }, 404);
	}

	const post: BlogPost = JSON.parse(postData);

	if (post.draft || (post as any).category === 'memory') {
		return c.json({ error: 'Post not found' }, 404);
	}

	return c.json(post, 200, {
		'Cache-Control': 'public, max-age=3600',
	});
});

// Assets route: Serve static files from R2 assets/ folder
app.get('/assets/*', async (c) => {
	const path = c.req.path.replace('/assets/', 'assets/');
	const rangeHeader = c.req.header('Range');
	let object: R2ObjectBody | null = null;
	let range: { offset: number; length?: number } | undefined;

	if (rangeHeader) {
		const head = await c.env.BLOG_BUCKET.head(path);
		const size = head?.size ?? 0;
		const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
		if (match && size > 0) {
			const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
			const end = match[2] ? Number(match[2]) : size - 1;
			if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
				range = { offset: start, length: Math.min(end, size - 1) - start + 1 };
				object = await c.env.BLOG_BUCKET.get(path, { range });
			}
		}
		if (!object) return c.text('Range Not Satisfiable', 416, { 'Content-Range': `bytes */${size}` });
	} else {
		object = await c.env.BLOG_BUCKET.get(path);
	}

	if (!object) {
		return c.notFound();
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	if (!headers.has('Content-Type')) headers.set('Content-Type', assetContentType(path));
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');

	if (range) {
		const size = object.size;
		const offset = range.offset;
		const length = range.length ?? Math.max(0, size - offset);
		headers.set('Content-Length', String(length));
		headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${size}`);
		return new Response(object.body, { status: 206, headers });
	}

	headers.set('Content-Length', String(object.size));
	return new Response(object.body, {
		headers,
	});
});

// Admin endpoint: Purge cache (requires auth header + rate limited)
app.post('/admin/purge-cache', async (c) => {
	// Rate limiting: 5 requests per minute per IP
	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const rateLimit = await checkRateLimit(ip, 'admin-purge', 5, 60);
	
	if (!rateLimit.allowed) {
		return c.json({ 
			error: 'Rate limit exceeded',
			retryAfter: rateLimit.resetAt - Math.floor(Date.now() / 1000)
		}, 429);
	}

	// Bearer token auth
	const authHeader = c.req.header('Authorization');
	if (!c.env.ADMIN_TOKEN || !authHeader || authHeader !== `Bearer ${c.env.ADMIN_TOKEN}`) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	try {
		const blogCache = caches.default;
		
		// Clear index cache and, when provided, the just-published post cache key.
		const slug = c.req.query('slug');
		const keysToPurge = [
			'https://cache/v2/posts-index.json',
			'https://cache/v2/metadata/posts-index.json',
		];
		if (slug) {
			keysToPurge.push(`https://cache/v2/posts/${slug}.json`);
		}

		for (const key of keysToPurge) {
			await blogCache.delete(new Request(key));
		}

		return c.json({ 
			success: true, 
			message: 'Cache purged successfully',
			purged: keysToPurge.length,
			slug: slug || null,
		});
	} catch (error) {
		return c.json({ 
			error: 'Cache purge failed', 
			details: error instanceof Error ? error.message : String(error) 
		}, 500);
	}
});

// Admin endpoint: Trigger blog generation manually (requires auth + rate limited)
app.post('/admin/generate-blog', async (c) => {
	// Rate limiting: 3 requests per 5 minutes per IP (blog gen is expensive)
	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const rateLimit = await checkRateLimit(ip, 'admin-generate', 3, 300);
	
	if (!rateLimit.allowed) {
		return c.json({ 
			error: 'Rate limit exceeded',
			retryAfter: rateLimit.resetAt - Math.floor(Date.now() / 1000)
		}, 429);
	}

	// Bearer token auth
	const authHeader = c.req.header('Authorization');
	if (!c.env.ADMIN_TOKEN || !authHeader || authHeader !== `Bearer ${c.env.ADMIN_TOKEN}`) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	try {
		// Generate public build note and protected memory digest
		const post = await generateBlogPost(c.env.BLOG_BUCKET);
		const memoryPost = await generateMemoryDigestPost(c.env.BLOG_BUCKET);
		
		// Publish to R2 + update index + purge cache
		const result = await publishPost(
			c.env.BLOG_BUCKET,
			post,
			c.env.CF_ZONE_ID,
			c.env.CLOUDFLARE_API_TOKEN
		);
		const memoryResult = await publishPost(
			c.env.BLOG_BUCKET,
			memoryPost,
			c.env.CF_ZONE_ID,
			c.env.CLOUDFLARE_API_TOKEN
		);
		
		if (!result.success || !memoryResult.success) {
			return c.json({ 
				error: 'Blog publish failed', 
				details: result.error || memoryResult.error
			}, 500);
		}
		
		return c.json({ 
			success: true, 
			message: 'Blog post generated and published',
			url: result.url,
			memoryUrl: memoryResult.url,
			title: post.title,
			slug: post.slug
		});
	} catch (error) {
		return c.json({ 
			error: 'Blog generation failed', 
			details: error instanceof Error ? error.message : String(error) 
		}, 500);
	}
});

// Photon referral intake
app.get('/photon-referral', async (c) => {
	const content = renderPhotonReferralForm();
	return c.html(renderPage('Photon Referral', content));
});

app.post('/photon-referral', async (c) => {
	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const rateLimit = await checkRateLimit(ip, 'photon-referral', 5, 3600);
	if (!rateLimit.allowed) {
		return c.html(renderPage('Photon Referral', renderPhotonReferralForm({}, 'You’ve hit the referral intake limit. Please try again later.')), 429);
	}

	const formData = await c.req.formData();
	const businessName = readFormValue(formData, 'businessName');
	const contactName = readFormValue(formData, 'contactName');
	const email = readFormValue(formData, 'email');
	const phone = readFormValue(formData, 'phone');
	const companySize = readFormValue(formData, 'companySize');
	const notes = readFormValue(formData, 'notes');
	const marketingConsent = formData.get('marketingConsent') === 'yes';

	const values: Partial<PhotonReferral> = {
		businessName,
		contactName,
		email,
		phone,
		companySize,
		notes,
		marketingConsent,
	};

	if (!businessName || !contactName || !email || !marketingConsent) {
		return c.html(renderPage('Photon Referral', renderPhotonReferralForm(values, 'Please fill out the required fields and confirm consent before submitting.')), 400);
	}

	const referral: PhotonReferral = {
		id: buildPhotonReferralId(businessName),
		createdAt: new Date().toISOString(),
		status: 'new',
		businessName,
		contactName,
		email,
		phone: phone || undefined,
		companySize: companySize || undefined,
		notes: notes || undefined,
		marketingConsent,
		source: 'photon-referral-form',
	};

	await savePhotonReferral(c.env.BLOG_BUCKET, referral);
	await notifyPhotonReferral(referral, c.env);

	return c.html(renderPage('Photon Referral Saved', renderPhotonReferralSuccess(referral)));
});

app.get('/admin/photon-referrals', async (c) => {
	const queryToken = c.req.query('token');
	if (!isPhotonAdminAuthorized(c, c.env)) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const referrals = await loadPhotonReferrals(c.env.BLOG_BUCKET);
	const response = c.html(renderPage('Photon Referrals', renderPhotonReferralAdmin(referrals)));
	if (queryToken && queryToken === c.env.ADMIN_TOKEN) {
		response.headers.append('Set-Cookie', buildPhotonAdminCookie(queryToken, new URL(c.req.url).protocol === 'https:'));
	}
	return response;
});

app.post('/admin/photon-referrals/:id/status', async (c) => {
	if (!isPhotonAdminAuthorized(c, c.env)) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const id = c.req.param('id');
	const formData = await c.req.formData();
	const statusValue = readFormValue(formData, 'status');
	if (!isPhotonReferralStatus(statusValue)) {
		return c.html(renderPage('Photon Referrals', '<section class="section"><h1>Invalid status</h1><p>Status must be new, reviewed, submitted, confirmed, or rejected.</p></section>'), 400);
	}

	const { referral, previousStatus } = await updatePhotonReferralStatus(c.env.BLOG_BUCKET, id, statusValue);
	if (!referral) {
		return c.json({ error: 'Referral not found' }, 404);
	}

	await notifyPhotonReferralStatusChange(referral, c.env, previousStatus || 'new');
	return c.redirect('/admin/photon-referrals', 303);
});

// 404 handler
app.notFound((c) => {
	return c.html(
		renderPage('404 - Not Found', '<h1>404 - Not Found</h1><p>The page you are looking for does not exist.</p>'),
		404
	);
});

// Scheduled handler for daily blog generation (runs at 9 AM CST / 15:00 UTC)
export const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (event, env, ctx) => {
	console.log('[Daily Blog] Cron triggered at', new Date().toISOString());
	
	try {
		// Generate public build note and protected memory digest from yesterday's shared memory
		const post = await generateBlogPost(env.BLOG_BUCKET, env.GITHUB_TOKEN);
		const memoryPost = await generateMemoryDigestPost(env.BLOG_BUCKET);
		let draftKey: string | null = null;
		try {
			const draft = await generateDetailedBlogDraft(env.BLOG_BUCKET, env.AI);
			draftKey = (await saveBlogDraft(env.BLOG_BUCKET, draft)).key;
			console.log('[Daily Blog] ✅ Private full-blog draft:', draftKey);
		} catch (draftError) {
			console.error('[Daily Blog] ⚠️ Full-blog draft failed; public update and memory will continue:', draftError);
		}
		
		// Publish to R2 + update index + purge cache
		const result = await publishPost(
			env.BLOG_BUCKET,
			post,
			env.CF_ZONE_ID,
			env.CLOUDFLARE_API_TOKEN
		);
		const memoryResult = await publishPost(
			env.BLOG_BUCKET,
			memoryPost,
			env.CF_ZONE_ID,
			env.CLOUDFLARE_API_TOKEN
		);
		
		if (result.success && memoryResult.success) {
			console.log('[Daily Blog] ✅ Published:', result.url);
			console.log('[Daily Blog] ✅ Memory digest:', memoryResult.url);
			console.log('[Daily Blog] Title:', post.title);
		} else {
			console.error('[Daily Blog] ❌ Failed:', result.error || memoryResult.error);
		}
	} catch (error) {
		console.error('[Daily Blog] Error:', error instanceof Error ? error.message : String(error));
	}
};

export default Sentry.withSentry(
	(env) => ({
		dsn: "https://3ea9dcc0e77f53522038e2d7ad013bbb@o4510882133049344.ingest.us.sentry.io/4510882137767936",
		sendDefaultPii: true,
	}),
	{
		fetch: app.fetch as any,
		scheduled: scheduled as any
	}
);

// Export workflow classes for Cloudflare Workflows binding
export { BlogWorkflow } from './workflows/blog-workflow';
