import { embed, embedMany } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PROXY_URL, proxyHeaders, requireEnv, log, success, error } from './config';

const apiKey = requireEnv('GOOGLE_GENERATIVE_AI_API_KEY');

const google = createGoogleGenerativeAI({
  baseURL: `${PROXY_URL}/google/v1beta`,
  apiKey,
  headers: proxyHeaders,
});

const EMBED_MODEL_ID = 'gemini-embedding-001';
const embedModel = google.textEmbeddingModel(EMBED_MODEL_ID);

async function testEmbedSingle() {
  log('Google', `Testing embed (single, ${EMBED_MODEL_ID})...`);
  const start = Date.now();

  try {
    const result = await embed({
      model: embedModel,
      value: 'Trace Flow proxies LLM traffic and captures observability data.',
    });

    const duration = Date.now() - start;
    const dim = result.embedding.length;
    const tokens = result.usage?.tokens;
    success('Google', `Embed complete (${duration}ms, ${dim} dims, ${tokens ?? '?'} tokens)`);
    if (dim === 0) {
      error('Google', 'Embedding had zero dimensions');
      return false;
    }
    return true;
  } catch (e: unknown) {
    error('Google', `Embed failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function testEmbedBatch() {
  log('Google', `Testing embedMany (batch, ${EMBED_MODEL_ID})...`);
  const start = Date.now();

  try {
    const result = await embedMany({
      model: embedModel,
      values: [
        'The quick brown fox jumps over the lazy dog.',
        'Pack my box with five dozen liquor jugs.',
        'Sphinx of black quartz, judge my vow.',
      ],
    });

    const duration = Date.now() - start;
    const count = result.embeddings.length;
    const dim = result.embeddings[0]?.length ?? 0;
    const tokens = result.usage?.tokens;
    success(
      'Google',
      `EmbedMany complete (${duration}ms, ${count} vectors x ${dim} dims, ${tokens ?? '?'} tokens)`,
    );
    if (count !== 3 || dim === 0) {
      error('Google', `Unexpected shape: ${count} vectors, ${dim} dims`);
      return false;
    }
    return true;
  } catch (e: unknown) {
    error('Google', `EmbedMany failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Google Gemini Embeddings Proxy Test');
  console.log(`Proxy URL: ${PROXY_URL}/google/v1beta`);
  console.log(`Model:     ${EMBED_MODEL_ID}`);
  console.log('='.repeat(50));

  const results = await Promise.all([testEmbedSingle(), testEmbedBatch()]);
  const passed = results.every(Boolean);

  console.log(`\n${passed ? '✓ All tests passed' : '✗ Some tests failed'}`);
  console.log(
    `\nVerify in Tinybird/dashboard: traces should show provider=google, operation=embeddings, model=${EMBED_MODEL_ID} (not "unknown").`,
  );
  process.exit(passed ? 0 : 1);
}

void main();
