# Build a Local-First AI Image Generator with Cloudflare Workers AI

A browser prompt is not an image-generation product by itself. The useful part is the request path around it: a small interface, a protected Worker boundary, a validated model call, and a result that comes back as actual image bytes.

That is what we built for Minte AI Academy Episode 001: **Minte Image Lab**, a reproducible Cloudflare Workers AI playground for building and understanding an image-generation application.

<p class="blog-video"><video controls preload="metadata" playsinline width="100%" aria-label="Minte Image Lab Cloudflare Workers AI tutorial"><source src="/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/final-cut.mp4" type="video/mp4">Your browser does not support inline video playback. <a href="/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/final-cut.mp4">Open the final tutorial video</a>.</video></p>

<p><strong>Prefer YouTube?</strong> <a href="https://youtu.be/h_Qukc8DPIc">Watch the episode on YouTube</a>.</p>

The finished episode is deliberately two-voice. Colt introduces and closes the lesson. Cleo takes the technical middle and walks through the request path, the repository, the AI binding, validation, and the local demo.

## What you will build

The lab has a useful interface rather than a blank prompt field:

- prompt presets for quickly testing different image ideas
- model and image-size controls
- request status so the waiting state is visible
- a generated-image preview
- local browser history
- a download action
- a teaching panel that explains what each part is doing

The application is local-first or temporary by design. That boundary matters. A tutorial can show a real inference request without leaving an unauthenticated public endpoint running after the recording.

![Minte Image Lab tutorial end card](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/hero.jpg)

## Start with the request path

The architecture is small enough to draw on one slide:

![Minte Image Lab request architecture](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/02-architecture.svg)

```text
Browser prompt
    -> POST /api/generate
    -> Worker validation
    -> Workers AI binding
    -> image bytes
    -> browser preview and local history
```

The browser supplies intent. The Worker supplies the boundary. Workers AI supplies the hosted model call. The browser renders the result.

That division is more important than the particular UI. It gives the example a shape that can grow later without putting a platform credential in the browser.

## Why the Worker boundary matters

The browser should not receive a Cloudflare client token or an unrestricted model identifier. The request crosses into the Worker, where the application can check the input before asking the model to do work.

The Worker validates at least three things:

1. The prompt exists and stays within a reasonable size.
2. The selected model is on an allowlist.
3. The requested image dimensions are supported.

These are small checks, but they establish the right habit: a demo still needs a clear input contract.

The Worker then calls the AI binding and returns the decoded image response to the browser. The front end does not need to understand the provider credential or the internal binding. It only needs a stable application route and a predictable image response.

## The Workers AI binding

The important configuration is the AI binding. In this lab it is named `AI`, which makes it available to the Worker as `env.AI`.

![Workers AI binding slide](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/04-binding.svg)

The name must match in both places:

```jsonc
{
  "ai": {
    "binding": "AI"
  }
}
```

And in the Worker code:

```ts
const result = await env.AI.run(model, input);
```

A mismatch between the configuration name and the code property fails before the image model does any useful work. That is why the binding slide belongs in the tutorial: it is a common failure point and an easy thing to verify.

## The request contract

The browser sends a `POST` request to `/api/generate`. A compact version of the Worker route looks like this:

```ts
interface GenerateRequest {
  prompt: string;
  model: string;
  width: number;
  height: number;
}

const ALLOWED_MODELS = new Set([
  "@cf/black-forest-labs/flux-2-klein-4b"
]);

function isValidSize(width: number, height: number): boolean {
  return [512, 768, 1024].includes(width)
    && [512, 768, 1024].includes(height);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.json() as Partial<GenerateRequest>;
    const prompt = typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";
    const model = typeof body.model === "string"
      ? body.model
      : "";
    const width = Number(body.width);
    const height = Number(body.height);

    if (!prompt || prompt.length > 2000) {
      return Response.json({ error: "Prompt is required and bounded" }, { status: 400 });
    }

    if (!ALLOWED_MODELS.has(model)) {
      return Response.json({ error: "Model is not allowed" }, { status: 400 });
    }

    if (!isValidSize(width, height)) {
      return Response.json({ error: "Unsupported image dimensions" }, { status: 400 });
    }

    const result = await env.AI.run(model, {
      prompt,
      width,
      height
    });

    return imageResponseFromWorkersAI(result);
  }
};
```

The exact model contract can change. Check the current Workers AI documentation and the current model response shape before copying an older tutorial implementation into a new project. The durable lesson is the boundary and validation flow, not pretending that a model name is permanent forever.

## Run the lab locally

Clone the public Academy repository and enter the project:

```bash
git clone https://github.com/mintedmaterial/Mintes-Ai-academy.git
cd Mintes-Ai-academy
npm install
npx wrangler login
npm run dev
```

Wrangler will print the local development URL. Open that URL in a browser, check the connection status, and then run a real request from the interface.

Workers AI calls can incur usage charges during development. Local development changes where the front end is served; it does not make model inference automatically free.

