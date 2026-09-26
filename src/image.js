/**
 * Image input, in one place.
 *
 * Two callers need the same answer to "turn this image reference into an Agent
 * API content part": the `web_search` provider (`src/index.js`), which can only
 * see an image because `dsh-tool-web` hands it `request.query` as text, and the
 * `perplexity_research` tool (`src/research.js`), which takes an image as an
 * explicit tool argument. Extracting the read guards, the format sniffing, the
 * content-part assembly, and the marker here is what keeps the two from
 * disagreeing about what a refusal is or what a request looks like.
 *
 * Two resolution policies share one implementation:
 *
 * - {@link classifyImageQuery} is the provider's lenient one: a query that is
 *   not an image is ordinary search text, and a path that does not exist is
 *   simply text.
 * - {@link resolveImageAttachment} is the tool's strict one: the caller asked
 *   for *this* image, so anything that is not a readable, allowed image is a
 *   refusal rather than a silent fallback to text.
 *
 * Both end in the same read guards and the same {@link imageRequestBody}.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { WebError } from '@deepseek-ai/dsh-web'
import { isImageInputEnabled } from './shared.js'

/**
 * Per-image byte ceiling. Perplexity's own base64 limit is 50 MB.
 *
 * An image request carries no model of its own: measured against the Agent API,
 * a preset's own model reads images correctly (`preset: fast` answers an image
 * question with `openai/gpt-5.6-luna` and the right answer), so image and text
 * requests share one model selector and cannot disagree.
 */
export const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** Media types Perplexity accepts as an inline image. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Media type selected by a file extension, for an extension that names an image. */
export const IMAGE_MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
})

/** Extension of each allowed media type, used in the refusal messages. */
export const IMAGE_EXTENSION_BY_MEDIA_TYPE = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
})

/** A local image path candidate: the leading character of a filesystem path. */
export const LOCAL_IMAGE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/
/** A candidate image URL: public HTTPS with a recognized image extension. */
export const IMAGE_URL_PATTERN = /^https:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i

/**
 * Prefix of the machine-readable image line prepended to `content`. Like
 * `DEGRADED_MARKER_PREFIX`, this is the only route for the `images` object on
 * the seam result into `dsh-tool-web`'s closed `web_search` output schema, and
 * the line a `perplexity_research` caller reads to confirm what was analyzed.
 */
export const IMAGE_MARKER_PREFIX = '[IMAGE] '

