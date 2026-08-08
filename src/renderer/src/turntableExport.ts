/** 将多帧静图录成循环 WebM（Chromium MediaRecorder，无 ffmpeg）。 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to load a turntable frame'))
    image.src = src
  })
}

function pickMimeType(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return 'video/webm'
}

export async function exportTurntableWebm(options: {
  frameDataUrls: string[]
  /** 每帧停留毫秒 */
  frameMs?: number
  /** 完整循环圈数 */
  loops?: number
  width?: number
  height?: number
}): Promise<Blob> {
  const frames = options.frameDataUrls.filter(Boolean)
  if (frames.length < 2) throw new Error('At least 2 angles are required to export a turntable video')
  if (typeof MediaRecorder === 'undefined') throw new Error('Video recording is not supported in this environment')

  const images = await Promise.all(frames.map((src) => loadImage(src)))
  const width = Math.max(2, Math.round(options.width || images[0].naturalWidth || 1024))
  const height = Math.max(2, Math.round(options.height || images[0].naturalHeight || 1024))
  const frameMs = Math.max(40, Number(options.frameMs || 120))
  const loops = Math.max(1, Math.round(options.loops || 3))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Unable to create the canvas')

  const stream = canvas.captureStream(Math.min(30, Math.round(1000 / frameMs)))
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('Recording failed'))
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType.includes('webm') ? 'video/webm' : mimeType })
      if (!blob.size) reject(new Error('The exported video is empty'))
      else resolve(blob)
    }
  })

  recorder.start(200)

  const sequence = Array.from({ length: loops }, () => images).flat()
  for (const image of sequence) {
    ctx.fillStyle = '#f4f4f5'
    ctx.fillRect(0, 0, width, height)
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight)
    const drawW = image.naturalWidth * scale
    const drawH = image.naturalHeight * scale
    ctx.drawImage(image, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH)
    await new Promise((resolve) => window.setTimeout(resolve, frameMs))
  }

  recorder.stop()
  for (const track of stream.getTracks()) track.stop()
  return stopped
}
