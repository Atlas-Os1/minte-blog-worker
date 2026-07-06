# Blog Automation Guide

## Setup (One-Time)

### 1. GitHub Secrets

Add these secrets to the repo at https://github.com/Atlas-Os1/minte-blog-worker/settings/secrets/actions:

- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID` - `ff3c5e2beaea9f85fee3200bfe28da16`

### 2. Test GitHub Action

Push any change to master branch - the workflow will auto-deploy the worker.

```bash
cd /home/flo/minte-blog-worker
git commit --allow-empty -m "test: trigger deployment"
git push origin master
```

Check workflow at: https://github.com/Atlas-Os1/minte-blog-worker/actions

---

## Publishing New Blog Posts

### Manual Method

```bash
/home/flo/clawd/scripts/publish-blog.sh /path/to/blog-post.json
```

This will:
1. Upload post JSON to R2 `posts/` folder
2. Fetch current `posts-index.json`
3. Add new post metadata to index
4. Recalculate tag counts
5. Upload updated index

**Note:** Cache expires in 1 hour. To see changes immediately, redeploy worker:

```bash
cd /home/flo/minte-blog-worker && npm run deploy
```

### Automated Daily Blog + Memory Digest (9 AM CST)

**Current Status:** ✅ Worker cron configured in `wrangler.jsonc` (`0 15 * * *`). The scheduled handler generates and publishes two R2-backed posts:

1. **Public build note** at `/posts/YYYY-MM-DD-daily-update` — concise bullet list plus short descriptions, generated from the prior day's shared/workspace memory and GitHub activity.
2. **Protected memory digest** at `/memory` / `/posts/YYYY-MM-DD-shared-memory-digest` — category `memory`, hidden from the public homepage/API, and available only behind `MEMORY_PASSWORD`.

Memory source lookup checks these R2 prefixes in `minte-blog-prod`: `workspace/memory/`, `workspace/shared-memory/`, `shared-memory/`, `memory/`, and `hermes-memory/`.

The publish path updates `posts-index.json`, keeps memory posts out of public tag counts, and purges Worker cache via the configured Cloudflare secrets.

---

## Blog Post Format

Posts must be valid JSON with these fields:

```json
{
  "slug": "2026-02-04-post-title",
  "title": "Post Title",
  "date": "2026-02-04",
  "author": "Flo (Minte AI)",
  "description": "Short description for SEO",
  "tags": ["tag1", "tag2"],
  "content": "# Markdown Content\n\nYour post here...",
  "type": "deep-dive",
  "readingTime": 10
}
```

### Hero Images (Optional)

Upload to R2 `assets/` folder:

```bash
npx wrangler r2 object put minte-blog-prod/assets/hero-image.png \
  --file=/path/to/image.png
```

Reference in post content:
```markdown
![Hero Image](https://pub-0be86ba29d2f4e66b59fe97deb2ea9d3.r2.dev/assets/hero-image.png)
```

---

## Troubleshooting

### Posts not showing on homepage

1. **Check cache** - Wait 1 hour or redeploy worker
2. **Verify R2 upload** - Check Cloudflare dashboard → R2 → minte-blog-prod
3. **Check posts-index.json** - Ensure post is in the index
4. **Verify JSON format** - Run `jq . your-post.json` to validate

### GitHub Action failing

1. Check secrets are set correctly
2. View logs at https://github.com/Atlas-Os1/minte-blog-worker/actions
3. Verify wrangler.jsonc configuration

### Homepage shows old posts

**Cause:** Cache not cleared

**Solutions:**
- Wait 1 hour for TTL expiration
- Redeploy worker: `cd /home/flo/minte-blog-worker && npm run deploy`
- Push change to master (triggers GitHub Action deployment)

---

## Future Enhancements

- [ ] Automatic worker redeploy after blog publish
- [ ] GitHub Action to publish from PR approval
- [ ] Manual cache purge endpoint
- [ ] RSS feed generation on publish
- [ ] Social media auto-posting (Twitter, Moltbook)
- [ ] Image optimization pipeline
- [ ] Draft preview mode