/** Detect an image media type from leading bytes, independent of any extension. */
export function sniffImageMediaType(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const gif = String.fromCharCode(...bytes.subarray(0, 6))
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

/** True when `path` is inside one of the configured roots, or no roots are set. */
export function isWithinImageRoots(path, roots) {
  if (roots.length === 0) return true
  return roots.some((root) => {
    const candidate = relative(root, path)
    return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
  })
}

/**
 * Read one local image query and turn it into a data URI.
 *
 * @param {string} path - the query, read as a filesystem path.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{kind: 'image', mediaType: string, dataUri: string, bytes: number}>}
 *   the inline image, or `{kind: 'text'}` when the path is not an image at all.
 * @throws {WebError} when the path names a file that is refused - outside
 *   `imageRoots`, over `imageMaxBytes`, or not the image format its extension
 *   claims. A refusal is never silent: shipping a non-image file to Perplexity
 *   is exactly what the checks exist to prevent.
 */
export async function readLocalImageQuery(path, options) {
  const resolvedPath = resolve(path)
  if (!isWithinImageRoots(resolvedPath, options.imageRoots)) {
    throw new WebError(
      `The image query "${path}" is outside the configured imageRoots `
      + `(${options.imageRoots.join(', ')}). Add that directory to `
      + 'web-search-perplexity.imageRoots, or pass a public https image URL instead.',
      'WEB_PROVIDER_ERROR',
    )
  }

  let stats
  try {
    stats = await stat(resolvedPath)
  } catch {
    // Not an existing file: an ordinary text query, not a failed image one.
    return { kind: 'text' }
  }
  if (!stats.isFile()) return { kind: 'text' }
  // The extension is read from the file NAME, not from the whole path:
  // `lastIndexOf('.')` on a path finds a dot in a directory name, so an
  // extensionless image under `C:\shots.v2\` would carry the "extension"
  // `.v2\photo` and be sent as an ordinary text query.
  const fileName = basename(resolvedPath)
  const dot = fileName.lastIndexOf('.')
  const extension = dot > 0 ? fileName.slice(dot).toLowerCase() : ''
  let claimed = IMAGE_MEDIA_TYPE_BY_EXTENSION[extension]
  if (claimed === undefined) {
    // No extension at all can still be an image (normalized attachment objects
    // are content-addressed and carry none); a wrong or non-image extension is
    // an ordinary query, not an image to read.
    if (extension.startsWith('.')) return { kind: 'text' }
    claimed = 'image/png'
  }
  if (stats.size > options.imageMaxBytes) {
    throw new WebError(
      `The image query "${path}" is ${stats.size} bytes, above imageMaxBytes `
      + `(${options.imageMaxBytes}). Lower the image resolution or raise `
      + 'web-search-perplexity.imageMaxBytes (the Perplexity per-image cap is 50 MB).',
      'WEB_PROVIDER_ERROR',
    )
  }
  const bytes = await readFile(resolvedPath)
  const mediaType = sniffImageMediaType(bytes) ?? undefined
  if (mediaType === undefined || mediaType !== claimed) {
    // The path exists and is not confidently this image format: treat an
    // unrecognized file as text rather than shipping an arbitrary document.
    if (extension in IMAGE_MEDIA_TYPE_BY_EXTENSION) {
      throw new WebError(
        `The image query "${path}" has an ${extension} extension but its bytes are not `
        + `${claimed}. Rename the file to its real format, or pass a public https image URL.`,
        'WEB_PROVIDER_ERROR',
      )
    }
    return { kind: 'text' }
  }
  return {
    kind: 'image',
    mediaType,
    dataUri: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`,
    bytes: bytes.length,
  }
}

/**
 * Classify one query as an image to attach or as ordinary search text.
 *
 * The provider's lenient policy: the query is only text the caller typed, so a
 * value that is not an image is search text and a path that does not exist is
 * search text too. An explicit image argument uses
 * {@link resolveImageAttachment} instead.
 *
 * @param {string} query - one `web_search` query.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{kind: 'image', source: string, mediaType?: string, dataUri: string, bytes?: number}
 *   | {kind: 'text'}>} the classification; `dataUri` is the URL itself for a URL image.
 */
export async function classifyImageQuery(query, options) {
  const text = typeof query === 'string' ? query.trim() : ''
  if (text.length === 0) return { kind: 'text' }
  if (IMAGE_URL_PATTERN.test(text)) return { kind: 'image', source: text, dataUri: text }
  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('//')) {
    // A web address never names a local file, whatever its extension.
    return { kind: 'text' }
  }
  const looksLikeLocalPath = LOCAL_IMAGE_PATH_PATTERN.test(text) || isAbsolute(text)
  if (!looksLikeLocalPath) return { kind: 'text' }
  const read = await readLocalImageQuery(text, options)
  return read.kind === 'image' ? { ...read, source: text } : read
}

/**
 * Resolve an explicitly requested image into an attachable content part.
 *
 * This is the strict policy of the `perplexity_research` `image` parameter.
 * The caller named an image on purpose, so there is no fallback to text:
 * everything the provider path refuses is refused here too - a path outside
 * `imageRoots`, a file above `imageMaxBytes`, bytes that are not the format the
 * extension claims - and so is a value that is not an image at all, including a
 * path that does not exist.
 *
 * @param {unknown} value - the tool's `image` argument.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{kind: 'image', source: string, mediaType?: string, dataUri: string, bytes: number}>}
 *   the image to attach; `dataUri` is the URL itself for a URL image, whose
 *   `bytes` is 0 because nothing was uploaded by this plugin.
 * @throws {WebError} when the value is empty, is not an image reference, or
 *   names a file that is missing or refused.
 */
export async function resolveImageAttachment(value, options) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    throw new WebError(
      'The image parameter is empty. Pass the absolute path of a local image file, '
      + 'or a public https image URL, or omit it to run a text-only research call.',
      'WEB_PROVIDER_ERROR',
    )
  }
  // A public https image URL whose path names an image is passed through:
  // Perplexity fetches it server-side, and this plugin never downloads it.
  if (IMAGE_URL_PATTERN.test(text)) return { kind: 'image', source: text, dataUri: text, bytes: 0 }
  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('//')) {
    throw new WebError(
      `The image parameter "${text}" is a web address, but only a public https URL whose `
      + 'path ends in .png/.jpg/.jpeg/.gif/.webp is accepted. Pass such a URL, the absolute '
      + 'path of a local image file, or omit the parameter.',
      'WEB_PROVIDER_ERROR',
    )
  }
  const looksLikeLocalPath = LOCAL_IMAGE_PATH_PATTERN.test(text) || isAbsolute(text)
  if (!looksLikeLocalPath) {
    throw new WebError(
      `The image parameter "${text}" is neither the absolute path of a local image file nor a `
      + 'public https image URL ending in .png/.jpg/.jpeg/.gif/.webp. Pass an absolute path, '
      + 'a public https image URL, or omit the parameter.',
      'WEB_PROVIDER_ERROR',
    )
  }
  // The lenient path treats a missing file as an ordinary query. An explicit
  // image argument cannot: the caller asked for this file, so a typo must be
  // named rather than silently turned into a text-only research run.
  let stats
  try {
    stats = await stat(resolve(text))
  } catch {
    stats = undefined
  }
  if (stats === undefined || !stats.isFile()) {
    throw new WebError(
      `The image parameter "${text}" is not an existing file. Pass the absolute path of a `
      + 'readable image file, or a public https image URL.',
      'WEB_PROVIDER_ERROR',
    )
  }
  const read = await readLocalImageQuery(text, options)
  if (read.kind !== 'image') {
    throw new WebError(
      `The image parameter "${text}" is not a supported image. Images must be PNG, JPEG, GIF, `
      + 'or WEBP, identified from their bytes; pass a supported file or a public https image URL.',
      'WEB_PROVIDER_ERROR',
    )
  }
  return { ...read, source: text }
}

/**
 * Assemble the Agent API message array for one image-bearing call.
 *
 * Shared by both policies so an image request has exactly one shape: the text
 * question first, then one `input_image` part per image.
 *
 * @param {string} question - the text question; when empty, a generic analysis
 *   instruction asks what the image shows.
 * @param {Array<{source: string, dataUri: string, bytes?: number}>} images - the
 *   images to attach, in order.
 * @returns {{body: object, marker: object}} the `input` message array plus its
 *   model-facing marker.
 */
export function imageRequestBody(question, images) {
  const text = typeof question === 'string' ? question.trim() : ''
  const prompt = text.length > 0
    ? text
    : 'Analyze this image and research what it shows using web sources.'
  const marker = {
    images: images.length,
    source: images.map((image) => image.source),
    bytes: images.reduce((total, image) => total + (image.bytes ?? 0), 0),
  }
  return {
    marker,
    body: {
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...images.map((image) => ({ type: 'input_image', image_url: image.dataUri })),
        ],
      }],
    },
  }
}

/**
 * Build the request body for one image-bearing search, separating the text
 * question (a non-image query in the same call) from the attached images.
 *
 * @param {string[]} queries - the queries of one search call.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{body: object, marker: object}|undefined>} the `input` message
 *   array plus its model-facing marker, or `undefined` when this call carries no
 *   image.
 */
export async function buildImageRequest(queries, options) {
  // `options.imageInput` is already the boolean `resolveOptions` produced, but
  // the decision function is applied again so a raw string is accepted too: the
  // request path and the settings projection answer "is image input on?" the
  // same way by construction rather than by two expressions happening to agree.
  if (!isImageInputEnabled(options.imageInput)) return undefined
  const classified = []
  for (const query of queries) classified.push(await classifyImageQuery(query, options))
  const images = classified.filter((item) => item.kind === 'image')
  if (images.length === 0) return undefined
  const textQueries = queries.filter((_, index) => classified[index]?.kind !== 'image')
  return imageRequestBody(textQueries.join('\n').trim(), images)
}

/**
 * Attach the model-facing image marker to a mapped response. `content` is the
 * only field `dsh-tool-web` forwards to the model, so the marker line is what
 * tells it which image was analyzed; the research tool renders its own output
 * but reads the answer from `content` the same way.
 */
export function withImageMarker(mapped, marker) {
  const line = `${IMAGE_MARKER_PREFIX}${JSON.stringify(marker)}`
  return {
    ...mapped,
    content: mapped.content !== undefined && mapped.content.length > 0
      ? `${line}\n\n${mapped.content}`
      : line,
  }
}
