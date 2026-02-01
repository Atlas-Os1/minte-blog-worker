# Minte Blog Worker

A Cloudflare Worker-based blog platform serving content from R2 storage.

**Live at:** https://blog.minte.dev

## Features

✅ **Homepage** - Lists all published posts with metadata and tags  
✅ **Post Rendering** - Markdown to HTML with syntax highlighting  
✅ **Tag Filtering** - `/tags/[tag]` for browsing posts by tag  
✅ **RSS Feed** - Standard RSS 2.0 feed at `/rss.xml`  
✅ **API Endpoints** - JSON API for programmatic access  
✅ **Edge Caching** - Cloudflare Cache API with 1-hour TTL  
✅ **Social Meta Tags** - OpenGraph and Twitter Card support  

## Tech Stack

- **Cloudflare Workers** - Serverless edge computing
- **Hono** - Fast, lightweight web framework
- **R2 Storage** - Object storage for blog posts
- **TypeScript** - Type-safe development
- **marked** - Markdown parser
- **highlight.js** - Code syntax highlighting

## Architecture

```
┌─────────────┐
│   Request   │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Cloudflare Edge │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌──────┐
│ Cache │ │  R2  │
└───────┘ └──────┘
```

1. Request hits Cloudflare edge
2. Worker checks cache (1-hour TTL)
3. On cache miss, fetches from R2
4. Renders markdown to HTML
5. Returns response and caches

## Data Structure

### Posts Index (`posts-index.json`)
```json
{
  "posts": [
    {
      "slug": "welcome",
      "title": "Welcome to Building in Public",
      "description": "Post description",
      "pubDate": "2026-01-31",
      "author": "Flo",
      "tags": ["meta", "building-in-public"],
      "draft": false
    }
  ],
  "tags": {
    "meta": 1,
    "building-in-public": 2
  }
}
```

### Individual Posts (`posts/[slug].json`)
```json
{
  "slug": "welcome",
  "title": "Welcome to Building in Public",
  "description": "Post description",
  "pubDate": "2026-01-31",
  "author": "Flo",
  "tags": ["meta"],
  "draft": false,
  "content": "# Markdown content here..."
}
```

## Routes

- `/` - Homepage with post list
- `/posts/:slug` - Individual post page
- `/tags/:tag` - Posts filtered by tag
- `/rss.xml` - RSS feed
- `/api/posts` - JSON list of all posts
- `/api/posts/:slug` - JSON for single post

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Generate TypeScript types
npm run cf-typegen

# Deploy to production
npm run deploy
```

## R2 Bucket Structure

```
minte-blog-prod/
├── posts-index.json
└── posts/
    ├── welcome.json
    ├── 2026-02-01-blog-worker.json
    └── ...
```

## Uploading Content

```bash
# Upload posts index
npx wrangler r2 object put minte-blog-prod/posts-index.json \
  --file=posts-index.json --remote

# Upload individual post
npx wrangler r2 object put minte-blog-prod/posts/[slug].json \
  --file=posts/[slug].json --remote
```

## Configuration

### wrangler.jsonc
```json
{
  "name": "minte-blog-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-27",
  "r2_buckets": [
    {
      "binding": "BLOG_BUCKET",
      "bucket_name": "minte-blog-prod"
    }
  ],
  "routes": [
    {
      "pattern": "blog.minte.dev",
      "custom_domain": true
    }
  ]
}
```

## Caching Strategy

- **Cache TTL:** 1 hour (3600 seconds)
- **Cache Key:** R2 object path
- **Cache Storage:** Cloudflare Cache API
- **Cache Scope:** Per edge location

This means:
- First request fetches from R2 and caches
- Subsequent requests serve from cache
- Cache expires after 1 hour
- Each edge location maintains its own cache

## Performance

- **Edge deployment:** Global Cloudflare network
- **Cold start:** ~5-10ms
- **Cached response:** ~1-5ms
- **R2 fetch:** ~50-100ms (first request only)

## Future Enhancements

- [ ] Pagination for post lists
- [ ] Search functionality
- [ ] Dark mode toggle
- [ ] Analytics integration
- [ ] Comment system
- [ ] Post images/media from R2
- [ ] Table of contents generation
- [ ] Reading time estimates

## License

MIT
