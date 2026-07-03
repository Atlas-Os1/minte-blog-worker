import * as Sentry from "@sentry/cloudflare";
import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { marked } from 'marked';
import { cors } from 'hono/cors';
import { generateBlogPost, publishPost } from './manual-blog-gen';

type Bindings = {
	BLOG_BUCKET: R2Bucket;
	BLOG_WORKFLOW: Workflow;
	CF_ZONE_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	GITHUB_TOKEN: string;
	ADMIN_TOKEN?: string; // Bearer token for admin endpoints
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

function inferProject(post: Omit<BlogPost, 'content'> | BlogPost): ProjectLink {
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

function renderTags(tags: string[]): string {
	return tags.map((tag) => `<a href="/tags/${encodeURIComponent(tag)}" class="tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`).join('');
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
		.brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: -0.03em; }
		.brand-mark { display: grid; place-items: center; width: clamp(96px, 17vw, 128px); height: 42px; padding: 5px 9px; border-radius: 999px; background: white; box-shadow: 0 10px 24px rgba(255, 107, 53, .16); overflow: hidden; flex: 0 0 auto; }
		.brand-mark img { width: 100%; height: 100%; display: block; object-fit: contain; border-radius: 0; }
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
		.hero-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(260px, .8fr); gap: 30px; align-items: center; }
		.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .13em; font-size: .78rem; font-weight: 800; }
		h1 { font-size: clamp(2.45rem, 7vw, 5.6rem); line-height: .92; letter-spacing: -0.075em; margin: 14px 0 18px; }
		h2 { font-size: clamp(1.55rem, 3vw, 2.35rem); line-height: 1.05; letter-spacing: -0.045em; margin: 0 0 16px; }
		h3 { font-size: 1.15rem; line-height: 1.2; margin: 0 0 8px; }
		.lede { font-size: clamp(1.05rem, 2vw, 1.26rem); color: var(--text-secondary); max-width: 68ch; }
		.hero-actions, .project-actions, .post-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
		.btn, .project-actions a, .share-link { display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 10px 15px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-strong); font-weight: 700; }
		.btn.primary { background: linear-gradient(135deg, var(--accent), #fb923c); color: white; border-color: transparent; }
		.btn:hover, .project-actions a:hover, .share-link:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(15,23,42,.12); }
		.hero-panel { display: grid; gap: 12px; padding: 20px; border: 1px solid var(--border); border-radius: 24px; background: var(--surface); }
		.metric { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
		.metric:last-child { border-bottom: 0; }
		.section { margin-top: 44px; }
		.section-heading { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 18px; }
		.section-heading p { color: var(--text-secondary); max-width: 65ch; }
		.project-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
		.project-card { position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; min-height: 220px; padding: 22px; border: 1px solid var(--border); border-radius: 24px; background: var(--surface); transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }
		.project-card::before { content: ''; position: absolute; inset: 0 0 auto; height: 4px; background: var(--project-accent); }
		.project-card:hover { transform: translateY(-5px); border-color: var(--project-accent); box-shadow: 0 18px 50px rgba(15,23,42,.12); }
		.project-card p { color: var(--text-secondary); }
		.project-card.compact { min-height: auto; }
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
		@media (max-width: 640px) { .container { width: min(100% - 20px, 1180px); padding-top: 10px; } .nav { align-items: flex-start; border-radius: 22px; flex-direction: column; } .nav-links { justify-content: flex-start; } .hero, .article-shell { border-radius: 24px; } .section-heading { align-items: start; flex-direction: column; } .card-preview { grid-template-columns: repeat(2, 1fr); } }
	</style>
</head>
<body>
	<div class="progress" id="reading-progress" aria-hidden="true"></div>
	<button class="theme-toggle" onclick="toggleTheme()" id="theme-toggle" aria-label="Toggle theme">🌙</button>
	<div class="container">
		<nav class="nav" aria-label="Primary navigation">
			<a class="brand" href="/" aria-label="Minte Blog home"><span class="brand-mark"><img src="${MINTE_FAVICON_URL}" alt="Minte.dev" width="128" height="42"></span><span>Build Log</span></a>
			<div class="nav-links">
				<a href="/#projects">Projects</a>
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
	const htmlContent = addHeadingIds(await marked(contentWithoutH1));
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
	const object = await c.env.BLOG_BUCKET.get(path);

	if (!object) {
		return c.notFound();
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Cache-Control', 'public, max-age=31536000'); // 1 year cache for assets

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
		
		// Clear specific cache keys
		const keysToPurge = [
			'https://cache/v2/posts-index.json',
			'https://cache/v2/metadata/posts-index.json',
		];

		for (const key of keysToPurge) {
			await blogCache.delete(new Request(key));
		}

		return c.json({ 
			success: true, 
			message: 'Cache purged successfully',
			purged: keysToPurge.length 
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
		// Generate blog post
		const post = await generateBlogPost(c.env.BLOG_BUCKET);
		
		// Publish to R2 + update index + purge cache
		const result = await publishPost(
			c.env.BLOG_BUCKET,
			post,
			c.env.CF_ZONE_ID,
			c.env.CLOUDFLARE_API_TOKEN
		);
		
		if (!result.success) {
			return c.json({ 
				error: 'Blog publish failed', 
				details: result.error 
			}, 500);
		}
		
		return c.json({ 
			success: true, 
			message: 'Blog post generated and published',
			url: result.url,
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
		// Generate blog post from yesterday's memory
		const post = await generateBlogPost(env.BLOG_BUCKET, env.GITHUB_TOKEN);
		
		// Publish to R2 + update index + purge cache
		const result = await publishPost(
			env.BLOG_BUCKET,
			post,
			env.CF_ZONE_ID,
			env.CLOUDFLARE_API_TOKEN
		);
		
		if (result.success) {
			console.log('[Daily Blog] ✅ Published:', result.url);
			console.log('[Daily Blog] Title:', post.title);
		} else {
			console.error('[Daily Blog] ❌ Failed:', result.error);
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
