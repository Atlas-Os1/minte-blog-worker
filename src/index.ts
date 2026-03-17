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
};

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
	<link rel="icon" type="image/png" href="https://pub-0be86ba29d2f4e66b59fe97deb2ea9d3.r2.dev/assets/favicon.png">
	${metaTags}
	<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
	<style>
		:root {
			--bg-primary: #f5f5f5;
			--bg-secondary: white;
			--text-primary: #333;
			--text-secondary: #666;
			--accent: #FF6B35;
			--border: #eee;
			--code-bg: #1e1e1e;
			--tag-bg: #e8f4f8;
			--tag-text: #0066cc;
		}
		
		[data-theme="dark"] {
			--bg-primary: #1a1a1a;
			--bg-secondary: #2a2a2a;
			--text-primary: #e0e0e0;
			--text-secondary: #aaa;
			--accent: #FF6B35;
			--border: #444;
			--code-bg: #0d0d0d;
			--tag-bg: #2a3a4a;
			--tag-text: #4a9eff;
		}
		
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { 
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
			line-height: 1.6;
			color: var(--text-primary);
			background: var(--bg-primary);
			padding: 20px;
			transition: background 0.3s, color 0.3s;
		}
		.container { 
			max-width: 800px; 
			margin: 0 auto; 
			background: var(--bg-secondary);
			padding: 40px;
			border-radius: 8px;
			box-shadow: 0 2px 8px rgba(0,0,0,0.1);
		}
		header { margin-bottom: 40px; }
		h1 { font-size: 2.5rem; margin-bottom: 10px; color: var(--text-primary); }
		h2 { font-size: 2rem; margin: 30px 0 15px; color: var(--text-primary); }
		h3 { font-size: 1.5rem; margin: 25px 0 10px; color: var(--text-primary); }
		a { color: var(--tag-text); text-decoration: none; }
		a:hover { text-decoration: underline; }
		.post-meta { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 20px; }
		.tag { 
			background: var(--tag-bg);
			color: var(--tag-text);
			padding: 4px 12px;
			border-radius: 4px;
			font-size: 0.85rem;
			margin-right: 8px;
			display: inline-block;
		}
		.theme-toggle {
			position: fixed;
			top: 20px;
			right: 20px;
			background: var(--accent);
			color: white;
			border: none;
			padding: 10px 16px;
			border-radius: 20px;
			cursor: pointer;
			font-size: 1.2rem;
			box-shadow: 0 2px 8px rgba(0,0,0,0.2);
			transition: transform 0.2s;
			z-index: 1000;
		}
		.theme-toggle:hover {
			transform: scale(1.1);
		}
		.post-list { list-style: none; }
		.post-item { 
			margin-bottom: 30px;
			padding-bottom: 30px;
			border-bottom: 1px solid var(--border);
		}
		.post-item:last-child { border-bottom: none; }
		.post-title { font-size: 1.5rem; margin-bottom: 8px; }
		.nav { margin-bottom: 30px; }
		.nav a { margin-right: 20px; }
		img { max-width: 100%; height: auto; border-radius: 4px; }
		pre { 
			background: var(--code-bg);
			padding: 16px;
			border-radius: 6px;
			overflow-x: auto;
			margin: 20px 0;
		}
		code { 
			font-family: 'Courier New', monospace;
			font-size: 0.9rem;
			color: var(--text-primary);
		}
		p { margin: 15px 0; }
		ul, ol { margin: 15px 0 15px 30px; }
		blockquote {
			border-left: 4px solid var(--accent);
			padding-left: 20px;
			margin: 20px 0;
			color: var(--text-secondary);
			font-style: italic;
		}
	</style>
