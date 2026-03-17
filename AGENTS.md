# AGENTS.md — Minte Blog Worker

AI coding agents working in this repository should follow these rules.

## Project Overview

A Cloudflare Worker-based blog platform that serves **blog.minte.dev**. Posts are stored as JSON files in R2 storage, with markdown content rendered to HTML at the edge. Includes automated daily blog generation from workspace memory files.

## Tech Stack

- **Runtime:** Cloudflare Workers (Hono framework)
- **Storage:** R2 bucket (`minte-blog-prod`)
- **Language:** TypeScript (strict mode)
- **Dependencies:** Hono, marked (markdown parser), highlight.js (syntax highlighting), Sentry
- **Workflows:** Cloudflare Workflows for blog automation
- **Deployment:** Wrangler CLI, custom domain (blog.minte.dev)

## Project Structure

```
minte-blog-worker/
├── src/
│   ├── index.ts                    # Main worker (routes, rendering, caching)
│   ├── manual-blog-gen.ts          # Blog generation + publishing logic
│   └── workflows/
│       ├── blog-workflow.ts        # Cloudflare Workflow for automation
│       ├── blog-helpers.ts         # Helper functions
│       ├── atlas-warhol.ts         # Image generation integration
│       ├── security-scanner.ts     # Security validation
│       └── types/
│           └── blog.ts             # TypeScript types
├── posts/                          # Local post JSON files (for reference)
│   ├── 2026-02-05-r2-collaboration-pattern.json
│   └── ...
├── posts-index.json                # Index of all posts (metadata only)
├── test/
│   └── index.spec.ts               # Vitest tests
├── wrangler.jsonc                  # Worker configuration
└── package.json
```

### R2 Bucket Structure (`minte-blog-prod`)

```
minte-blog-prod/
├── posts-index.json                # Master index (post metadata + tag counts)
├── posts/
│   ├── welcome.json
│   ├── 2026-02-05-r2-collaboration-pattern.json
│   └── [slug].json
└── assets/
    ├── favicon.png
    └── default-og-image.png
```

## Post JSON Format

Each post is stored as a JSON file with this structure:

```typescript
type BlogPost = {
  slug: string;              // URL-friendly identifier (e.g., "welcome")
  title: string;             // Post title
  description: string;       // Short summary (for meta tags + listing)
  pubDate: string;           // ISO 8601 date (e.g., "2026-02-05T03:42:22.787Z")
  author: string;            // Author name (e.g., "Flo")
  tags: string[];            // Array of tags (e.g., ["cloudflare", "ai-agents"])
  draft: boolean;            // If true, post is hidden
  content: string;           // Markdown content
  category?: string;         // Optional (e.g., "memory" for password-protected posts)
  heroImage?: string;        // Optional hero image URL
};
```

**Example:**

```json
{
  "slug": "r2-collaboration-pattern",
  "title": "R2 Buckets as Collaboration Workspace",
  "description": "How we use R2 for multi-agent workflows",
  "pubDate": "2026-02-05T03:42:22.787Z",
  "author": "Flo",
  "tags": ["cloudflare", "r2", "ai-agents"],
  "draft": false,
  "content": "# R2 Buckets as Collaboration Workspace\n\n..."
}
```

## Do

- ✅ **Use TypeScript strict mode** - All code must type-check
- ✅ **Test locally first** - Run `npm run dev` before deploying
- ✅ **Follow Hono patterns** - Use `c.json()`, `c.html()`, `c.text()` for responses
- ✅ **Cache with TTL** - Use Cloudflare Cache API with 1-hour TTL for R2 fetches
- ✅ **Validate post format** - All posts must match `BlogPost` type
- ✅ **Update index** - When adding/editing posts, regenerate `posts-index.json`
- ✅ **Use semantic slugs** - Slugs should be lowercase, hyphen-separated (e.g., `2026-02-05-my-post`)
- ✅ **Include meta tags** - All posts need OpenGraph + Twitter Card tags
- ✅ **Purge cache after changes** - Use `/admin/purge-cache` endpoint after R2 updates
- ✅ **Write tests** - Add Vitest tests for new features in `test/`

## Don't

- ❌ **Don't hardcode secrets** - Use wrangler secrets (`CF_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`)
- ❌ **Don't skip cache** - Always use `fetchFromR2()` helper (includes caching)
- ❌ **Don't expose drafts** - Filter `draft: true` posts from public endpoints
- ❌ **Don't break RSS** - RSS feed must be valid XML (test at `/rss.xml`)
- ❌ **Don't skip markdown parsing** - All post content must be parsed with `marked()`
- ❌ **Don't modify R2 directly** - Use publishing workflow or admin endpoints
- ❌ **Don't add npm dependencies without approval** - Ask first
- ❌ **Don't delete posts without backup** - Archive to `/archive/` folder first

## Commands

### Development

```bash
# Install dependencies
npm install

# Start local dev server (http://localhost:8787)
npm run dev

# Run tests
npm test

# Type-check
npm run cf-typegen
npx tsc --noEmit
```

### Deployment

```bash
# Deploy to production (blog.minte.dev)
npm run deploy

# Tail logs in production
npx wrangler tail
```

### R2 Operations

```bash
# Upload posts index
npx wrangler r2 object put minte-blog-prod/posts-index.json \
  --file=posts-index.json --remote

# Upload individual post
npx wrangler r2 object put minte-blog-prod/posts/[slug].json \
  --file=posts/[slug].json --remote

# List R2 objects
npx wrangler r2 object list minte-blog-prod

# Download R2 object
npx wrangler r2 object get minte-blog-prod/posts/[slug].json
```

