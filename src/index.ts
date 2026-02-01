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

// Helper: Fetch from R2 with cache
async function fetchFromR2(
	bucket: R2Bucket,
	key: string,
	cache: Cache,
	ttl = 3600
): Promise<string | null> {
	const cacheKey = new Request(`https://cache/${key}`);

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
	${metaTags}
	<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { 
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
			line-height: 1.6;
			color: #333;
			background: #f5f5f5;
			padding: 20px;
		}
		.container { 
			max-width: 800px; 
			margin: 0 auto; 
			background: white;
			padding: 40px;
			border-radius: 8px;
			box-shadow: 0 2px 8px rgba(0,0,0,0.1);
		}
		header { margin-bottom: 40px; }
		h1 { font-size: 2.5rem; margin-bottom: 10px; color: #111; }
		h2 { font-size: 2rem; margin: 30px 0 15px; color: #222; }
		h3 { font-size: 1.5rem; margin: 25px 0 10px; color: #333; }
		a { color: #0066cc; text-decoration: none; }
		a:hover { text-decoration: underline; }
		.post-meta { color: #666; font-size: 0.9rem; margin-bottom: 20px; }
		.tag { 
			background: #e8f4f8;
			color: #0066cc;
			padding: 4px 12px;
			border-radius: 4px;
			font-size: 0.85rem;
			margin-right: 8px;
			display: inline-block;
		}
		.post-list { list-style: none; }
		.post-item { 
			margin-bottom: 30px;
			padding-bottom: 30px;
			border-bottom: 1px solid #eee;
		}
		.post-item:last-child { border-bottom: none; }
		.post-title { font-size: 1.5rem; margin-bottom: 8px; }
		.nav { margin-bottom: 30px; }
		.nav a { margin-right: 20px; }
		img { max-width: 100%; height: auto; border-radius: 4px; }
		pre { 
			background: #1e1e1e;
			padding: 16px;
			border-radius: 6px;
			overflow-x: auto;
			margin: 20px 0;
		}
		code { 
			font-family: 'Courier New', monospace;
			font-size: 0.9rem;
		}
		p { margin: 15px 0; }
		ul, ol { margin: 15px 0 15px 30px; }
		blockquote {
			border-left: 4px solid #0066cc;
			padding-left: 20px;
			margin: 20px 0;
			color: #555;
			font-style: italic;
		}
	</style>
</head>
<body>
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

// 404 handler
app.notFound((c) => {
	return c.html(
		renderPage('404 - Not Found', '<h1>404 - Not Found</h1><p>The page you are looking for does not exist.</p>'),
		404
	);
});

export default app;
