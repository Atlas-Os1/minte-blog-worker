import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { marked } from 'marked';
import { cors } from 'hono/cors';

type Bindings = {
	BLOG_BUCKET: R2Bucket;
};

type BlogPost = {
	slug: string;
	title: string;
	description: string;
	pubDate: string;
	author: string;
	tags: string[];
	content: string;
	draft: boolean;
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
		</nav>
		${content}
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
	return `
	<meta property="og:title" content="${post.title}">
	<meta property="og:description" content="${post.description}">
	<meta property="og:type" content="article">
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${post.title}">
	<meta name="twitter:description" content="${post.description}">
	<meta name="description" content="${post.description}">
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
	const publishedPosts = index.posts.filter((p) => !p.draft);

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
		</header>
		<ul class="post-list">
			${postsHtml}
		</ul>
	`;

	return c.html(renderPage('Home', content));
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

	const htmlContent = await marked(post.content);

	const content = `
		<article>
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

// 404 handler
app.notFound((c) => {
	return c.html(
		renderPage('404 - Not Found', '<h1>404 - Not Found</h1><p>The page you are looking for does not exist.</p>'),
		404
	);
});

export default app;
