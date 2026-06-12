export interface ErrorResponse {
  code: string
  error: string
  issues?: string[]
  message: string
}

export interface ImmutableBytesResponseInput {
  bytes: Uint8Array
  cacheControl: string
  contentType: string
  etag: string
  includeBody: boolean
  rangeHeader?: string
}

export interface ImmutableDescriptorHeadersInput {
  cacheControl: string
  contentLength: number
  contentType: string
  etag: string
}

export interface ImmutableDescriptorResponseInput extends ImmutableDescriptorHeadersInput {
  rangeHeader?: string
}

export function errorResponse(
  code: string,
  message: string,
  issues: string[] = [],
): ErrorResponse {
  return {
    code,
    error: message,
    ...(issues.length === 0 ? {} : { issues }),
    message,
  }
}

export function matchesIfNoneMatch(
  header: string | undefined,
  etag: string,
): boolean {
  const normalizedEtag = stripWeakPrefix(etag)

  return (
    ifNoneMatchValues(header).some((value) => {
      return value === '*' || stripWeakPrefix(value) === normalizedEtag
    }) ?? false
  )
}

export function httpDate(timestamp: string): string {
  const time = Date.parse(timestamp)

  if (!Number.isFinite(time)) {
    throw new TypeError('HTTP timestamp must be valid')
  }

  return new Date(time).toUTCString()
}

export function matchesIfModifiedSince(
  header: string | undefined,
  lastModified: string | undefined,
): boolean {
  if (!header || !lastModified) {
    return false
  }

  const since = Date.parse(header)
  const modified = Date.parse(lastModified)

  if (!Number.isFinite(since) || !Number.isFinite(modified)) {
    return false
  }

  return modified <= since
}

export function immutableBytesResponse(
  input: ImmutableBytesResponseInput,
): Response {
  const headers = immutableDescriptorHeaders({
    cacheControl: input.cacheControl,
    contentLength: input.bytes.byteLength,
    contentType: input.contentType,
    etag: input.etag,
  })

  if (!input.rangeHeader) {
    return new Response(input.includeBody ? input.bytes : null, { headers })
  }

  const range = parseSingleByteRange(input.rangeHeader, input.bytes.byteLength)

  if (!range) {
    return new Response(null, {
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${input.bytes.byteLength}`,
      },
      status: 416,
    })
  }

  const bytes = input.bytes.subarray(range.start, range.end + 1)
  headers.set('content-length', String(bytes.byteLength))
  headers.set(
    'content-range',
    `bytes ${range.start}-${range.end}/${input.bytes.byteLength}`,
  )

  return new Response(input.includeBody ? bytes : null, {
    headers,
    status: 206,
  })
}

export function immutableDescriptorHeaders(
  input: ImmutableDescriptorHeadersInput,
): Headers {
  return new Headers({
    'accept-ranges': 'bytes',
    'cache-control': input.cacheControl,
    'content-length': String(input.contentLength),
    'content-type': input.contentType,
    etag: input.etag,
  })
}

export function immutableDescriptorResponse(
  input: ImmutableDescriptorResponseInput,
): Response {
  const headers = immutableDescriptorHeaders(input)

  if (!input.rangeHeader) {
    return new Response(null, { headers })
  }

  const range = parseSingleByteRange(input.rangeHeader, input.contentLength)

  if (!range) {
    return new Response(null, {
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${input.contentLength}`,
      },
      status: 416,
    })
  }

  headers.set('content-length', String(range.end - range.start + 1))
  headers.set(
    'content-range',
    `bytes ${range.start}-${range.end}/${input.contentLength}`,
  )

  return new Response(null, {
    headers,
    status: 206,
  })
}

function stripWeakPrefix(value: string): string {
  return value.startsWith('W/') ? value.slice(2) : value
}

function ifNoneMatchValues(header: string | undefined): string[] {
  if (!header) {
    return []
  }

  const values: string[] = []
  let value = ''
  let quoted = false

  for (const character of header) {
    if (character === '"') {
      value += character
      quoted = !quoted
      continue
    }

    if (!quoted && character === ',') {
      pushIfCompleteEntityTag(values, value)
      value = ''
      continue
    }

    value += character
  }

  pushIfCompleteEntityTag(values, value)
  return values
}

function pushIfCompleteEntityTag(values: string[], value: string): void {
  const trimmed = value.trim()
  if (
    trimmed === '*' ||
    /^W\/"[^"]*"$/u.test(trimmed) ||
    /^"[^"]*"$/u.test(trimmed)
  ) {
    values.push(trimmed)
  }
}

export interface ByteRange {
  end: number
  start: number
}

export function parseSingleByteRange(
  header: string,
  size: number,
): ByteRange | undefined {
  if (size === 0) {
    return undefined
  }

  const trimmed = header.trim()
  if (!trimmed.startsWith('bytes=')) {
    return undefined
  }

  const spec = trimmed.slice('bytes='.length).trim()
  if (spec.includes(',')) {
    return undefined
  }

  const match = /^(\d*)-(\d*)$/u.exec(spec)
  if (!match) {
    return undefined
  }

  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (!startText && !endText) {
    return undefined
  }

  if (!startText) {
    const suffixLength = parseBytePosition(endText)
    if (suffixLength === undefined || suffixLength === 0) {
      return undefined
    }

    return {
      end: size - 1,
      start: Math.max(size - suffixLength, 0),
    }
  }

  const start = parseBytePosition(startText)
  if (start === undefined || start >= size) {
    return undefined
  }

  const end = endText ? parseBytePosition(endText) : size - 1
  if (end === undefined || start > end) {
    return undefined
  }

  return {
    end: Math.min(end, size - 1),
    start,
  }
}

function parseBytePosition(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
