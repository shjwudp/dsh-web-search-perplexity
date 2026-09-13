/**
 * One-off probe: does an Agent API preset pick a model that can actually read
 * an image, or must the request name a vision model itself?
 *
 * Sends the same 256x256 solid-blue PNG three ways and reports, for each: which
 * model answered, whether the colour came back correctly, and how many input
 * tokens were billed (an image adds `(w*h)/750` ~ 87 tokens on top of the text).
 * The model that answered is the decisive field: whatever `model` comes back is
 * what the preset chose.
 */
import { deflateSync } from 'node:zlib'

const apiKey = process.env.PERPLEXITY_API_KEY
if (typeof apiKey !== 'string' || apiKey.length === 0) {
  console.error('PERPLEXITY_API_KEY not set')
  process.exit(2)
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function solidPng(size, [red, green, blue]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3
      raw[at] = red
      raw[at + 1] = green
      raw[at + 2] = blue
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const blue = `data:image/png;base64,${solidPng(256, [20, 120, 220]).toString('base64')}`
const question = 'What single colour fills this image? Answer with the colour name only.'

const cases = [
  ['preset fast, no model', { preset: 'fast' }],
  ['preset low, no model', { preset: 'low' }],
  ['preset medium, no model', { preset: 'medium' }],
  ['explicit vision model, no preset', { model: 'openai/gpt-5.4' }],
  ['preset fast + explicit vision model', { preset: 'fast', model: 'openai/gpt-5.4' }],
]

for (const [label, selectors] of cases) {
  const body = {
    ...selectors,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: question },
        { type: 'input_image', image_url: blue },
      ],
    }],
    tools: [{ type: 'web_search' }],
  }
  const started = Date.now()
  try {
    const response = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      console.log(`\n${label}: HTTP ${response.status} in ${Date.now() - started}ms`)
      console.log(`  ${text.slice(0, 240)}`)
      continue
    }
    const parsed = JSON.parse(text)
    const answer = (parsed.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((block) => block.type === 'output_text')
      .map((block) => block.text)
      .join(' ')
      .trim()
    console.log(`\n${label}: HTTP 200 in ${Date.now() - started}ms`)
    console.log(`  answered by model : ${parsed.model}`)
    console.log(`  input tokens      : ${parsed.usage?.input_tokens} (text-only baseline is ~30-60)`)
    console.log(`  request had tools : ${JSON.stringify(parsed.tools)}`)
    console.log(`  answer            : ${answer.slice(0, 120)}`)
  } catch (error) {
    console.log(`\n${label}: transport failure: ${String(error).slice(0, 200)}`)
  }
}