The repository includes the reusable shell, the Worker adapter, the episode scripts, the slides, the storyboard, the verification notes, and the troubleshooting guide.

## Generate a real image

The recording starts with an observatory preset and changes the prompt so the result is a real request rather than a canned screenshot.

The prompt used in the episode is:

```text
A cinematic editorial technology illustration of a tiny Cloudflare-orange orbital archive drifting above a midnight ocean planet, translucent solar sails shaped like network nodes, glowing data paths connecting distant islands, crisp black and white geometry, warm orange accents, dramatic rim light, no text, square composition.
```

When you submit the request, there are two separate waits:

1. The browser waits for the Worker route.
2. The Worker waits for the hosted image model.

The interface makes that state visible. When the response returns, the browser turns the image bytes into a preview and saves a local history item.

That is the complete path:

```text
prompt in
  -> Worker boundary
  -> validated model call
  -> image out
  -> browser preview
```

![Request-flow slide](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/05-flow.svg)

## What can go wrong

If the request fails, check these things first:

### 1. The AI binding is missing or misnamed

The configuration name and the `env.AI` property must agree. A spelling mismatch prevents the Worker from reaching the model.

### 2. The model or response contract changed

Cloudflare adds and changes model integrations over time. Confirm that the selected model is available in the account and that the returned image field still has the shape your code expects.

### 3. The request is outside the application contract

Reject missing prompts, oversized prompt data, unsupported dimensions, and model identifiers outside the allowlist before they reach the inference call.

### 4. The development session is authenticated against the account you expect

Wrangler authentication is part of the local setup. Keep account details and authentication screens out of recordings, and never put credentials in the browser bundle.

## The verification mindset

A tutorial should show more than a happy-path screenshot. For this lab, the verification checklist includes:

- the Worker builds and type-checks
- the AI binding name matches the code
- the browser can reach the `/api/generate` route
- a real prompt returns image data
- the result renders in the browser
- local history stores the generated result
- unsupported input fails with a clear response
- the temporary or local inference surface is removed after capture when it is no longer needed

The project is intentionally public and reproducible, but the running inference surface is not meant to be left open without authentication.

## A small Cleo companion

The episode also gave Cleo a motion system for future tutorials. The pet is not part of the Worker request path; it is a visual companion for the production layer.

![Cleo avatar](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/cleo-avatar.png)

<p class="media-caption">The source avatar used to build the Cleo companion.</p>

![Cleo hologram pet animation](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/cleo-hologram-pet.gif)

The current atlas uses mood lighting instead of decorative scan lines:

- cyan for idle
- blue for active work
- white for thinking
- green or gold for success
- red for a critical context state
- amber-magenta for a degraded tool state
- violet for waiting

The motion comes from breathing, bobbing, pulsing, jitter, and small lateral shifts. The asset is packaged as a reusable animated pet and is also available as video-friendly exports:

- [Cleo pet GIF](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/cleo-hologram-pet.gif)
- [Cleo pet MP4](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/cleo-hologram-pet.mp4)
- [Cleo pet WebM overlay](/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/cleo-hologram-pet.webm)

## Watch the complete episode

<p class="blog-video"><video controls preload="metadata" playsinline width="100%" aria-label="Complete Minte Image Lab tutorial"><source src="/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/final-cut.mp4" type="video/mp4">Your browser does not support inline video playback. <a href="/assets/posts/2026-07-19-build-local-first-ai-image-generator-cloudflare-workers-ai/final-cut.mp4">Open the complete MP4</a>.</video></p>

<p><a href="https://youtu.be/h_Qukc8DPIc">Watch the complete episode on YouTube</a>.</p>

The final cut is 8 minutes and 37 seconds. Colt opens and closes the lesson, Cleo narrates the technical middle, and the last avatar scene closes the handoff cleanly.

## Continue with the source

- [Minte AI Academy on GitHub](https://github.com/mintedmaterial/Mintes-Ai-academy)
- [Episode 001 brief](https://github.com/mintedmaterial/Mintes-Ai-academy/blob/main/episodes/cloudflare/001-workers-ai-image-generator/brief.md)
- [Episode 001 research](https://github.com/mintedmaterial/Mintes-Ai-academy/blob/main/episodes/cloudflare/001-workers-ai-image-generator/research.md)
- [Episode 001 Worker source](https://github.com/mintedmaterial/Mintes-Ai-academy/tree/main/src)
- [Cloudflare Workers AI image-generation tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/image-generation-playground/)
- [Cloudflare Workers AI model documentation](https://developers.cloudflare.com/workers-ai/)

## Final takeaway

The useful pattern is not simply “call an image model.” It is:

1. give the browser a clear interface
2. keep the platform boundary in the Worker
3. validate the request before inference
4. call the model through a named binding
5. return predictable image data
6. render and preserve the result locally
7. verify the real path and tear down temporary infrastructure afterward

That pattern is small enough for a first lab and sturdy enough to reuse in the next one.
