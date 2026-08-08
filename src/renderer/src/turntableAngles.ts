/** 水平环绕 8 视角（假转台），不调用 LLM。 */
export const TURNTABLE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const

export type TurntableAngle = (typeof TURNTABLE_ANGLES)[number]

type AngleShot = {
  angle: TurntableAngle
  /** 短名，写入标记便于解析 */
  title: string
  /** 强约束相机描述：模型对「度」不敏感，必须写可见面/朝向 */
  camera: string
  /** 必须看到 / 不该看到 */
  mustSee: string
}

const ANGLE_SHOTS: Record<number, AngleShot> = {
  0: {
    angle: 0,
    title: 'Front',
    camera: 'Straight-on eye-level studio shot: face the center of the product front with no horizontal rotation.',
    mustSee: 'Show the complete front label and primary brand visual; side panels should be nearly invisible. This must not look like a side or rear view.'
  },
  45: {
    angle: 45,
    title: 'Front right · 45°',
    camera: 'Front-right three-quarter view: rotate about 45° clockwise around the product, slightly favoring the right side at eye level.',
    mustSee: 'Keep the front label readable while revealing the right side of the bottle or box. The composition must clearly differ from the front view.'
  },
  90: {
    angle: 90,
    title: 'Right side · 90°',
    camera: 'Straight right-side eye-level view: place the camera directly to the right and aim at the side center, 90° from the front.',
    mustSee: 'Show only the right silhouette and side structure. The front label should be mostly unreadable; do not keep a front-facing composition.'
  },
  135: {
    angle: 135,
    title: 'Rear right · 135°',
    camera: 'Rear-right three-quarter view: move the camera to roughly 135° around the product at eye level.',
    mustSee: 'Show the rear and right-side transition. The front label must not be the visual subject.'
  },
  180: {
    angle: 180,
    title: 'Rear · 180°',
    camera: 'Straight rear eye-level view: face the center of the product back, directly opposite the front.',
    mustSee: 'Show the rear information panel or silhouette; the front label must be completely hidden.'
  },
  225: {
    angle: 225,
    title: 'Rear left · 225°',
    camera: 'Rear-left three-quarter view: move the camera to roughly 225° around the product at eye level.',
    mustSee: 'Show the rear and left-side transition. The composition must clearly read as rear-facing, not front-facing.'
  },
  270: {
    angle: 270,
    title: 'Left side · 270°',
    camera: 'Straight left-side eye-level view: place the camera directly to the left and aim at the side center, 90° from the front.',
    mustSee: 'Show only the left silhouette and side structure. The front label should be mostly unreadable; do not keep a front-facing composition.'
  },
  315: {
    angle: 315,
    title: 'Front left · 315°',
    camera: 'Front-left three-quarter view: rotate about 45° counterclockwise around the product (315°), slightly favoring the left side at eye level.',
    mustSee: 'Keep the front label readable while revealing the left side of the bottle or box. The composition must differ from both the front and right-side views.'
  }
}

export function turntableAngleTitle(angle: number): string {
  return ANGLE_SHOTS[angle]?.title || `${angle}°`
}

export function turntableAngleMarker(angle: number): string {
  return `[TURNTABLE ANGLE ${angle}°]`
}

export function parseTurntableAngle(prompt: string): number | null {
  const match = String(prompt || '').match(/\[TURNTABLE ANGLE\s*(\d+)°/i) || String(prompt || '').match(/【转台视角\s*(\d+)°/)
  if (!match) return null
  const angle = Number(match[1])
  return Number.isFinite(angle) ? angle : null
}

export function buildTurntablePrompt(angle: number, extra = ''): string {
  const shot = ANGLE_SHOTS[angle] || {
    angle: angle as TurntableAngle,
    title: `${angle}°`,
    camera: `Rotate the camera horizontally to the ${angle}° position around the product and shoot at eye level.`,
    mustSee: 'The camera angle must clearly differ from the hero reference.'
  }
  const extras = String(extra || '').trim()
  return [
    turntableAngleMarker(angle),
    'Task: one frame for an e-commerce product turntable. Use the reference only to identify the product and packaging; do not copy its camera angle or composition.',
    `Forced camera for this frame: ${shot.camera}`,
    `Visibility requirements: ${shot.mustSee}`,
    'Keep the same product, packaging design, proportions, and materials. Keep label text as readable as possible; do not turn it into a different product.',
    'Fixed studio setup: light gray or pure white background, soft light, no hands, people, props, clutter, watermark, or split-screen comparison.',
    'Keep camera height and distance consistent across the series; only the horizontal azimuth may change.',
    'Do not output a front composition nearly identical to the reference. If the reference is front-facing, use the required camera position above.',
    extras
  ].filter(Boolean).join('\n')
}