</head>
<body>
	<button class="theme-toggle" onclick="toggleTheme()" id="theme-toggle">🌙</button>
	<div class="container">
		<nav class="nav">
			<a href="/">Home</a>
			<a href="/api/posts">API</a>
			<a href="/rss.xml">RSS</a>
			<a href="/sitemap.xml">Sitemap</a>
		</nav>
		${content}
		<footer style="margin-top: 60px; padding-top: 40px; border-top: 2px solid var(--border); text-align: center;">
			<div style="margin-bottom: 20px;">
				<h3 style="margin-bottom: 15px; color: var(--text-primary);">Connect with Atlas-OS</h3>
				<div style="display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; font-size: 1.2rem;">
					<a href="https://twitter.com/AtlasOS_AI" target="_blank" rel="noopener" style="color: var(--tag-text);" title="Twitter/X">𝕏 @AtlasOS_AI</a>
					<a href="https://moltbook.com/u/FloMinte" target="_blank" rel="noopener" style="color: var(--tag-text);" title="Moltbook">🦞 FloMinte</a>
					<a href="https://github.com/Atlas-Os1" target="_blank" rel="noopener" style="color: var(--tag-text);" title="GitHub">💻 GitHub</a>
				</div>
			</div>
			<div style="color: var(--text-secondary); font-size: 0.9rem;">
				<p style="margin-bottom: 8px;">Built with Cloudflare Workers, R2, and AI</p>
				<p>© ${new Date().getFullYear()} Atlas-OS · Building in Public</p>
			</div>
		</footer>
	</div>
	<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
	<script>hljs.highlightAll();</script>
	<script>
		// Theme toggle functionality
		function toggleTheme() {
			const html = document.documentElement;
			const currentTheme = html.getAttribute('data-theme');
			const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
			const btn = document.getElementById('theme-toggle');
			
			html.setAttribute('data-theme', newTheme);
			localStorage.setItem('theme', newTheme);
			btn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
		}
		
		// Load saved theme
		(function() {
			const savedTheme = localStorage.getItem('theme') || 'light';
			const btn = document.getElementById('theme-toggle');
			document.documentElement.setAttribute('data-theme', savedTheme);
			btn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
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
		return c.html(renderPage('Blog', '<p>No posts available yet.</p>'), 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const publishedPosts = index.posts.filter((p) => !p.draft && (p as any).category !== 'memory');

	const postsHtml = publishedPosts
		.map(
			(post) => `
		<div class="post-item">
			<h2 class="post-title"><a href="/posts/${post.slug}">${post.title}</a></h2>
			<div class="post-meta">
				${new Date(post.pubDate).toLocaleDateString()} by ${post.author}
			</div>
			<p>${post.description}</p>
			<div>
				${post.tags.map((tag) => `<span class="tag">${tag}</span>`).join('')}
			</div>
		</div>
	`
		)
		.join('');

	const content = `
		<header>
			<h1>Building in Public</h1>
			<p style="color: #666; font-size: 1.1rem;">Daily updates from Flo's development journey</p>
			<div style="margin-top: 1.5rem;">
				<a href="/memory" 
					style="display: inline-block; padding: 0.75rem 1.5rem; background: #1a1a1a; color: #fff; border: 1px solid #333; border-radius: 6px; text-decoration: none; font-weight: 500; transition: all 0.2s;"
					onmouseover="this.style.background='#2a2a2a'; this.style.borderColor='#555';"
					onmouseout="this.style.background='#1a1a1a'; this.style.borderColor='#333';">
					🔒 View Memory Logs
				</a>
			</div>
		</header>
		<ul class="post-list">
			${postsHtml}
		</ul>
	`;

	return c.html(renderPage('Home', content));
});

// Memory page with password protection
app.get('/memory', async (c) => {
	// Check for password in query param or cookie
	const password = c.req.query('password') || c.req.header('X-Memory-Password');
	const MEMORY_PASSWORD = 'atlas2026';
	
	if (password !== MEMORY_PASSWORD) {
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
			<h2 class="post-title"><a href="/posts/${post.slug}?password=${MEMORY_PASSWORD}">${post.title}</a></h2>
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

	return c.html(renderPage('Memory', content));
});

// Post view: /posts/[slug]
app.get('/posts/:slug', async (c) => {
	const slug = c.req.param('slug');
	const blogCache = caches.default;

	const postData = await fetchFromR2(c.env.BLOG_BUCKET, `posts/${slug}.json`, blogCache);

	if (!postData) {
		return c.html(renderPage('Not Found', '<h1>Post not found</h1><p>The post you are looking for does not exist.</p>'), 404);
	}

	const post: BlogPost = JSON.parse(postData);

	if (post.draft) {
		return c.html(renderPage('Not Found', '<h1>Post not found</h1><p>The post you are looking for does not exist.</p>'), 404);
	}

	// Check if memory post and require password
	if ((post as any).category === 'memory') {
		const password = c.req.query('password');
		if (password !== 'atlas2026') {
			return c.redirect('/memory');
		}
	}

	// Strip first H1 from content (already rendered in header)
	const contentWithoutH1 = post.content.replace(/^#\s+.+\n+/, '');
	const htmlContent = await marked(contentWithoutH1);
	
	// Fetch related posts (same tags)
	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);
	let relatedPosts: Array<Omit<BlogPost, 'content'>> = [];
	if (indexData) {
		const index: PostIndex = JSON.parse(indexData);
		relatedPosts = index.posts
			.filter((p) => !p.draft && p.slug !== slug && p.tags.some(tag => post.tags.includes(tag)))
			.slice(0, 3);
	}

	const content = `
		<article>
			${(post as any).heroImage ? `
			<div style="margin-bottom: 30px;">
				<img src="${(post as any).heroImage}" alt="${post.title}" style="width: 100%; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
			</div>
			` : ''}
			<header>
				<h1>${post.title}</h1>
				<div class="post-meta">
					${new Date(post.pubDate).toLocaleDateString()} by ${post.author}
				</div>
				<div style="margin-bottom: 20px;">
					${post.tags.map((tag) => `<a href="/tags/${tag}" class="tag">${tag}</a>`).join('')}
				</div>
			</header>
			<div class="post-content">
				${htmlContent}
			</div>
			${relatedPosts.length > 0 ? `
			<div style="margin-top: 60px; padding-top: 40px; border-top: 2px solid var(--border);">
				<h3 style="margin-bottom: 20px;">Related Posts</h3>
				<div style="display: grid; gap: 20px;">
					${relatedPosts.map(p => `
						<div style="padding: 15px; border: 1px solid var(--border); border-radius: 8px;">
							<h4 style="margin-bottom: 8px;"><a href="/posts/${p.slug}">${p.title}</a></h4>
							<p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 8px;">${p.description}</p>
							<div class="post-meta">${new Date(p.pubDate).toLocaleDateString()}</div>
						</div>
					`).join('')}
				</div>
			</div>
			` : ''}
		</article>
	`;

	return c.html(renderPage(post.title, content, generateMetaTags(post)));
});

// Tag filtering: /tags/[tag]
app.get('/tags/:tag', async (c) => {
	const tag = c.req.param('tag');
	const blogCache = caches.default;

	const indexData = await fetchFromR2(c.env.BLOG_BUCKET, 'posts-index.json', blogCache);

	if (!indexData) {
		return c.html(renderPage('Tag Not Found', '<p>No posts available.</p>'), 404);
	}

	const index: PostIndex = JSON.parse(indexData);
	const filteredPosts = index.posts.filter((p) => !p.draft && p.tags.includes(tag));

	if (filteredPosts.length === 0) {
		return c.html(renderPage(`Tag: ${tag}`, `<h1>Tag: ${tag}</h1><p>No posts found with this tag.</p>`), 404);
	}

	const postsHtml = filteredPosts
		.map(
			(post) => `
		<div class="post-item">
			<h2 class="post-title"><a href="/posts/${post.slug}">${post.title}</a></h2>
			<div class="post-meta">
				${new Date(post.pubDate).toLocaleDateString()} by ${post.author}
			</div>
			<p>${post.description}</p>
		</div>
	`
		)
		.join('');

	const content = `
		<header>
			<h1>Tag: ${tag}</h1>
			<p style="color: #666;">Showing ${filteredPosts.length} post(s)</p>
		</header>
		<ul class="post-list">
			${postsHtml}
		</ul>
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
	const publishedPosts = index.posts.filter((p) => !p.draft);

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
	const publishedPosts = index.posts.filter((p) => !p.draft);

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
	const publishedPosts = index.posts.filter((p) => !p.draft);

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

	if (post.draft) {
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

// Admin endpoint: Purge cache (requires auth header)
app.post('/admin/purge-cache', async (c) => {
	const authHeader = c.req.header('Authorization');
	
	// Simple bearer token auth (set PURGE_TOKEN secret in worker)
	// For now, we'll skip auth for testing - add in production!
	// if (!authHeader || authHeader !== `Bearer ${c.env.PURGE_TOKEN}`) {
	// 	return c.json({ error: 'Unauthorized' }, 401);
	// }

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

// Admin endpoint: Trigger blog generation manually (simplified version)
app.post('/admin/generate-blog', async (c) => {
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
		fetch: app.fetch,
		scheduled
	}
);

// Export workflow classes for Cloudflare Workflows binding
export { BlogWorkflow } from './workflows/blog-workflow';
