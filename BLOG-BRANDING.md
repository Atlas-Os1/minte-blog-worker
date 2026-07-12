# Blog branding and attachment workflow

## Scope

Every generated blog post should include readable, topic-relevant attachments when it materially discusses a platform or product. The generator uses `src/blog-branding.ts` to detect supported brands from the title, description, tags, and body.

Supported brands currently include:

- Cloudflare
- Hermes Agent / Nous Research
- Photon
- OpenMontage
- GitHub
- Anthropic / Claude
- OpenAI / GPT / Codex

## Asset paths

Reusable source assets live in R2 under:

```text
assets/brands/<brand>/...
```

The checked-in source bundle is under:

```text
manual-post-assets/brand-library/
```

`brand-manifest.json` records the source URL and usage notes for every reusable asset.

Post-specific art remains under:

```text
assets/posts/<slug>/...
```

## Generated-post behavior

`src/manual-blog-gen.ts` and `src/workflows/blog-workflow.ts` both call `attachBrandAttachments(...)`. The helper inserts a **Tools in this build** section before the first technical heading, using readable image sizes and explanatory captions. It also records the shared asset paths in the post metadata.

This is intentionally an article-content change, not a renderer/UI redesign.

## Publishing

- Content-only posts use the GitHub **Publish Manual Blog Post** workflow.
- Code changes to the generator/renderer use the normal Worker deployment workflow.
- Never run a Worker deploy for a content-only post.
- After publishing, verify the article page, every referenced asset URL, and any inline video URL with a real HTTP request.
