// CSS colors → hex, for baking brand colors into picker previews. Returns null for anything it cannot resolve
// (var(), color-mix(), most named colors), so callers can fall back to reading the CSS themselves.

const NAMED = { white: '#ffffff', black: '#000000', transparent: '#00000000' }
/** A bare "h s% l%" triplet, as shadcn and Tailwind v3 store tokens for hsl(var(--x)). */
export const BARE_HSL = /^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const hex2 = (value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')

function hexFrom(r, g, b, alpha = 1) {
  if (![r, g, b, alpha].every(Number.isFinite)) return null
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return alpha < 1 ? `${base}${hex2(alpha * 255)}` : base
}

/** A number, or a percentage scaled to `full` ("50%" of 255 is 127.5). "none" counts as 0. */
function amount(text, full) {
  if (text === 'none') return 0
  if (text.endsWith('%')) return (parseFloat(text) / 100) * full
  return text.trim() === '' ? NaN : Number(text)
}

const percent = (text) => (text.endsWith('%') ? parseFloat(text) / 100 : Number(text) / 100)

function hue(text) {
  if (text === 'none') return 0
  const match = /^(-?[\d.]+)(deg|turn|rad|grad)?$/.exec(text)
  if (!match) return NaN
  const value = parseFloat(match[1])
  return { turn: value * 360, rad: (value * 180) / Math.PI, grad: value * 0.9 }[match[2]] ?? value
}

/** Splits "a b c / d" or "a, b, c, d" into three components and an alpha between 0 and 1. */
function components(body) {
  const [main, alphaText, extra] = body.split('/')
  if (extra !== undefined) return null
  const comma = main.includes(',')
  let parts = (comma ? main.split(',') : main.trim().split(/\s+/)).map((part) => part.trim()).filter(Boolean)
  let alpha = alphaText === undefined ? 1 : amount(alphaText.trim(), 1)
  if (comma && parts.length === 4 && alphaText === undefined) {
    alpha = amount(parts[3], 1)
    parts = parts.slice(0, 3)
  }
  return parts.length === 3 && Number.isFinite(alpha) ? { parts, alpha: clamp(alpha, 0, 1) } : null
}

function fromHsl(h, s, l, alpha) {
  if (![h, s, l].every(Number.isFinite)) return null
  const hueDegrees = ((h % 360) + 360) % 360
  const saturation = clamp(s, 0, 1)
  const lightness = clamp(l, 0, 1)
  const a = saturation * Math.min(lightness, 1 - lightness)
  const channel = (n) => {
    const k = (n + hueDegrees / 30) % 12
    return (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255
  }
  return hexFrom(channel(0), channel(8), channel(4), alpha)
}

/** OKLab → gamma-encoded sRGB channels (0–255), clamped to the sRGB gamut. */
function fromOklab(L, a, b, alpha) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const [r, g, bl] = linear.map((value) => {
    const c = clamp(value, 0, 1)
    return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255
  })
  return hexFrom(r, g, bl, alpha)
}

function fromHex(value) {
  const digits = value.slice(1)
  if (![3, 4, 6, 8].includes(digits.length)) return null
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits
  const alpha = full.length === 8 ? full.slice(6) : ''
  return `#${full.slice(0, 6)}${alpha === 'ff' ? '' : alpha}`
}

/** '#rrggbb' (or '#rrggbbaa' when translucent) for a CSS color, or null when it cannot be resolved here. */
export function toHex(input) {
  if (typeof input !== 'string') return null
  const value = input.trim().toLowerCase()
  if (NAMED[value]) return NAMED[value]
  if (/^#[0-9a-f]+$/.test(value)) return fromHex(value)
  const bare = BARE_HSL.exec(value)
  if (bare) return fromHsl(Number(bare[1]), Number(bare[2]) / 100, Number(bare[3]) / 100, 1)
  const fn = /^([a-z]+)\(([^()]*)\)$/.exec(value)
  if (!fn) return null
  const parsed = components(fn[2])
  if (!parsed) return null
  const [p0, p1, p2] = parsed.parts
  switch (fn[1]) {
    case 'rgb':
    case 'rgba':
      return hexFrom(amount(p0, 255), amount(p1, 255), amount(p2, 255), parsed.alpha)
    case 'hsl':
    case 'hsla':
      return fromHsl(hue(p0), percent(p1), percent(p2), parsed.alpha)
    case 'oklch': {
      const angle = (hue(p2) * Math.PI) / 180
      const chroma = amount(p1, 0.4)
      return fromOklab(amount(p0, 1), chroma * Math.cos(angle), chroma * Math.sin(angle), parsed.alpha)
    }
    case 'oklab':
      return fromOklab(amount(p0, 1), amount(p1, 0.4), amount(p2, 0.4), parsed.alpha)
    default:
      return null
  }
}

/** '#rrggbb' without an alpha byte; null for anything that is not a color toHex understands. */
export function opaque(hex) {
  const full = typeof hex === 'string' ? toHex(hex) : null
  return full ? full.slice(0, 7) : null
}

function channels(hex) {
  const value = opaque(hex)
  if (!value) return null
  return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16))
}

/** WCAG relative luminance of a color (0–1); null when it is not a color. */
export function luminance(hex) {
  const rgb = channels(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colors (1–21), alpha ignored; null when either is not a color. */
export function contrastRatio(hexA, hexB) {
  const a = luminance(hexA)
  const b = luminance(hexB)
  if (a === null || b === null) return null
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

/** The color `t` (0–1) of the way from `hexA` to `hexB`, as an opaque hex. */
export function mix(hexA, hexB, t) {
  const a = channels(hexA)
  const b = channels(hexB)
  if (!a || !b) return null
  const amount = clamp(t, 0, 1)
  return hexFrom(...a.map((channel, index) => channel + (b[index] - channel) * amount))
}

/** White or black, whichever reads better on `bg`. */
export function readableOn(bg) {
  return contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg) ? '#ffffff' : '#000000'
}
