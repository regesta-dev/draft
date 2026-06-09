import { errorResponse } from '../responses.ts'
import type { MiddlewareHandler } from 'hono'

export interface RequestSizeLimitOptions {
  maxBytes?: number
}

const contentLengthPattern = /^(?:0|[1-9]\d*)$/u

export function createRequestSizeLimitMiddleware(
  options: RequestSizeLimitOptions = {},
): MiddlewareHandler {
  validateRequestSizeLimit(options.maxBytes)

  return async (context, next) => {
    if (options.maxBytes === undefined) {
      await next()
      return
    }

    const contentLength = context.req.header('content-length')
    if (contentLength === undefined) {
      await next()
      return
    }

    const requestBytes = parseContentLength(contentLength)
    if (requestBytes === undefined) {
      return context.json(
        errorResponse(
          'request_content_length_invalid',
          'Invalid Content-Length header',
        ),
        400,
      )
    }

    if (requestBytes > options.maxBytes) {
      return context.json(
        errorResponse('request_too_large', 'Request body too large', [
          `content-length: Must be at most ${options.maxBytes} bytes`,
        ]),
        413,
      )
    }

    await next()
  }
}

function validateRequestSizeLimit(maxBytes: number | undefined): void {
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new TypeError(
      'Request byte limit must be a non-negative safe integer',
    )
  }
}

function parseContentLength(value: string): number | undefined {
  if (!contentLengthPattern.test(value)) {
    return undefined
  }

  const length = Number(value)

  return Number.isSafeInteger(length) ? length : undefined
}
