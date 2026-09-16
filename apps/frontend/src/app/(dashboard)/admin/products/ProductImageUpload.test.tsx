import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductImageUpload } from './ProductImageUpload'

const file = (name: string, type: string, sizeBytes = 1024) => {
  const f = new File(['x'.repeat(16)], name, { type })
  // jsdom takes File.size from the content; override it to test the size guard
  // without allocating megabytes.
  Object.defineProperty(f, 'size', { value: sizeBytes })
  return f
}

const calls = () => vi.mocked(fetch).mock.calls as [string, RequestInit | undefined][]
/** Every request that was not the gallery GET the component makes on mount. */
const writes = () =>
  calls().filter((call): call is [string, RequestInit] => {
    const method = call[1]?.method
    return method !== undefined && method !== 'GET'
  })
/** The last of those, or a failure that names what was missing. */
const lastWrite = (): [string, RequestInit] => {
  const all = writes()
  if (all.length === 0) throw new Error('no write request was made')
  return all[all.length - 1]
}

const fileInput = () => screen.getByLabelText(/image file/i, { selector: 'input[type="file"]' })
/** The description for the picture about to be uploaded, not one already in the gallery. */
const newAltInput = () => screen.getByLabelText(/^image description \*?$/i)

/** Describe the picture first — the control refuses to upload without it. */
const describeIt = async (user: ReturnType<typeof userEvent.setup>, text = 'Traffic graphs') => {
  await user.type(newAltInput(), text)
}

/** The gallery the SERVER hands over, and that `load()` re-reads after a change. */
const gallery = (images: { id: number; alt: string }[] = []) =>
  images.map((image, position) => ({ ...image, position, mime: 'image/png' }))

/**
 * fetch that answers the initial gallery GET and treats everything else as a
 * successful write. Individual tests override the write with mockResolvedValueOnce
 * or by inspecting the call.
 */
let serverGallery: ReturnType<typeof gallery> = []

const renderUpload = (props: { onChanged?: () => void; productId?: number } = {}) => {
  const { productId = 7, ...rest } = props
  return render(<ProductImageUpload productId={productId} initial={serverGallery} {...rest} />)
}

const stubFetch = (images: { id: number; alt: string }[] = []) => {
  serverGallery = gallery(images)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify(gallery(images)), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 1, mime: 'image/png', position: 0 }), { status: 201 })
    }),
  )
}