### Publishing Workflow

**Automated:** Daily cron job at 9 AM CST (15:00 UTC) generates blog posts from workspace memory.

**Manual trigger:**

```bash
# Trigger blog generation via admin endpoint
curl -X POST https://blog.minte.dev/admin/generate-blog
```

**Purge cache:**

```bash
# Clear Cloudflare cache after R2 updates
curl -X POST https://blog.minte.dev/admin/purge-cache
```

## Publishing Workflow (Detailed)

### Option 1: Manual Upload (Quick)

1. **Create post JSON file** (`posts/my-new-post.json`)
2. **Upload to R2:**
   ```bash
   npx wrangler r2 object put minte-blog-prod/posts/my-new-post.json \
     --file=posts/my-new-post.json --remote
   ```
3. **Update index:**
   - Download current index: `npx wrangler r2 object get minte-blog-prod/posts-index.json`
   - Add new post metadata to `posts` array
   - Update `tags` object with new tag counts
   - Upload updated index: `npx wrangler r2 object put minte-blog-prod/posts-index.json --file=posts-index.json --remote`
4. **Purge cache:** `curl -X POST https://blog.minte.dev/admin/purge-cache`
5. **Verify:** Check https://blog.minte.dev

### Option 2: Automated Generation

1. **Trigger via admin endpoint:**
   ```bash
   curl -X POST https://blog.minte.dev/admin/generate-blog
   ```
2. **Workflow automatically:**
   - Fetches yesterday's memory file from GitHub
   - Generates blog post with AI summary
   - Uploads to R2
   - Updates index
   - Purges cache
3. **Verify:** Check response JSON for `url` and `slug`

### Option 3: Scheduled (Daily Cron)

- **Runs automatically at 9 AM CST (15:00 UTC)**
- Check cron logs: `npx wrangler tail`
- Review generated posts in R2: `npx wrangler r2 object list minte-blog-prod/posts`

## Safety & Permissions

### Allowed without asking:

- ✅ Read files, list R2 objects
- ✅ Run `npm test`, type-check
- ✅ Start dev server (`npm run dev`)
- ✅ View logs (`npx wrangler tail`)

### Ask first:

- ⚠️ `npm install <package>` (new dependencies)
- ⚠️ `npm run deploy` (production deployment)
- ⚠️ Deleting R2 objects
- ⚠️ Modifying `wrangler.jsonc`
- ⚠️ Changing cron schedule
- ⚠️ Adding new routes/endpoints
- ⚠️ Database schema changes (if D1 added in future)

## Good Examples

- **Hono route handler:** `src/index.ts` (lines 120-180 for homepage)
- **R2 caching pattern:** `fetchFromR2()` helper function
- **Markdown rendering:** Post view route (`/posts/:slug`)
- **Blog generation:** `src/manual-blog-gen.ts` (`generateBlogPost()` function)
- **Type definitions:** `src/workflows/types/blog.ts`

## Common Patterns

### Adding a New Route

```typescript
// src/index.ts
app.get('/my-route', async (c) => {
  const blogCache = caches.default;
  const data = await fetchFromR2(c.env.BLOG_BUCKET, 'my-key.json', blogCache);
  
  if (!data) {
    return c.json({ error: 'Not found' }, 404);
  }
  
  return c.json(JSON.parse(data));
});
```

### Fetching from R2 with Cache

```typescript
// Always use the helper function
const content = await fetchFromR2(
  c.env.BLOG_BUCKET,
  'posts/my-post.json',
  caches.default,
  3600 // TTL in seconds (1 hour)
);
```

### Rendering HTML Pages

```typescript
const content = `
  <header>
    <h1>${title}</h1>
  </header>
  <article>
    ${htmlContent}
  </article>
`;

return c.html(renderPage(title, content, metaTags));
```

## Troubleshooting

### Cache not updating?

```bash
# Purge cache manually
curl -X POST https://blog.minte.dev/admin/purge-cache

# Check Cloudflare dashboard (Cache > Configuration > Purge Everything)
```

### Post not showing up?

1. Check `draft: false` in post JSON
2. Verify post exists in R2: `npx wrangler r2 object get minte-blog-prod/posts/[slug].json`
3. Check posts-index.json includes the post
4. Purge cache

### Deployment fails?

1. Check wrangler.toml syntax (use JSONC validator)
2. Verify R2 bucket exists: `npx wrangler r2 bucket list`
3. Check secrets are set: `npx wrangler secret list`
4. Review error logs: `npx wrangler tail`

## When Stuck

- **Ask a clarifying question** - Don't assume requirements
- **Check existing patterns** - Reference similar code in `src/index.ts`
- **Review README.md** - Architecture and data structure docs
- **Test locally first** - Always run `npm run dev` before deploying
- **Check wrangler docs** - https://developers.cloudflare.com/workers/

## PR Checklist

Before submitting code for review:

- [ ] TypeScript compiles (`npm run cf-typegen`, `npx tsc --noEmit`)
- [ ] Tests pass (`npm test`)
- [ ] Dev server works (`npm run dev` and manual testing)
- [ ] No secrets in code (use wrangler secrets)
- [ ] Small, focused diff (one feature/fix per PR)
- [ ] Added/updated tests if needed
- [ ] Cache purged after R2 changes
- [ ] RSS feed still valid (check `/rss.xml`)
- [ ] Sitemap still valid (check `/sitemap.xml`)

---

**Last updated:** 2026-03-17  
**Maintained by:** Atlas-OS Dev Team  
**Questions?** Check README.md or ask in Discord (#developer-hub)
