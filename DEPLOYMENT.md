# Deployment Guide

## Initial Setup

1. **Create R2 Bucket**
   ```bash
   npx wrangler r2 bucket create minte-blog-prod
   ```

2. **Upload Sample Data**
   ```bash
   # Upload index
   npx wrangler r2 object put minte-blog-prod/posts-index.json \
     --file=sample-data/posts-index.json --remote

   # Upload posts
   npx wrangler r2 object put minte-blog-prod/posts/welcome.json \
     --file=sample-data/posts/welcome.json --remote
   ```

3. **Deploy Worker**
   ```bash
   npm run deploy
   ```

4. **Verify Deployment**
   ```bash
   # Check API
   curl https://blog.minte.dev/api/posts

   # Check homepage
   curl https://blog.minte.dev/

   # Check RSS feed
   curl https://blog.minte.dev/rss.xml
   ```

## Custom Domain Setup

The custom domain is configured in `wrangler.jsonc`:

```json
{
  "routes": [
    {
      "pattern": "blog.minte.dev",
      "custom_domain": true
    }
  ]
}
```

When you deploy, Cloudflare automatically:
1. Creates DNS records for the custom domain
2. Provisions SSL certificates
3. Routes traffic to the worker

## Publishing New Posts

### 1. Create Post JSON

```json
{
  "slug": "2026-02-01-my-post",
  "title": "My New Post",
  "description": "Description here",
  "pubDate": "2026-02-01",
  "author": "Flo",
  "tags": ["tag1", "tag2"],
  "draft": false,
  "content": "# Markdown content\n\nYour post here..."
}
```

### 2. Upload to R2

```bash
npx wrangler r2 object put minte-blog-prod/posts/2026-02-01-my-post.json \
  --file=my-post.json --remote
```

### 3. Update Posts Index

Add the post metadata (without content) to `posts-index.json`:

```json
{
  "posts": [
    {
      "slug": "2026-02-01-my-post",
      "title": "My New Post",
      "description": "Description here",
      "pubDate": "2026-02-01",
      "author": "Flo",
      "tags": ["tag1", "tag2"],
      "draft": false
    }
    // ... other posts
  ],
  "tags": {
    "tag1": 1,
    "tag2": 1,
    // ... update tag counts
  }
}
```

### 4. Upload Updated Index

```bash
npx wrangler r2 object put minte-blog-prod/posts-index.json \
  --file=posts-index.json --remote
```

### 5. Verify

The cache will expire after 1 hour, or you can manually purge:

```bash
# Check the new post
curl https://blog.minte.dev/api/posts/2026-02-01-my-post
```

## Updating Existing Posts

Same process - just re-upload the post JSON and wait for cache to expire, or purge manually.

## Cache Management

### Cache TTL
- Default: 1 hour (3600 seconds)
- Configured in `fetchFromR2()` function

### Manual Cache Purge

To force cache refresh, you can:
1. Wait for TTL to expire (1 hour)
2. Use Cloudflare API to purge cache
3. Redeploy the worker (clears all caches)

### Redeploy to Clear Cache

```bash
npm run deploy
```

## Monitoring

### Check Deployment Status

```bash
npx wrangler deployments list
```

### View Logs (Live Tail)

```bash
npx wrangler tail
```

### Analytics

Check Cloudflare dashboard:
- Workers & Pages → minte-blog-worker → Analytics

## Rollback

If a deployment has issues:

```bash
# List deployments
npx wrangler deployments list

# Rollback to previous version
npx wrangler rollback [version-id]
```

## Environment Variables

Currently none required, but if needed:

```bash
# Set secret
npx wrangler secret put SECRET_NAME

# Add to wrangler.jsonc
{
  "vars": {
    "PUBLIC_VAR": "value"
  }
}
```

## Troubleshooting

### Posts Not Showing

1. Check R2 bucket has the files:
   ```bash
   # This requires using Cloudflare dashboard or API
   # Wrangler doesn't have a list command yet
   ```

2. Check posts-index.json format

3. Verify `draft: false` in post metadata

### Custom Domain Not Working

1. Check DNS propagation (can take up to 48h)
2. Verify domain is in Cloudflare account
3. Check wrangler.jsonc routes configuration

### 404 Errors

1. Ensure post slug matches filename
2. Check R2 path: `posts/[slug].json`
3. Verify posts-index.json includes the post

### Slow Performance

1. Check cache is working (should see fast responses after first load)
2. Verify R2 bucket is in same region
3. Check Cloudflare analytics for edge hit rate

## Production Checklist

- [x] R2 bucket created (`minte-blog-prod`)
- [x] Sample posts uploaded
- [x] Worker deployed
- [x] Custom domain configured (`blog.minte.dev`)
- [x] SSL certificate auto-provisioned
- [x] Cache working (1-hour TTL)
- [x] RSS feed accessible
- [x] API endpoints working
- [x] Tag filtering functional
- [x] Markdown rendering with syntax highlighting

## Next Steps

1. Create a publishing script to automate post uploads
2. Set up CI/CD for automatic deployments
3. Add monitoring/alerting
4. Implement analytics tracking
5. Create backup strategy for R2 content
