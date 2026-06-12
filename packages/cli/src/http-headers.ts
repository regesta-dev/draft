export function cacheControlHasDirective(
  value: string,
  directive: string,
): boolean {
  const expected = directive.trim().toLowerCase()
  if (expected.length === 0) {
    return false
  }

  return cacheControlParts(value).some((part) => {
    const name = part.split('=', 1)[0]?.trim().toLowerCase()
    return name === expected
  })
}

function cacheControlParts(value: string): string[] {
  const parts: string[] = []
  let part = ''
  let quoted = false
  let escaped = false

  for (const character of value) {
    if (escaped) {
      part += character
      escaped = false
      continue
    }

    if (quoted && character === '\\') {
      part += character
      escaped = true
      continue
    }

    if (character === '"') {
      part += character
      quoted = !quoted
      continue
    }

    if (!quoted && character === ',') {
      parts.push(part)
      part = ''
      continue
    }

    part += character
  }

  parts.push(part)
  return parts
}

export interface IsolatedRequestInitOptions {
  accept?: string
  method?: string
}

export function isolatedRequestInit(
  options: IsolatedRequestInitOptions = {},
): RequestInit {
  return {
    cache: 'no-store',
    credentials: 'omit',
    ...(options.accept === undefined
      ? {}
      : {
          headers: {
            accept: options.accept,
          },
        }),
    ...(options.method === undefined ? {} : { method: options.method }),
    redirect: 'error',
  }
}
