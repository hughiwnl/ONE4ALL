import path from 'node:path';

/**
 * Upload validation rules. Video only in V1.
 *
 * Both the declared MIME type and the file extension must be on the allow list
 * and agree with each other; the first bytes of the file are also sniffed so a
 * renamed executable cannot be stored as "video/mp4".
 */

export const ALLOWED_VIDEO_TYPES: Record<string, string[]> = {
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov'],
  'video/x-m4v': ['m4v'],
  'video/webm': ['webm'],
  'video/x-matroska': ['mkv'],
  'video/x-msvideo': ['avi'],
  'video/avi': ['avi'],
  'video/mpeg': ['mpeg', 'mpg'],
  'video/3gpp': ['3gp'],
};

export const ALLOWED_EXTENSIONS = new Set(Object.values(ALLOWED_VIDEO_TYPES).flat());

export interface UploadValidationInput {
  filename: string;
  mimeType: string;
  /** Declared size (Content-Length), when known. */
  declaredSizeBytes?: number | null;
  maxSizeBytes: number;
}

export type UploadValidationResult =
  | { ok: true; mimeType: string; extension: string; safeFilename: string }
  | {
      ok: false;
      code: 'invalid_type' | 'invalid_extension' | 'too_large' | 'invalid_filename';
      message: string;
    };

export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  const safeFilename = sanitizeFilename(input.filename);
  if (!safeFilename) {
    return { ok: false, code: 'invalid_filename', message: 'Filename is empty or invalid' };
  }

  const mimeType = input.mimeType.split(';')[0]!.trim().toLowerCase();
  const allowedExtensions = ALLOWED_VIDEO_TYPES[mimeType];
  if (!allowedExtensions) {
    return {
      ok: false,
      code: 'invalid_type',
      message: `Unsupported media type "${mimeType}". Supported: ${Object.keys(ALLOWED_VIDEO_TYPES).join(', ')}`,
    };
  }

  const extension = path.extname(safeFilename).slice(1).toLowerCase();
  if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      code: 'invalid_extension',
      message: `Unsupported file extension ".${extension}". Supported: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    };
  }
  if (!allowedExtensions.includes(extension)) {
    return {
      ok: false,
      code: 'invalid_extension',
      message: `File extension ".${extension}" does not match media type "${mimeType}"`,
    };
  }

  if (input.declaredSizeBytes != null && input.declaredSizeBytes > input.maxSizeBytes) {
    return {
      ok: false,
      code: 'too_large',
      message: `File is ${formatBytes(input.declaredSizeBytes)}; the maximum upload size is ${formatBytes(input.maxSizeBytes)}`,
    };
  }
  if (input.declaredSizeBytes != null && input.declaredSizeBytes <= 0) {
    return { ok: false, code: 'invalid_filename', message: 'File is empty' };
  }

  return { ok: true, mimeType, extension, safeFilename };
}

/** Strip directories, control characters and overly long names. Never trust client filenames. */
export function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  if (cleaned.length <= 200) return cleaned;
  const ext = path.extname(cleaned);
  return cleaned.slice(0, 200 - ext.length) + ext;
}

/**
 * Check the leading bytes of a file against the declared container format.
 * Returns null when the bytes are consistent, otherwise a human-readable reason.
 */
export function sniffVideoHeader(header: Buffer, mimeType: string): string | null {
  if (header.length < 12) return 'File is too small to be a video';
  const isIsoBmff = header.subarray(4, 8).toString('latin1') === 'ftyp';
  const isEbml =
    header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
  const isRiffAvi =
    header.subarray(0, 4).toString('latin1') === 'RIFF' &&
    header.subarray(8, 12).toString('latin1') === 'AVI ';
  const isMpegPs =
    header[0] === 0x00 &&
    header[1] === 0x00 &&
    header[2] === 0x01 &&
    (header[3] === 0xba || header[3] === 0xb3);

  switch (mimeType) {
    case 'video/mp4':
    case 'video/quicktime':
    case 'video/x-m4v':
    case 'video/3gpp':
      return isIsoBmff ? null : `File content does not look like ${mimeType} (missing ftyp box)`;
    case 'video/webm':
    case 'video/x-matroska':
      return isEbml ? null : `File content does not look like ${mimeType} (missing EBML header)`;
    case 'video/x-msvideo':
    case 'video/avi':
      return isRiffAvi ? null : 'File content does not look like an AVI file';
    case 'video/mpeg':
      return isMpegPs ? null : 'File content does not look like an MPEG file';
    default:
      return `Unsupported media type ${mimeType}`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