beforeEach(() => {
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProductImageUpload — uploading', () => {
  it('appends the chosen file as multipart, through the proxy and with no token', async () => {
    const user = userEvent.setup()
    renderUpload()
    await describeIt(user)

    await user.upload(fileInput(), file('p.png', 'image/png'))

    await waitFor(() => expect(writes()).not.toHaveLength(0))
    const [url, init] = lastWrite()
    // Through this origin's proxy, which attaches the credential server-side —
    // the browser holds no API token at all (#146).
    expect(url).toContain('/api/proxy/api/admin/products/7/images')
    // POST, not PUT: a gallery is appended to, not overwritten (#107).
    expect(init.method).toBe('POST')
    expect(init.headers).toBeUndefined()
    // multipart, not base64 JSON: the endpoint reads formData()
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('image')).toBeInstanceOf(File)
  })

  it('refuses a file over 10 MB without uploading it', async () => {
    const user = userEvent.setup()
    renderUpload()
    await describeIt(user)

    await user.upload(fileInput(), file('huge.png', 'image/png', 11 * 1024 * 1024))

    expect(await screen.findByRole('alert')).toHaveTextContent(/11\.0 MB/)
    expect(writes()).toHaveLength(0)
  })

  it("shows the server's reason when it refuses the file", async () => {
    // Named and typed as a PNG so it passes the input's `accept` filter — which
    // is exactly how a file reaches the server and fails there: `accept` goes by
    // the declared type, the server goes by the bytes.
    const user = userEvent.setup()
    renderUpload()
    await describeIt(user)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unsupported image type — allowed: image/png' }), { status: 415 }),
    )

    await user.upload(fileInput(), file('a.png', 'image/png'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/unsupported image type/i)
  })

  it('sends the description with the file', async () => {
    const user = userEvent.setup()
    renderUpload()
    await describeIt(user, 'Dashboard with traffic graphs')

    await user.upload(fileInput(), file('p.png', 'image/png'))
    await waitFor(() => expect(writes()).not.toHaveLength(0))

    const body = lastWrite()[1].body as FormData
    expect(body.get('alt')).toBe('Dashboard with traffic graphs')
  })

  it('refuses to upload an undescribed image', async () => {
    // WCAG 1.1.1: an empty alt claims the picture carries no information, and only
    // the person uploading it can make that claim.
    const user = userEvent.setup()
    renderUpload()

    await user.upload(fileInput(), file('p.png', 'image/png'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/describe what the image shows/i)
    expect(writes()).toHaveLength(0)
  })

  it('clears the description after a successful upload', async () => {
    // The next picture is a different picture; reusing the text is how a gallery
    // ends up with the same alt on every image.
    const user = userEvent.setup()
    renderUpload()
    await describeIt(user, 'The front of it')

    await user.upload(fileInput(), file('p.png', 'image/png'))

    await waitFor(() => expect(newAltInput()).toHaveValue(''))
  })

  it('reports a network failure instead of looking successful', async () => {
    const user = userEvent.setup()
    renderUpload()
    await describeIt(user)
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))

    await user.upload(fileInput(), file('p.png', 'image/png'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/upload failed/i)
  })

  it('notifies the parent only after a successful change', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    renderUpload({ onChanged })
    await describeIt(user)

    await user.upload(fileInput(), file('p.png', 'image/png'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))

    await describeIt(user, 'Another one')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 415 }))
    await user.upload(fileInput(), file('p2.png', 'image/png'))
    await screen.findByRole('alert')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('ProductImageUpload — an existing gallery', () => {
  const two = [
    { id: 11, alt: 'The front of it' },
    { id: 12, alt: 'The back of it' },
  ]

  it('lists the pictures it already has, with their descriptions', async () => {
    stubFetch(two)
    renderUpload({ productId: 9 })

    expect(await screen.findByDisplayValue('The front of it')).toBeInTheDocument()
    expect(screen.getByDisplayValue('The back of it')).toBeInTheDocument()
  })

  it('saves a changed description without re-uploading the file', async () => {
    stubFetch(two)
    const user = userEvent.setup()
    renderUpload({ productId: 9 })

    const field = await screen.findByDisplayValue('The front of it')
    await user.clear(field)
    await user.type(field, 'A clearer description')
    await user.tab()

    await waitFor(() => expect(writes()).not.toHaveLength(0))
    const [url, init] = lastWrite()
    expect(url).toContain('/api/admin/products/9/images/11')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ alt: 'A clearer description' })
  })

  it('refuses to save an empty description', async () => {
    stubFetch(two)
    const user = userEvent.setup()
    renderUpload({ productId: 9 })

    const field = await screen.findByDisplayValue('The front of it')
    await user.clear(field)
    await user.tab()

    expect(await screen.findByRole('alert')).toHaveTextContent(/description is required/i)
    expect(writes()).toHaveLength(0)
  })

  it('removes one picture with a DELETE naming it', async () => {
    stubFetch(two)
    const user = userEvent.setup()
    renderUpload({ productId: 12 })

    await user.click(await screen.findByRole('button', { name: /remove: the back of it/i }))

    await waitFor(() => expect(writes()).not.toHaveLength(0))
    const [url, init] = lastWrite()
    expect(url).toContain('/api/admin/products/12/images/12')
    expect(init.method).toBe('DELETE')
  })

  it('reorders by sending the whole order, with the two pictures swapped', async () => {
    // The endpoint refuses a partial list, so "move down" is a complete order —
    // which is also what keeps a reorder from half-applying.
    stubFetch(two)
    const user = userEvent.setup()
    renderUpload({ productId: 4 })

    await user.click(await screen.findByRole('button', { name: /move down: the front of it/i }))

    await waitFor(() => expect(writes()).not.toHaveLength(0))
    const [url, init] = lastWrite()
    expect(url).toContain('/api/admin/products/4/images')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ order: [12, 11] })
  })

  it('cannot move the first picture up or the last one down', async () => {
    stubFetch(two)
    renderUpload({ productId: 4 })

    expect(await screen.findByRole('button', { name: /move up: the front of it/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /move down: the back of it/i })).toBeDisabled()
  })

  it('says so, rather than showing an empty list, when the gallery cannot be loaded', async () => {
    // The reason comes from the server now (#462) — an empty gallery and one
    // that could not be read are different facts, and only the first is
    // something to act on by uploading.
    render(<ProductImageUpload productId={9} initial={[]} initialError="HTTP 500: Bad Gateway" />)

    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500: Bad Gateway')
  })

  it('shows no alert when the gallery is simply empty', async () => {
    renderUpload({ productId: 9 })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('still reports a gallery re-read that fails after a change', async () => {
    // `load()` stays for the reload after an upload or a delete, and its failure
    // is still the component's to report.
    const user = userEvent.setup()
    stubFetch([{ id: 11, alt: 'The front of it' }])
    renderUpload({ productId: 9 })

    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
      !init?.method || init.method === 'GET'
        ? new Response(null, { status: 500 })
        : new Response(JSON.stringify({}), { status: 200 })))
    await user.click(screen.getAllByRole('button', { name: /remove/i })[0])

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load the gallery/i)
  })
})
