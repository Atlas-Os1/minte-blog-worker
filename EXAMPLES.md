# Usage Examples

## Testing Endpoints

### Homepage
```bash
curl https://blog.minte.dev/
```

### Get All Posts (API)
```bash
curl https://blog.minte.dev/api/posts | jq
```

### Get Single Post (API)
```bash
curl https://blog.minte.dev/api/posts/welcome | jq
```

### View Post Page
```bash
curl https://blog.minte.dev/posts/welcome
```

### Filter by Tag
```bash
curl https://blog.minte.dev/tags/cloudflare
```

### RSS Feed
```bash
curl https://blog.minte.dev/rss.xml
```

### Test 404
```bash
curl https://blog.minte.dev/posts/nonexistent
```

## Publishing a New Post

### 1. Create post JSON file

**File:** `my-new-post.json`
```json
{
  "slug": "2026-02-01-my-new-post",
  "title": "My New Post",
  "description": "A short description of the post",
  "pubDate": "2026-02-01",
  "author": "Flo",
  "tags": ["tag1", "tag2"],
  "draft": false,
  "content": "# My New Post\n\nYour markdown content here...\n\n## Section\n\nMore content..."
}
```

### 2. Upload to R2

```bash
npx wrangler r2 object put minte-blog-prod/posts/2026-02-01-my-new-post.json \
  --file=my-new-post.json \
  --remote
```

### 3. Update posts-index.json

Add your post metadata (without content field):

```json
{
  "posts": [
    {
      "slug": "2026-02-01-my-new-post",
      "title": "My New Post",
      "description": "A short description of the post",
      "pubDate": "2026-02-01",
      "author": "Flo",
      "tags": ["tag1", "tag2"],
      "draft": false
    },
    // ... existing posts
  ],
  "tags": {
    "tag1": 1,
    "tag2": 1,
    // ... update tag counts
  }
}
```

### 4. Upload updated index

```bash
npx wrangler r2 object put minte-blog-prod/posts-index.json \
  --file=posts-index.json \
  --remote
```

### 5. Verify

Wait for cache to expire (~1 hour) or check immediately via API:

```bash
curl https://blog.minte.dev/api/posts | jq '.posts[] | select(.slug == "2026-02-01-my-new-post")'
```

## Markdown Examples

### Code Blocks

In your post content:

```json
{
  "content": "# Code Example\n\n```javascript\nconst hello = 'world';\nconsole.log(hello);\n```"
}
```

### Images

```json
{
  "content": "# Image Example\n\n![Alt text](https://example.com/image.jpg)\n\nImages are automatically responsive."
}
```

### Lists

```json
{
  "content": "# Todo List\n\n- [ ] Task 1\n- [x] Task 2\n- [ ] Task 3"
}
```

### Links

```json
{
  "content": "Check out [my website](https://minte.dev) for more info."
}
```

## API Response Examples

### GET /api/posts

```json
{
  "posts": [
    {
      "slug": "welcome",
      "title": "Welcome to Building in Public",
      "description": "First post introducing the blog",
      "pubDate": "2026-01-31",
      "author": "Flo",
      "tags": ["meta", "building-in-public", "welcome"],
      "draft": false
    }
  ],
  "tags": {
    "meta": 1,
    "building-in-public": 2
  },
  "total": 2
}
```

### GET /api/posts/:slug

```json
{
  "slug": "welcome",
  "title": "Welcome to Building in Public",
  "description": "First post introducing the blog",
  "pubDate": "2026-01-31",
  "author": "Flo",
  "tags": ["meta", "building-in-public", "welcome"],
  "draft": false,
  "content": "# Welcome\n\nMarkdown content here..."
}
```

## Automation Script Example

Create `publish.sh` for automated publishing:

```bash
#!/bin/bash
# Usage: ./publish.sh my-post.json

POST_FILE=$1
SLUG=$(jq -r '.slug' "$POST_FILE")

# Upload post
npx wrangler r2 object put "minte-blog-prod/posts/${SLUG}.json" \
  --file="$POST_FILE" \
  --remote

echo "✅ Published: $SLUG"
echo "🌐 Live at: https://blog.minte.dev/posts/$SLUG"
echo ""
echo "⚠️  Remember to update posts-index.json!"
```

Make it executable:
```bash
chmod +x publish.sh
./publish.sh my-new-post.json
```

## RSS Feed Reader Test

Subscribe in your favorite RSS reader:

```
https://blog.minte.dev/rss.xml
```

Or test with curl:

```bash
curl -s https://blog.minte.dev/rss.xml | xmllint --format -
```

## Cache Testing

### Check cache headers

```bash
curl -I https://blog.minte.dev/api/posts
```

Look for: `Cache-Control: public, max-age=3600`

### Force cache miss (after deployment)

```bash
# Redeploy clears all caches
cd /home/flo/minte-blog-worker
npm run deploy
```

## Development Testing

### Local development

```bash
cd /home/flo/minte-blog-worker
npm run dev
```

Then test locally:
```bash
curl http://localhost:8787/
curl http://localhost:8787/api/posts
```

### View logs

```bash
npx wrangler tail
```

Then make requests and watch logs in real-time.

## Performance Testing

### Check response time

```bash
time curl -s https://blog.minte.dev/api/posts > /dev/null
```

### Test from multiple locations

Use a service like [https://www.dotcom-tools.com/](https://www.dotcom-tools.com/) to test global performance.

### Check bundle size

```bash
npm run deploy
# Look for "Total Upload" in output
```

## Monitoring

### Check deployment status

```bash
npx wrangler deployments list
```

### View recent deployments

```bash
npx wrangler deployments list --limit 10
```

### Rollback if needed

```bash
# Get version ID from deployments list
npx wrangler rollback [version-id]
```
