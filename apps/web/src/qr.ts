// SPDX-License-Identifier: AGPL-3.0-only
import qrcode from "qrcode-generator";

/**
 * Renders an otpauth URI as an inline SVG QR code. Server-side and dependency
 * free at the edge: the authenticator scans it, no long secret typing needed.
 */
export function totpQrSvg(uri: string): string {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}
