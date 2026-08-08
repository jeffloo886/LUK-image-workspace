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
    title: '正面',
    camera: '正面平视棚拍：相机正对商品正面中心，光轴垂直于正面标签，无左右偏转。',
    mustSee: '必须完整看到正面主标签与品牌主视觉；左右侧面几乎不可见，绝不是侧视或背面。'
  },
  45: {
    angle: 45,
    title: '右前45度',
    camera: '右前四分之三视角：相机绕商品水平顺时针偏转约45度，略偏右侧，仍平视。',
    mustSee: '正面标签仍清晰可见，同时露出右侧瓶身/盒身；构图明显不同于纯正面。'
  },
  90: {
    angle: 90,
    title: '右侧面',
    camera: '正右侧面平视：相机在商品正右方，光轴对准右侧面中心，与正面成90度。',
    mustSee: '只能看到右侧轮廓与侧面结构，正面主标签基本不可读；绝不能仍是正面构图。'
  },
  135: {
    angle: 135,
    title: '右后135度',
    camera: '右后四分之三视角：相机绕到右后方约135度，平视。',
    mustSee: '主要看到背面与右侧交接，正面主标签不可作为画面主体。'
  },
  180: {
    angle: 180,
    title: '正背面',
    camera: '正背面平视：相机正对商品背面中心，与正面完全相对。',
    mustSee: '必须看到背面信息面/背面轮廓；正面主标签完全不可见。'
  },
  225: {
    angle: 225,
    title: '左后225度',
    camera: '左后四分之三视角：相机绕到左后方约225度，平视。',
    mustSee: '主要看到背面与左侧交接，构图明显是背侧，不是正面。'
  },
  270: {
    angle: 270,
    title: '左侧面',
    camera: '正左侧面平视：相机在商品正左方，光轴对准左侧面中心，与正面成90度。',
    mustSee: '只能看到左侧轮廓与侧面结构，正面主标签基本不可读；绝不能仍是正面构图。'
  },
  315: {
    angle: 315,
    title: '左前315度',
    camera: '左前四分之三视角：相机绕商品水平逆时针偏转约45度（315度），略偏左侧，仍平视。',
    mustSee: '正面标签仍清晰可见，同时露出左侧瓶身/盒身；构图明显不同于纯正面与右侧面。'
  }
}

export function turntableAngleTitle(angle: number): string {
  return ANGLE_SHOTS[angle]?.title || `${angle}°`
}

export function parseTurntableAngle(prompt: string): number | null {
  const match = String(prompt || '').match(/【转台视角\s*(\d+)°/)
  if (!match) return null
  const angle = Number(match[1])
  return Number.isFinite(angle) ? angle : null
}

export function buildTurntablePrompt(angle: number, extra = ''): string {
  const shot = ANGLE_SHOTS[angle] || {
    angle: angle as TurntableAngle,
    title: `${angle}度`,
    camera: `相机绕商品水平旋转到 ${angle} 度位置，平视拍摄。`,
    mustSee: '视角必须与参考主图的相机角度明显不同。'
  }
  const extras = String(extra || '').trim()
  return [
    turntableAngleMarker(angle),
    '任务：电商商品转台单帧。参考图只用于识别「是哪件商品、包装长什么样」，禁止复制参考图的相机角度与构图。',
    `本帧强制相机：${shot.camera}`,
    `可见性要求：${shot.mustSee}`,
    '同一商品、同一包装设计、同一比例与材质；标签文字尽量保持可读，不要改成别的产品。',
    '固定棚拍：浅灰或纯白背景，柔光，无手脚模特、无道具杂物、无水印、无分屏对比图。',
    '镜头高度与距离全系列一致，只允许水平环绕改变方位角。',
    '严禁输出与参考图几乎相同的正面构图；若参考图是正面，本帧必须按上述相机方位改视角。',
    extras
  ].filter(Boolean).join('\n')
}
