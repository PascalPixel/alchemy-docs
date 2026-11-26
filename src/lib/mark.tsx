import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

// Alchemy's mark, read from the site's icon (public/icon.svg) so there is one
// logo file. It is white on the site's orange or on a picture, and orange
// where the ground is white or unknown, as in a browser's tab. It is never in
// a box, but for a phone's home screen, which wants a filled square.
const icon = readFileSync(join(process.cwd(), 'public/icon.svg'), 'utf8');
const path = icon.match(/ d="([^"]+)"/)![1];

// The site's own colours (src/app/global.css, light theme).
export const ORANGE = 'hsl(26, 100%, 57%)';
export const PANEL = 'hsl(30, 48%, 93%)';
export const INK = 'hsl(20, 30%, 8%)';
export const MUTED = 'hsl(22, 16%, 40%)';

// The mark alone, cropped to its outline.
export function Mark({ size, color = 'white' }: { size: number; color?: string }) {
  return (
    <svg width={(size * 19.8) / 26.35} height={size} viewBox="6.11 1.96 19.8 26.35">
      <path d={path} fill={color} fillRule="evenodd" stroke={color} strokeWidth={0.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The home-screen icon: the white mark on the orange, square, which the phone
// rounds or masks itself. The mark stays inside the middle that a round mask keeps.
export function homeIcon(side: number) {
  return new ImageResponse(
    (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: ORANGE }}>
        <Mark size={Math.round(side * 0.62)} />
      </div>
    ),
    { width: side, height: side },
  );
}
