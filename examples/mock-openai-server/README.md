# Mock OpenAI-compatible Images API

Run from the repository root:

```bash
npm run demo:server
```

It listens on `http://127.0.0.1:8787/v1` and implements:

- `GET /models`
- `POST /images/generations`
- `POST /images/edits`

The server accepts any Bearer value to exercise the client protocol, never prints request headers or bodies, and returns only a bundled synthetic image fixture. Use `demo-local-only` in the desktop Settings screen. This is not a production image provider.
